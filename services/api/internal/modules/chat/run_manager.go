// 负责让 Agent Run 脱离 WebSocket 生命周期执行，并统一处理状态、取消和流式事件。
package chat

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

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
	runner     Runner
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
	runner Runner,
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

// Close 等待所有后台 Run 结束，并关闭 gRPC 连接。
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

	input := AgentInput{
		RunID:  run.ID.String(),
		ChatID: run.ChatID.String(),
		Messages: make(
			[]AgentMessage,
			0,
			len(execution.Messages),
		),
	}
	for _, message := range execution.Messages {
		input.Messages = append(input.Messages, AgentMessage{
			Role:    string(message.Role),
			Content: message.Content,
		})
	}

	started := false
	streaming := false
	completed := false
	fullText := ""

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

	err = m.runner.Run(ctx, input, func(event AgentEvent) error {
		switch event.Type {
		case AgentEventStarted:
			return ensureStarted()
		case AgentEventDelta:
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
		case AgentEventCompleted:
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
		var agentFailure *AgentFailure
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
