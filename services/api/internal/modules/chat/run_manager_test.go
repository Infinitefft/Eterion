package chat

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
	"github.com/google/uuid"
)

type memoryRunRepository struct {
	mu      sync.Mutex
	run     Run
	output  Message
	history []Message
}

func (r *memoryRunRepository) LoadRunExecution(
	_ context.Context,
	_ uuid.UUID,
) (*RunExecution, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return &RunExecution{
		Run:           r.run,
		OutputMessage: r.output,
		Messages:      append([]Message(nil), r.history...),
	}, nil
}

func (r *memoryRunRepository) NextSeq(
	_ context.Context,
	_ uuid.UUID,
	allowed []RunStatus,
	now time.Time,
) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !containsRunStatus(allowed, r.run.Status) {
		return 0, ErrRepositoryInvalidRunState
	}
	r.run.LastSeq++
	r.run.UpdatedAt = now
	return r.run.LastSeq, nil
}

func (r *memoryRunRepository) TransitionRun(
	_ context.Context,
	_ uuid.UUID,
	allowed []RunStatus,
	next RunStatus,
	now time.Time,
) (RunStatus, int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !containsRunStatus(allowed, r.run.Status) {
		return "", 0, ErrRepositoryInvalidRunState
	}
	previous := r.run.Status
	r.run.Status = next
	r.run.LastSeq++
	r.run.UpdatedAt = now
	if next == RunStatusRunning {
		r.run.StartedAt = timePointer(now)
	}
	return previous, r.run.LastSeq, nil
}

func (r *memoryRunRepository) StartMessage(
	_ context.Context,
	_ uuid.UUID,
	_ uuid.UUID,
	now time.Time,
) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.output.Status = MessageStatusStreaming
	r.output.UpdatedAt = now
	r.run.LastSeq++
	r.run.UpdatedAt = now
	return r.run.LastSeq, nil
}

func (r *memoryRunRepository) AppendDelta(
	_ context.Context,
	_ uuid.UUID,
	_ uuid.UUID,
	delta string,
	now time.Time,
) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.output.Content += delta
	r.output.Status = MessageStatusStreaming
	r.output.UpdatedAt = now
	r.run.LastSeq++
	r.run.UpdatedAt = now
	return r.run.LastSeq, nil
}

func (r *memoryRunRepository) CompleteRun(
	_ context.Context,
	_ uuid.UUID,
	_ uuid.UUID,
	fullText string,
	now time.Time,
) (int64, int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	messageSeq := r.run.LastSeq + 1
	statusSeq := r.run.LastSeq + 2
	r.output.Content = fullText
	r.output.Status = MessageStatusCompleted
	r.output.UpdatedAt = now
	r.output.CompletedAt = timePointer(now)
	r.run.Status = RunStatusCompleted
	r.run.LastSeq = statusSeq
	r.run.UpdatedAt = now
	r.run.CompletedAt = timePointer(now)
	return messageSeq, statusSeq, nil
}

func (r *memoryRunRepository) EndRun(
	_ context.Context,
	_ uuid.UUID,
	_ uuid.UUID,
	status RunStatus,
	code string,
	message string,
	retryable bool,
	now time.Time,
) (RunStatus, int64, int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if isTerminalRunStatus(r.run.Status) {
		return "", 0, 0, ErrRepositoryInvalidRunState
	}
	previous := r.run.Status
	messageSeq := r.run.LastSeq + 1
	statusSeq := r.run.LastSeq + 2
	applyTerminalState(
		&r.run,
		&r.output,
		status,
		code,
		message,
		retryable,
		statusSeq,
		now,
	)
	return previous, messageSeq, statusSeq, nil
}

func (r *memoryRunRepository) currentRun() Run {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.run
}

type scriptedRunner struct {
	events []agent.Event
	err    error
}

func (r scriptedRunner) Run(
	_ context.Context,
	_ agent.Input,
	handle func(agent.Event) error,
) error {
	for _, event := range r.events {
		if err := handle(event); err != nil {
			return err
		}
	}
	return r.err
}

func (scriptedRunner) Close() error { return nil }

type cancellingRunner struct {
	started chan struct{}
}

func (r *cancellingRunner) Run(
	ctx context.Context,
	_ agent.Input,
	handle func(agent.Event) error,
) error {
	if err := handle(agent.Event{Type: agent.EventStarted}); err != nil {
		return err
	}
	close(r.started)
	<-ctx.Done()
	return ctx.Err()
}

func (*cancellingRunner) Close() error { return nil }

func TestRunManagerPublishesProtocolSnapshotsInSequence(t *testing.T) {
	repository := newMemoryRunRepository()
	publisher, connection := capturePublisher(repository.run.UserID.String())
	runner := scriptedRunner{events: []agent.Event{
		{Type: agent.EventStarted},
		{Type: agent.EventDelta, Delta: "ok"},
		{Type: agent.EventCompleted, FullText: "**ok**"},
	}}
	manager := NewRunManager(context.Background(), repository, runner, publisher, nil)
	manager.Start(repository.run)
	manager.runs.Wait()

	events := drainEvents(connection)
	want := []EventType{
		EventRunCreated,
		EventRunStatus,
		EventMessageStarted,
		EventRunStatus,
		EventMessageDelta,
		EventMessageCompleted,
		EventRunStatus,
	}
	assertEventSequence(t, events, want)

	completed := events[len(events)-2].Payload.(MessageSnapshotPayload).Message
	if completed.Status != MessageStatusCompleted ||
		completed.Content.Format != TextFormatMarkdown ||
		completed.Content.Content != "**ok**" {
		t.Fatalf("unexpected completed message: %#v", completed)
	}
	finalRun := events[len(events)-1].Payload.(RunSnapshotPayload).Run
	if finalRun.Status != RunStatusCompleted || finalRun.LastSeq != int64(len(events)) {
		t.Fatalf("unexpected final run: %#v", finalRun)
	}
}

func TestRunManagerPublishesFailedMessageAndRun(t *testing.T) {
	repository := newMemoryRunRepository()
	publisher, connection := capturePublisher(repository.run.UserID.String())
	runner := scriptedRunner{
		events: []agent.Event{{Type: agent.EventStarted}},
		err: &agent.Failure{
			Code: "MODEL_BUSY", Message: "模型繁忙", Retryable: true,
		},
	}
	manager := NewRunManager(context.Background(), repository, runner, publisher, nil)
	manager.Start(repository.run)
	manager.runs.Wait()

	events := drainEvents(connection)
	assertEventSequence(t, events, []EventType{
		EventRunCreated,
		EventRunStatus,
		EventMessageStarted,
		EventMessageCompleted,
		EventRunStatus,
	})
	message := events[3].Payload.(MessageSnapshotPayload).Message
	if message.Status != MessageStatusFailed || message.Error == nil || !message.Error.Retryable {
		t.Fatalf("unexpected failed message: %#v", message)
	}
	run := events[4].Payload.(RunSnapshotPayload).Run
	if run.Status != RunStatusFailed || run.Error == nil || run.Error.Code != "MODEL_BUSY" {
		t.Fatalf("unexpected failed run: %#v", run)
	}
}

func TestRunManagerPublishesCancelledMessageAndRun(t *testing.T) {
	repository := newMemoryRunRepository()
	publisher, connection := capturePublisher(repository.run.UserID.String())
	runner := &cancellingRunner{started: make(chan struct{})}
	manager := NewRunManager(context.Background(), repository, runner, publisher, nil)
	manager.Start(repository.run)
	<-runner.started
	run := repository.currentRun()
	if _, err := manager.Cancel(context.Background(), &run); err != nil {
		t.Fatalf("cancel run: %v", err)
	}
	manager.runs.Wait()

	events := drainEvents(connection)
	assertEventSequence(t, events, []EventType{
		EventRunCreated,
		EventRunStatus,
		EventMessageStarted,
		EventMessageCompleted,
		EventRunStatus,
	})
	message := events[3].Payload.(MessageSnapshotPayload).Message
	if message.Status != MessageStatusCancelled || message.Error != nil {
		t.Fatalf("unexpected cancelled message: %#v", message)
	}
	runSnapshot := events[4].Payload.(RunSnapshotPayload).Run
	if runSnapshot.Status != RunStatusCancelled || runSnapshot.Error != nil {
		t.Fatalf("unexpected cancelled run: %#v", runSnapshot)
	}
}

func newMemoryRunRepository() *memoryRunRepository {
	now := time.Date(2026, 8, 2, 12, 0, 0, 0, time.UTC)
	runID := uuid.New()
	chatID := uuid.New()
	userID := uuid.New()
	outputID := uuid.New()
	return &memoryRunRepository{
		run: Run{
			ID: runID, ChatID: chatID, UserID: userID,
			InputMessageID: uuid.New(), OutputMessageID: outputID,
			Status: RunStatusCreated, CreatedAt: now, UpdatedAt: now,
		},
		output: Message{
			ID: outputID, ChatID: chatID, RunID: &runID,
			Role: MessageRoleAssistant, Status: MessageStatusPending,
			ContentFormat: TextFormatMarkdown, CreatedAt: now, UpdatedAt: now,
		},
	}
}

func capturePublisher(userID string) (*Publisher, *Connection) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(logger)
	connection := &Connection{
		id: "capture", userID: userID,
		send: make(chan ServerEnvelope, 32), done: make(chan struct{}), logger: logger,
	}
	hub.Register(connection)
	return NewPublisher(hub), connection
}

func drainEvents(connection *Connection) []ServerEnvelope {
	events := make([]ServerEnvelope, 0, len(connection.send))
	for len(connection.send) > 0 {
		events = append(events, <-connection.send)
	}
	return events
}

func assertEventSequence(
	t *testing.T,
	events []ServerEnvelope,
	want []EventType,
) {
	t.Helper()
	if len(events) != len(want) {
		t.Fatalf("unexpected event count: got %d want %d (%#v)", len(events), len(want), events)
	}
	for index, event := range events {
		if event.Type != want[index] {
			t.Fatalf("event %d: got %s want %s", index, event.Type, want[index])
		}
		if event.Seq == nil || *event.Seq != int64(index+1) {
			t.Fatalf("event %d has seq %#v", index, event.Seq)
		}
	}
}

var _ agent.Runner = scriptedRunner{}
var _ agent.Runner = (*cancellingRunner)(nil)
var _ RunRepository = (*memoryRunRepository)(nil)
