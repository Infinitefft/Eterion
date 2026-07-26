// 负责验证 RunManager 的流式完成顺序和显式取消终态。
package chat

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

type fakeRunRepository struct {
	mu       sync.Mutex
	run      Run
	messages []Message
	output   string
	terminal chan struct{}
	endOnce  sync.Once
}

func newFakeRunRepository() *fakeRunRepository {
	runID := uuid.New()
	chatID := uuid.New()
	userID := uuid.New()
	outputMessageID := uuid.New()

	return &fakeRunRepository{
		run: Run{
			ID:              runID,
			ChatID:          chatID,
			UserID:          userID,
			InputMessageID:  uuid.New(),
			OutputMessageID: outputMessageID,
			Status:          RunStatusCreated,
		},
		messages: []Message{{
			ID:      uuid.New(),
			ChatID:  chatID,
			Role:    MessageRoleUser,
			Status:  MessageStatusCompleted,
			Content: "你好",
		}},
		terminal: make(chan struct{}),
	}
}

func (r *fakeRunRepository) LoadRunExecution(
	ctx context.Context,
	runID uuid.UUID,
) (*RunExecution, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if runID != r.run.ID {
		return nil, ErrRepositoryRunNotFound
	}
	messages := append([]Message(nil), r.messages...)
	return &RunExecution{
		Run:      r.run,
		Messages: messages,
	}, nil
}

func (r *fakeRunRepository) NextSeq(
	ctx context.Context,
	runID uuid.UUID,
	allowed []RunStatus,
	now time.Time,
) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !containsRunStatus(allowed, r.run.Status) {
		return 0, ErrRepositoryInvalidRunState
	}
	r.run.LastSeq++
	return r.run.LastSeq, nil
}

func (r *fakeRunRepository) TransitionRun(
	ctx context.Context,
	runID uuid.UUID,
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
	return previous, r.run.LastSeq, nil
}

func (r *fakeRunRepository) AppendDelta(
	ctx context.Context,
	runID uuid.UUID,
	messageID uuid.UUID,
	delta string,
	now time.Time,
) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if isTerminalRunStatus(r.run.Status) {
		return 0, ErrRepositoryInvalidRunState
	}
	r.output += delta
	r.run.LastSeq++
	return r.run.LastSeq, nil
}

func (r *fakeRunRepository) CompleteRun(
	ctx context.Context,
	runID uuid.UUID,
	messageID uuid.UUID,
	fullText string,
	now time.Time,
) (int64, int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if isTerminalRunStatus(r.run.Status) {
		return 0, 0, ErrRepositoryInvalidRunState
	}

	messageSeq := r.run.LastSeq + 1
	statusSeq := r.run.LastSeq + 2
	r.output = fullText
	r.run.LastSeq = statusSeq
	r.run.Status = RunStatusCompleted
	r.endOnce.Do(func() {
		close(r.terminal)
	})
	return messageSeq, statusSeq, nil
}

func (r *fakeRunRepository) EndRun(
	ctx context.Context,
	runID uuid.UUID,
	messageID uuid.UUID,
	status RunStatus,
	code string,
	message string,
	now time.Time,
) (RunStatus, int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if isTerminalRunStatus(r.run.Status) {
		return "", 0, ErrRepositoryInvalidRunState
	}

	previous := r.run.Status
	r.run.Status = status
	r.run.LastSeq++
	r.endOnce.Do(func() {
		close(r.terminal)
	})
	return previous, r.run.LastSeq, nil
}

type streamingFakeRunner struct{}

func (streamingFakeRunner) Run(
	ctx context.Context,
	input AgentInput,
	handle func(AgentEvent) error,
) error {
	events := []AgentEvent{
		{Type: AgentEventStarted, Model: "fake-model"},
		{Type: AgentEventDelta, Delta: "你"},
		{Type: AgentEventDelta, Delta: "好"},
		{Type: AgentEventCompleted, FullText: "你好"},
	}

	for _, event := range events {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := handle(event); err != nil {
			return err
		}
	}
	return nil
}

func (streamingFakeRunner) Close() error {
	return nil
}

type blockingFakeRunner struct {
	started chan struct{}
}

func (r *blockingFakeRunner) Run(
	ctx context.Context,
	input AgentInput,
	handle func(AgentEvent) error,
) error {
	close(r.started)
	<-ctx.Done()
	return ctx.Err()
}

func (r *blockingFakeRunner) Close() error {
	return nil
}

func TestRunManagerCompletesStreamingRun(t *testing.T) {
	repository := newFakeRunRepository()
	manager := newTestRunManager(repository, streamingFakeRunner{})

	if !manager.Start(repository.run) {
		t.Fatal("new run should start")
	}
	waitForTerminal(t, repository.terminal)
	if err := manager.Close(); err != nil {
		t.Fatalf("close manager: %v", err)
	}

	repository.mu.Lock()
	defer repository.mu.Unlock()
	if repository.run.Status != RunStatusCompleted {
		t.Fatalf("unexpected status: %s", repository.run.Status)
	}
	if repository.output != "你好" {
		t.Fatalf("unexpected output: %q", repository.output)
	}
	if repository.run.LastSeq != 8 {
		t.Fatalf("unexpected last seq: %d", repository.run.LastSeq)
	}
}

func TestRunManagerCancelsOnlyByExplicitRequest(t *testing.T) {
	repository := newFakeRunRepository()
	runner := &blockingFakeRunner{
		started: make(chan struct{}),
	}
	manager := newTestRunManager(repository, runner)

	if !manager.Start(repository.run) {
		t.Fatal("new run should start")
	}
	waitForTerminal(t, runner.started)

	repository.mu.Lock()
	run := repository.run
	repository.mu.Unlock()
	duplicate, err := manager.Cancel(context.Background(), &run)
	if err != nil {
		t.Fatalf("cancel run: %v", err)
	}
	if duplicate {
		t.Fatal("first cancellation should not be duplicate")
	}
	waitForTerminal(t, repository.terminal)
	if err := manager.Close(); err != nil {
		t.Fatalf("close manager: %v", err)
	}

	repository.mu.Lock()
	defer repository.mu.Unlock()
	if repository.run.Status != RunStatusCancelled {
		t.Fatalf("unexpected status: %s", repository.run.Status)
	}
}

func newTestRunManager(
	repository RunRepository,
	runner Runner,
) *RunManager {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(logger)
	return NewRunManager(
		context.Background(),
		repository,
		runner,
		NewPublisher(hub),
		logger,
	)
}

func waitForTerminal(
	t *testing.T,
	signal <-chan struct{},
) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(2 * time.Second):
		t.Fatal(errors.New("timed out waiting for run"))
	}
}
