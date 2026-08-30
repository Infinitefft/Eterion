// Executes Agent runs independently from WebSocket connection lifetimes and
// maps normalized Node Agent events to the frontend IM contract.
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

type activeRun struct{ cancel context.CancelCauseFunc }

type RunRepository interface {
	LoadRunExecution(ctx context.Context, runID uuid.UUID) (*RunExecution, error)
	ReserveSubmitEvents(ctx context.Context, runID uuid.UUID) ([3]int64, error)
	TransitionRun(ctx context.Context, runID uuid.UUID, allowed []RunStatus, next RunStatus, now time.Time) (RunStatus, int64, error)
	StartMessage(ctx context.Context, runID, messageID uuid.UUID, format TextFormat, now time.Time) (int64, error)
	AppendDelta(ctx context.Context, runID, messageID uuid.UUID, delta string, now time.Time) (int64, error)
	CompleteRun(ctx context.Context, runID, messageID uuid.UUID, fullText string, format TextFormat, now time.Time) (int64, int64, error)
	EndRun(ctx context.Context, runID, messageID uuid.UUID, status RunStatus, code, message string, retryable bool, now time.Time) (RunStatus, int64, int64, error)
	SaveThinking(ctx context.Context, runID uuid.UUID, blockID, content, status string, now time.Time) (int64, error)
	SaveTool(ctx context.Context, runID uuid.UUID, blockID, status string, data toolBlockData, now time.Time) (int64, error)
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
		appContext: appContext, repository: repository, runner: runner,
		publisher: publisher, logger: logger, now: func() time.Time { return time.Now().UTC() },
		active: make(map[uuid.UUID]activeRun),
	}
}

func (m *RunManager) ReservePending(ctx context.Context, record SubmitRecord) ([3]int64, error) {
	return m.repository.ReserveSubmitEvents(ctx, record.Run.ID)
}

// PublishPending emits the three facts created by thread.start/message.send.
func (m *RunManager) PublishPending(record SubmitRecord, sequences [3]int64) {
	m.publisher.ThreadUpdated(record.Run.UserID.String(), record.Chat, sequences[0])
	m.publisher.MessageCompleted(record.Run, record.UserMessage, sequences[1], nil)
	m.publisher.RunStatus(record.Run, sequences[2])
}

// Start registers synchronously before launching the goroutine so an immediate
// run.cancel can always find the active run.
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

func (m *RunManager) Cancel(ctx context.Context, run *Run) (bool, error) {
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

	execution, err := m.repository.LoadRunExecution(ctx, run.ID)
	if err != nil {
		return false, err
	}
	if err := m.endRun(ctx, run, &execution.OutputMessage, RunStatusCancelled, nil); err != nil {
		if errors.Is(err, ErrRepositoryInvalidRunState) {
			return true, nil
		}
		return false, err
	}
	return false, nil
}

func (m *RunManager) Close() error {
	m.cancelAll()
	m.runs.Wait()
	return m.runner.Close()
}

func (m *RunManager) execute(ctx context.Context, initialRun Run) {
	execution, err := m.repository.LoadRunExecution(ctx, initialRun.ID)
	if err != nil {
		m.finishWithError(ctx, &initialRun, nil, err)
		return
	}
	run := &execution.Run
	output := &execution.OutputMessage

	input := agent.Input{
		RunID: run.ID.String(), ThreadID: run.ChatID.String(), ModelID: run.ModelID,
		Messages: make([]agent.Message, 0, len(execution.Messages)),
	}
	for _, message := range execution.Messages {
		input.Messages = append(input.Messages, agent.Message{Role: string(message.Role), Content: message.Content})
	}

	var (
		runStarted      bool
		contentStarted  bool
		contentTerminal bool
		runTerminal     bool
		fullText        string
		contentFormat   = TextFormatMarkdown
		contentStatus   = MessageStatusCompleted
		contentError    *agent.Failure
		thinkingID      string
		thinkingContent string
	)
	tools := make(map[string]toolBlockData)

	err = m.runner.Run(ctx, input, func(event agent.Event) error {
		switch event.Type {
		case agent.EventRunStarted:
			if runStarted || event.ModelID != run.ModelID {
				return errors.New("agent returned an invalid run.started event")
			}
			now := m.now()
			_, seq, err := m.repository.TransitionRun(ctx, run.ID, []RunStatus{RunStatusPending}, RunStatusRunning, now)
			if err != nil {
				return err
			}
			runStarted = true
			run.Status, run.StartedAt, run.UpdatedAt = RunStatusRunning, timePointer(now), now
			m.publisher.RunStatus(*run, seq)
			return nil

		case agent.EventContentStarted:
			if !runStarted || contentStarted || contentTerminal {
				return errors.New("agent returned content.started out of order")
			}
			format := TextFormat(event.Format)
			now := m.now()
			seq, err := m.repository.StartMessage(ctx, run.ID, run.OutputMessageID, format, now)
			if err != nil {
				return err
			}
			contentStarted, contentFormat = true, format
			output.Status, output.ContentFormat, output.UpdatedAt = MessageStatusStreaming, format, now
			m.publisher.MessageStarted(*run, *output, seq)
			return nil

		case agent.EventContentDelta:
			if !contentStarted || contentTerminal {
				return errors.New("agent returned content.delta out of order")
			}
			if event.Delta == "" {
				return nil
			}
			now := m.now()
			seq, err := m.repository.AppendDelta(ctx, run.ID, run.OutputMessageID, event.Delta, now)
			if err != nil {
				return err
			}
			fullText += event.Delta
			output.Content += event.Delta
			output.UpdatedAt = now
			m.publisher.MessageDelta(*run, seq, event.Delta)
			return nil

		case agent.EventContentCompleted:
			if !contentStarted || contentTerminal {
				return errors.New("agent returned content.completed out of order")
			}
			contentTerminal = true
			fullText, contentFormat = event.Content, TextFormat(event.Format)
			contentStatus, contentError = MessageStatus(event.Status), event.Error
			return nil

		case agent.EventThinkingDelta:
			if !runStarted || runTerminal || event.Delta == "" {
				return nil
			}
			if thinkingID == "" {
				thinkingID = uuid.NewString()
			}
			thinkingContent += event.Delta
			now := m.now()
			seq, err := m.repository.SaveThinking(ctx, run.ID, thinkingID, thinkingContent, "streaming", now)
			if err != nil {
				return err
			}
			m.publisher.ThinkingDelta(*run, thinkingID, seq, event.Delta)
			return nil

		case agent.EventThinkingCompleted:
			if !runStarted || runTerminal {
				return errors.New("agent returned thinking.completed out of order")
			}
			if thinkingID == "" {
				thinkingID = uuid.NewString()
			}
			thinkingContent = event.Content
			now := m.now()
			seq, err := m.repository.SaveThinking(ctx, run.ID, thinkingID, thinkingContent, "completed", now)
			if err != nil {
				return err
			}
			m.publisher.ThinkingCompleted(*run, thinkingID, seq, thinkingContent)
			thinkingID, thinkingContent = "", ""
			return nil

		case agent.EventToolStarted:
			if !runStarted || event.Tool == nil || event.Tool.CallID == "" {
				return errors.New("agent returned an invalid tool.started event")
			}
			if _, exists := tools[event.Tool.CallID]; exists {
				return errors.New("agent started a duplicate tool call")
			}
			data := toolBlockData{Name: event.Tool.Name, DisplayName: event.Tool.DisplayName, Args: event.Tool.Args}
			now := m.now()
			seq, err := m.repository.SaveTool(ctx, run.ID, event.Tool.CallID, "running", data, now)
			if err != nil {
				return err
			}
			tools[event.Tool.CallID] = data
			m.publisher.ToolStarted(*run, event.Tool.CallID, seq, ToolStartedPayload{
				Name: data.Name, DisplayName: data.DisplayName, Args: data.Args,
			})
			return nil

		case agent.EventToolCompleted:
			if event.Tool == nil {
				return errors.New("agent returned an invalid tool.completed event")
			}
			data, exists := tools[event.Tool.CallID]
			if !exists {
				return errors.New("agent completed an unknown tool call")
			}
			data.Summary, data.Result = event.Tool.Summary, event.Tool.Result
			now := m.now()
			seq, err := m.repository.SaveTool(ctx, run.ID, event.Tool.CallID, "completed", data, now)
			if err != nil {
				return err
			}
			tools[event.Tool.CallID] = data
			m.publisher.ToolCompleted(*run, event.Tool.CallID, seq, ToolCompletedPayload{Summary: data.Summary, Result: data.Result})
			return nil

		case agent.EventToolFailed:
			if event.Tool == nil || event.Tool.Error == nil {
				return errors.New("agent returned an invalid tool.failed event")
			}
			data, exists := tools[event.Tool.CallID]
			if !exists {
				return errors.New("agent failed an unknown tool call")
			}
			data.Error = &ProtocolError{Code: event.Tool.Error.Code, Message: event.Tool.Error.Message}
			now := m.now()
			seq, err := m.repository.SaveTool(ctx, run.ID, event.Tool.CallID, "failed", data, now)
			if err != nil {
				return err
			}
			tools[event.Tool.CallID] = data
			m.publisher.ToolFailed(*run, event.Tool.CallID, seq, *data.Error)
			return nil

		case agent.EventRunCompleted:
			if !runStarted || !contentTerminal || contentStatus != MessageStatusCompleted {
				return errors.New("agent completed the run before completed content")
			}
			now := m.now()
			messageSeq, statusSeq, err := m.repository.CompleteRun(
				ctx, run.ID, run.OutputMessageID, fullText, contentFormat, now,
			)
			if err != nil {
				return err
			}
			output.Content, output.ContentFormat, output.Status = fullText, contentFormat, MessageStatusCompleted
			output.UpdatedAt, output.CompletedAt = now, timePointer(now)
			run.Status, run.UpdatedAt, run.CompletedAt = RunStatusCompleted, now, timePointer(now)
			run.ErrorCode, run.ErrorMessage = nil, nil
			m.publisher.MessageCompleted(*run, *output, messageSeq, nil)
			m.publisher.RunStatus(*run, statusSeq)
			runTerminal = true
			return nil

		case agent.EventRunFailed:
			if event.Error == nil {
				return errors.New("agent returned run.failed without an error")
			}
			if contentError != nil && event.Error.Code == "" {
				event.Error = contentError
			}
			if err := m.endRun(ctx, run, output, RunStatusFailed, event.Error); err != nil {
				return err
			}
			runTerminal = true
			return nil

		default:
			return errors.New("unsupported internal agent event")
		}
	})
	if err != nil {
		m.finishWithError(ctx, run, output, err)
		return
	}
	if !runTerminal {
		m.finishWithError(ctx, run, output, errors.New("agent stream ended before a terminal run event"))
	}
}

func (m *RunManager) finishWithError(ctx context.Context, run *Run, output *Message, runError error) {
	status := RunStatusFailed
	var failure *agent.Failure
	cause := context.Cause(ctx)
	if errors.Is(cause, errUserRequestedCancel) || errors.Is(runError, context.Canceled) {
		status = RunStatusCancelled
	} else if !errors.As(runError, &failure) {
		failure = &agent.Failure{Code: "AGENT_RUN_FAILED", Message: "Agent 执行失败", Retryable: true, Cause: runError}
	}

	endContext := ctx
	if endContext.Err() != nil {
		var cancel context.CancelFunc
		endContext, cancel = context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
	}
	if output == nil {
		execution, err := m.repository.LoadRunExecution(endContext, run.ID)
		if err != nil {
			m.logger.Error("load failed run for finalization", "run_id", run.ID, "error", err)
			return
		}
		output = &execution.OutputMessage
	}
	if err := m.endRun(endContext, run, output, status, failure); err != nil && !errors.Is(err, ErrRepositoryInvalidRunState) {
		m.logger.Error("finalize failed agent run", "run_id", run.ID, "error", err)
	}
	m.logger.Warn("agent run ended", "run_id", run.ID, "status", status, "error", runError)
}

func (m *RunManager) endRun(
	ctx context.Context,
	run *Run,
	output *Message,
	status RunStatus,
	failure *agent.Failure,
) error {
	code, message, retryable := "", "", false
	var eventError *ProtocolError
	if failure != nil {
		code, message, retryable = failure.Code, failure.Message, failure.Retryable
		eventError = &ProtocolError{Code: code, Message: message}
	}
	now := m.now()
	_, messageSeq, statusSeq, err := m.repository.EndRun(
		ctx, run.ID, run.OutputMessageID, status, code, message, retryable, now,
	)
	if err != nil {
		return err
	}
	applyTerminalState(run, output, status, code, message, retryable, now)
	m.publisher.MessageCompleted(*run, *output, messageSeq, eventError)
	m.publisher.RunStatus(*run, statusSeq)
	return nil
}

func applyTerminalState(
	run *Run,
	message *Message,
	status RunStatus,
	code, errorMessage string,
	retryable bool,
	endedAt time.Time,
) {
	run.Status, run.UpdatedAt, run.CompletedAt = status, endedAt, timePointer(endedAt)
	run.ErrorCode, run.ErrorMessage, run.ErrorRetryable = nil, nil, false
	if code != "" {
		run.ErrorCode, run.ErrorMessage, run.ErrorRetryable = stringPointer(code), stringPointer(errorMessage), retryable
	}
	message.Status = MessageStatusFailed
	if status == RunStatusCancelled {
		message.Status = MessageStatusCancelled
	}
	message.UpdatedAt, message.CompletedAt = endedAt, timePointer(endedAt)
}

func (m *RunManager) remove(runID uuid.UUID) {
	m.mu.Lock()
	delete(m.active, runID)
	m.mu.Unlock()
}

func (m *RunManager) cancelAll() {
	m.mu.Lock()
	runs := make([]activeRun, 0, len(m.active))
	for _, run := range m.active {
		runs = append(runs, run)
	}
	m.mu.Unlock()
	for _, run := range runs {
		run.cancel(context.Canceled)
	}
}

func isTerminalRunStatus(status RunStatus) bool {
	return status == RunStatusCompleted || status == RunStatusFailed || status == RunStatusCancelled
}

func stringPointer(value string) *string { return &value }
