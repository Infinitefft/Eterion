// 负责让 Agent Run 脱离 WebSocket 生命周期执行，并统一处理状态、取消和流式事件。
package chat

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
	"github.com/google/uuid"
)

var errUserRequestedCancel = errors.New("user requested run cancellation")

type activeRun struct {
	cancel context.CancelCauseFunc
}

// RunRepository 是 RunManager 实际需要的最小持久化能力集合。
type RunRepository interface {
	LoadRunExecution(ctx context.Context, runID uuid.UUID) (*RunExecution, error)
	NextSeq(
		ctx context.Context,
		runID uuid.UUID,
		allowed []RunStatus,
		now time.Time,
	) (int64, error)
	TransitionRun(
		ctx context.Context,
		runID uuid.UUID,
		allowed []RunStatus,
		next RunStatus,
		now time.Time,
	) (RunStatus, int64, error)
	StartMessage(
		ctx context.Context,
		runID uuid.UUID,
		messageID uuid.UUID,
		now time.Time,
	) (int64, error)
	AppendDelta(
		ctx context.Context,
		runID uuid.UUID,
		messageID uuid.UUID,
		delta string,
		now time.Time,
	) (int64, error)
	CompleteRun(
		ctx context.Context,
		runID uuid.UUID,
		messageID uuid.UUID,
		fullText string,
		now time.Time,
	) (int64, int64, error)
	EndRun(
		ctx context.Context,
		runID uuid.UUID,
		messageID uuid.UUID,
		status RunStatus,
		code string,
		message string,
		retryable bool,
		now time.Time,
	) (RunStatus, int64, int64, error)
}

type RunManager struct {
	appContext context.Context
	repository RunRepository
	runner     agent.Runner
	publisher  *Publisher
	logger     *slog.Logger
	now        func() time.Time

	mu     sync.Mutex
	active map[uuid.UUID]activeRun
	runs   sync.WaitGroup
}

func NewRunManager(
	appContext context.Context,
	repository RunRepository,
	runner agent.Runner,
	publisher *Publisher,
	logger *slog.Logger,
) *RunManager {
	if logger == nil {
		logger = slog.Default()
	}

	return &RunManager{
		appContext: appContext,
		repository: repository,
		runner:     runner,
		publisher:  publisher,
		logger:     logger,
		now: func() time.Time {
			return time.Now().UTC()
		},
		active: make(map[uuid.UUID]activeRun),
	}
}

// Start 先同步注册 Run，再启动 goroutine，避免紧随其后的取消请求找不到它。
func (m *RunManager) Start(run Run) bool {
	m.mu.Lock()
	if _, exists := m.active[run.ID]; exists {
		m.mu.Unlock()
		return false
	}

	runContext, cancel := context.WithCancelCause(m.appContext)
	m.active[run.ID] = activeRun{cancel: cancel}
	m.runs.Add(1)
	m.mu.Unlock()

	go func() {
		defer m.runs.Done()
		defer m.remove(run.ID)
		m.execute(runContext, run)
	}()
	return true
}

// Cancel 只发送显式取消信号，最终数据库状态由执行 goroutine 统一落库。
func (m *RunManager) Cancel(
	ctx context.Context,
	run *Run,
) (bool, error) {
	if isTerminalRunStatus(run.Status) {
		return true, nil
	}

	m.mu.Lock()
	current, exists := m.active[run.ID]
	m.mu.Unlock()

	if exists {
		current.cancel(errUserRequestedCancel)
		return false, nil
	}

	// Run 尚未注册或进程重启后不在内存时，直接完成幂等取消。
	endContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	execution, err := m.repository.LoadRunExecution(endContext, run.ID)
	if err != nil {
		return false, err
	}
	now := m.now()
	_, messageSeq, statusSeq, err := m.repository.EndRun(
		endContext,
		run.ID,
		run.OutputMessageID,
		RunStatusCancelled,
		"",
		"user_requested",
		false,
		now,
	)
	if errors.Is(err, ErrRepositoryInvalidRunState) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	applyTerminalState(
		run,
		&execution.OutputMessage,
		RunStatusCancelled,
		"",
		"user_requested",
		false,
		statusSeq,
		now,
	)
	m.publisher.MessageSnapshot(
		*run,
		execution.OutputMessage,
		messageSeq,
		EventMessageCompleted,
		nil,
	)
	m.publisher.RunSnapshot(*run, EventRunStatus)
	return false, nil
}

// Close 等待所有后台 Run 结束，并关闭 Agent Runner。
func (m *RunManager) Close() error {
	m.cancelAll()
	m.runs.Wait()
	return m.runner.Close()
}

func (m *RunManager) execute(
	ctx context.Context,
	initialRun Run,
) {
	execution, err := m.repository.LoadRunExecution(
		ctx,
		initialRun.ID,
	)
	if err != nil {
		m.finishWithError(ctx, &initialRun, nil, err)
		return
	}
	run := &execution.Run
	outputMessage := &execution.OutputMessage

	now := m.now()
	seq, err := m.repository.NextSeq(
		ctx,
		run.ID,
		[]RunStatus{RunStatusCreated},
		now,
	)
	if err != nil {
		m.finishWithError(ctx, run, outputMessage, err)
		return
	}
	run.LastSeq = seq
	run.UpdatedAt = now
	m.publisher.RunSnapshot(*run, EventRunCreated)

	if ctx.Err() != nil {
		m.finishWithError(ctx, run, outputMessage, ctx.Err())
		return
	}

	now = m.now()
	previous, seq, err := m.repository.TransitionRun(
		ctx,
		run.ID,
		[]RunStatus{RunStatusCreated},
		RunStatusRunning,
		now,
	)
	if err != nil {
		m.finishWithError(ctx, run, outputMessage, err)
		return
	}
	_ = previous
	run.Status = RunStatusRunning
	run.LastSeq = seq
	run.UpdatedAt = now
	run.StartedAt = timePointer(now)
	m.publisher.RunSnapshot(*run, EventRunStatus)

	input := agent.Input{
		RunID:   run.ID.String(),
		ChatID:  run.ChatID.String(),
		ModelID: run.ModelID,
		Messages: make(
			[]agent.Message,
			0,
			len(execution.Messages),
		),
	}
	for _, message := range execution.Messages {
		input.Messages = append(input.Messages, agent.Message{
			Role:    string(message.Role),
			Content: message.Content,
		})
	}

	started := false
	streaming := false
	completed := false
	fullText := ""

	// toolSteps keeps the frontend step created for each Agent tool-call ID.
	toolSteps := make(map[string]WireToolStep)

	// toolSequence gives tool cards a stable order inside this run.
	var toolSequence int64

	ensureStarted := func() error {
		if started {
			return nil
		}
		startedAt := m.now()
		startedSeq, err := m.repository.StartMessage(
			ctx,
			run.ID,
			run.OutputMessageID,
			startedAt,
		)
		if err != nil {
			return err
		}
		started = true
		outputMessage.Status = MessageStatusStreaming
		outputMessage.UpdatedAt = startedAt
		run.LastSeq = startedSeq
		run.UpdatedAt = startedAt
		m.publisher.MessageSnapshot(
			*run,
			*outputMessage,
			startedSeq,
			EventMessageStarted,
			nil,
		)
		return nil
	}

	err = m.runner.Run(ctx, input, func(event agent.Event) error {
		switch event.Type {
		case agent.EventStarted:
			return ensureStarted()
		case agent.EventToolStarted:
			// The Agent contract requires tool details for every tool event.
			if event.Tool == nil || event.Tool.CallID == "" {
				return errors.New("agent returned an invalid tool-started event")
			}

			// Ensure the assistant message exists before its first tool step.
			if err := ensureStarted(); err != nil {
				return err
			}

			// Reserve the next run sequence number for step.started.
			stepAt := m.now()
			stepSeq, err := m.repository.NextSeq(
				ctx,
				run.ID,
				[]RunStatus{RunStatusRunning, RunStatusStreaming},
				stepAt,
			)
			if err != nil {
				return err
			}

			// Increase the display order once for this new tool call.
			toolSequence++

			// Generate an application step ID; CallID remains the model-provider ID.
			stepID := uuid.NewString()

			// Convert the start time to the millisecond wire format.
			startedAt := stepAt.UnixMilli()

			// Build the exact WireToolStep shape already understood by the frontend.
			step := WireToolStep{
				WireAgentStepBase: WireAgentStepBase{
					StepID:      stepID,
					ChatID:      run.ChatID.String(),
					RunID:       run.ID.String(),
					Kind:        "tool",
					Title:       "调用工具 · " + event.Tool.Name,
					Status:      "running",
					Sequence:    toolSequence,
					StartedAt:   &startedAt,
					CompletedAt: nil,
					Error:       nil,
				},
				CallID: event.Tool.CallID,
				Tool: WireToolReference{
					ID:   event.Tool.ID,
					Name: event.Tool.Name,
				},
				Input:  event.Tool.Input,
				Output: nil,
			}

			// Save the step so its completion updates the same card.
			toolSteps[event.Tool.CallID] = step

			// Include the step in all later live run snapshots.
			run.StepIDs = append(run.StepIDs, stepID)

			// Keep the in-memory run sequence synchronized with the database.
			run.LastSeq = stepSeq
			run.UpdatedAt = stepAt

			// Push step.started over the existing WebSocket publisher.
			m.publisher.StepSnapshot(
				*run,
				EventStepStarted,
				stepSeq,
				stepID,
				step,
			)

			return nil
		case agent.EventToolCompleted:
			// The completed event must point to the tool call started above.
			if event.Tool == nil {
				return errors.New("agent returned an invalid tool-completed event")
			}

			// Load the existing frontend card instead of creating a duplicate.
			step, exists := toolSteps[event.Tool.CallID]
			if !exists {
				return errors.New("agent completed an unknown tool call")
			}

			// Reserve the next run sequence number for step.completed.
			stepAt := m.now()
			stepSeq, err := m.repository.NextSeq(
				ctx,
				run.ID,
				[]RunStatus{RunStatusRunning, RunStatusStreaming},
				stepAt,
			)
			if err != nil {
				return err
			}

			// Update the step with the structured tool output.
			step.Status = "completed"
			step.Output = event.Tool.Output
			completedAt := stepAt.UnixMilli()
			step.CompletedAt = &completedAt
			toolSteps[event.Tool.CallID] = step

			// Keep the in-memory run sequence synchronized with the database.
			run.LastSeq = stepSeq
			run.UpdatedAt = stepAt

			// Push step.completed so the running card becomes completed.
			m.publisher.StepSnapshot(
				*run,
				EventStepCompleted,
				stepSeq,
				step.StepID,
				step,
			)

			return nil
		case agent.EventToolFailed:
			// The failed event must point to the tool call started above.
			if event.Tool == nil || event.Tool.Error == nil {
				return errors.New("agent returned an invalid tool-failed event")
			}

			// Load the same running frontend card.
			step, exists := toolSteps[event.Tool.CallID]
			if !exists {
				return errors.New("agent failed an unknown tool call")
			}

			// Reserve the next run sequence number for step.failed.
			stepAt := m.now()
			stepSeq, err := m.repository.NextSeq(
				ctx,
				run.ID,
				[]RunStatus{RunStatusRunning, RunStatusStreaming},
				stepAt,
			)
			if err != nil {
				return err
			}

			// Copy only safe error fields; the internal Cause never reaches browsers.
			step.Status = "failed"
			step.Error = &CommandError{
				Code:      event.Tool.Error.Code,
				Message:   event.Tool.Error.Message,
				Retryable: event.Tool.Error.Retryable,
			}
			completedAt := stepAt.UnixMilli()
			step.CompletedAt = &completedAt
			toolSteps[event.Tool.CallID] = step

			// Keep the in-memory run sequence synchronized with the database.
			run.LastSeq = stepSeq
			run.UpdatedAt = stepAt

			// Push step.failed before the run itself transitions to failed.
			m.publisher.StepSnapshot(
				*run,
				EventStepFailed,
				stepSeq,
				step.StepID,
				step,
			)

			return nil
		case agent.EventDelta:
			if err := ensureStarted(); err != nil {
				return err
			}
			if !streaming {
				streamingAt := m.now()
				previousStatus, streamingSeq, err := m.repository.TransitionRun(
					ctx,
					run.ID,
					[]RunStatus{RunStatusRunning},
					RunStatusStreaming,
					streamingAt,
				)
				if err != nil {
					return err
				}
				_ = previousStatus
				run.Status = RunStatusStreaming
				run.LastSeq = streamingSeq
				run.UpdatedAt = streamingAt
				streaming = true
				m.publisher.RunSnapshot(*run, EventRunStatus)
			}

			deltaAt := m.now()
			deltaSeq, err := m.repository.AppendDelta(
				ctx,
				run.ID,
				run.OutputMessageID,
				event.Delta,
				deltaAt,
			)
			if err != nil {
				return err
			}
			fullText += event.Delta
			outputMessage.Content += event.Delta
			outputMessage.Status = MessageStatusStreaming
			outputMessage.UpdatedAt = deltaAt
			run.LastSeq = deltaSeq
			run.UpdatedAt = deltaAt
			m.publisher.MessageDelta(*run, deltaSeq, event.Delta)
			return nil
		case agent.EventCompleted:
			if err := ensureStarted(); err != nil {
				return err
			}
			completed = true
			fullText = event.FullText
			return nil
		default:
			return errors.New("unsupported internal agent event")
		}
	})
	if err != nil {
		m.finishWithError(ctx, run, outputMessage, err)
		return
	}
	if !completed {
		m.finishWithError(
			ctx,
			run,
			outputMessage,
			errors.New("agent did not return completed event"),
		)
		return
	}

	completedAt := m.now()
	messageSeq, statusSeq, err := m.repository.CompleteRun(
		ctx,
		run.ID,
		run.OutputMessageID,
		fullText,
		completedAt,
	)
	if err != nil {
		m.finishWithError(ctx, run, outputMessage, err)
		return
	}

	outputMessage.Content = fullText
	outputMessage.Status = MessageStatusCompleted
	outputMessage.UpdatedAt = completedAt
	outputMessage.CompletedAt = timePointer(completedAt)
	run.Status = RunStatusCompleted
	run.LastSeq = statusSeq
	run.UpdatedAt = completedAt
	run.CompletedAt = timePointer(completedAt)
	run.ErrorCode = nil
	run.ErrorMessage = nil
	run.ErrorRetryable = false
	m.publisher.MessageSnapshot(
		*run,
		*outputMessage,
		messageSeq,
		EventMessageCompleted,
		nil,
	)
	m.publisher.RunSnapshot(*run, EventRunStatus)
}

func (m *RunManager) finishWithError(
	ctx context.Context,
	run *Run,
	outputMessage *Message,
	runError error,
) {
	status := RunStatusFailed
	code := "AGENT_ERROR"
	message := "AI 服务执行失败"
	retryable := true
	var eventError *CommandError

	if errors.Is(context.Cause(ctx), errUserRequestedCancel) {
		status = RunStatusCancelled
		code = ""
		message = "user_requested"
		retryable = false
	} else if ctx.Err() != nil {
		code = "RUN_INTERRUPTED"
		message = "服务停止导致 Run 中断"
		eventError = &CommandError{
			Code: code, Message: message, Retryable: true,
		}
	} else {
		var agentFailure *agent.Failure
		if errors.As(runError, &agentFailure) {
			code = agentFailure.Code
			message = agentFailure.Message
			retryable = agentFailure.Retryable
			eventError = &CommandError{
				Code:      agentFailure.Code,
				Message:   agentFailure.Message,
				Retryable: agentFailure.Retryable,
			}
		} else {
			eventError = &CommandError{
				Code:      code,
				Message:   message,
				Retryable: true,
			}
		}
	}

	// 数据库清理使用独立短 Context，避免原 Run Context 取消后无法保存终态。
	endContext, cancel := context.WithTimeout(
		context.Background(),
		5*time.Second,
	)
	defer cancel()

	endedAt := m.now()
	_, messageSeq, statusSeq, err := m.repository.EndRun(
		endContext,
		run.ID,
		run.OutputMessageID,
		status,
		code,
		message,
		retryable,
		endedAt,
	)
	if errors.Is(err, ErrRepositoryInvalidRunState) {
		return
	}
	if err != nil {
		m.logger.Error(
			"persist run terminal state failed",
			"run_id", run.ID,
			"error", err,
		)
		return
	}

	applyTerminalState(
		run,
		outputMessage,
		status,
		code,
		message,
		retryable,
		statusSeq,
		endedAt,
	)
	if outputMessage != nil {
		m.publisher.MessageSnapshot(
			*run,
			*outputMessage,
			messageSeq,
			EventMessageCompleted,
			eventError,
		)
	}
	m.publisher.RunSnapshot(*run, EventRunStatus)
	if status == RunStatusFailed {
		m.logger.Error(
			"agent run failed",
			"run_id", run.ID,
			"error", runError,
		)
	}
}

func applyTerminalState(
	run *Run,
	message *Message,
	status RunStatus,
	code string,
	errorMessage string,
	retryable bool,
	statusSeq int64,
	endedAt time.Time,
) {
	run.Status = status
	run.LastSeq = statusSeq
	run.UpdatedAt = endedAt
	run.CompletedAt = timePointer(endedAt)
	run.ErrorRetryable = retryable
	if code == "" {
		run.ErrorCode = nil
		run.ErrorMessage = nil
	} else {
		run.ErrorCode = stringPointer(code)
		run.ErrorMessage = stringPointer(errorMessage)
	}
	if message == nil {
		return
	}
	message.Status = MessageStatusFailed
	if status == RunStatusCancelled {
		message.Status = MessageStatusCancelled
	}
	message.UpdatedAt = endedAt
	message.CompletedAt = timePointer(endedAt)
}

func (m *RunManager) remove(runID uuid.UUID) {
	m.mu.Lock()
	delete(m.active, runID)
	m.mu.Unlock()
}

func (m *RunManager) cancelAll() {
	m.mu.Lock()
	active := make([]activeRun, 0, len(m.active))
	for _, run := range m.active {
		active = append(active, run)
	}
	m.mu.Unlock()

	for _, run := range active {
		run.cancel(context.Canceled)
	}
}

func isTerminalRunStatus(status RunStatus) bool {
	return status == RunStatusCompleted ||
		status == RunStatusFailed ||
		status == RunStatusCancelled
}
