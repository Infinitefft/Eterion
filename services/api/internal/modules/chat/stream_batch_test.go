package chat

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
)

func TestBatchPreservesBoundariesAndText(t *testing.T) {
	input := []agent.Event{
		{Type: agent.EventThinkingDelta, Delta: "中"},
		{Type: agent.EventThinkingDelta, Delta: "😀"},
		{Type: agent.EventThinkingCompleted, Content: "中😀"},
		{Type: agent.EventContentDelta, Delta: "答"},
		{Type: agent.EventContentDelta, Delta: "复"},
		{Type: agent.EventToolStarted},
		{Type: agent.EventRunPaused},
		{Type: agent.EventRunResumed},
		{Type: agent.EventThinkingDelta, Delta: "新思考"},
		{Type: agent.EventContentDelta, Delta: "新正文"},
		{Type: agent.EventRunCompleted},
	}
	var got []agent.Event
	err := consumeBatchedStream(context.Background(), func(ctx context.Context, emit func(agent.Event) error) error {
		for _, event := range input {
			if err := emit(event); err != nil {
				return err
			}
		}
		return nil
	}, func(ctx context.Context, event agent.Event) error { got = append(got, event); return nil })
	want := append([]agent.Event{{Type: agent.EventThinkingDelta, Delta: "中😀"}, input[2], {Type: agent.EventContentDelta, Delta: "答复"}}, input[5:]...)
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("events = %+v, err = %v", got, err)
	}
}

func TestBatchFlushesWhileProducerIsIdle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	flushed := make(chan struct{})
	err := consumeBatchedStream(ctx, func(ctx context.Context, emit func(agent.Event) error) error {
		if err := emit(agent.Event{Type: agent.EventThinkingDelta, Delta: "partial"}); err != nil {
			return err
		}
		select {
		case <-flushed:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}, func(ctx context.Context, event agent.Event) error {
		if event.Delta != "partial" {
			t.Errorf("delta = %q", event.Delta)
		}
		close(flushed)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestBatchCoalescesBurstWithoutLosingContent(t *testing.T) {
	var text strings.Builder
	calls := 0
	err := consumeBatchedStream(context.Background(), func(ctx context.Context, emit func(agent.Event) error) error {
		for range 1000 {
			if err := emit(agent.Event{Type: agent.EventThinkingDelta, Delta: "字"}); err != nil {
				return err
			}
		}
		return nil
	}, func(ctx context.Context, event agent.Event) error {
		calls++
		text.WriteString(event.Delta)
		return nil
	})
	if err != nil || text.String() != strings.Repeat("字", 1000) || calls >= 1000 {
		t.Fatalf("calls = %d, bytes = %d, err = %v", calls, text.Len(), err)
	}
	t.Logf("1000 incoming deltas -> %d persistence callbacks", calls)
}

func TestBatchFlushesSizeAndDisconnect(t *testing.T) {
	disconnected := errors.New("disconnected")
	var sizes []int
	err := consumeBatchedStream(context.Background(), func(ctx context.Context, emit func(agent.Event) error) error {
		for _, text := range []string{strings.Repeat("a", 4096), "tail"} {
			if err := emit(agent.Event{Type: agent.EventContentDelta, Delta: text}); err != nil {
				return err
			}
		}
		return disconnected
	}, func(ctx context.Context, event agent.Event) error {
		sizes = append(sizes, len(event.Delta))
		return nil
	})
	if !errors.Is(err, disconnected) || !reflect.DeepEqual(sizes, []int{4096, 4}) {
		t.Fatalf("sizes = %v, err = %v", sizes, err)
	}
}

func TestBatchStopsProducerOnPersistenceFailure(t *testing.T) {
	failed := errors.New("write failed")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := consumeBatchedStream(ctx, func(ctx context.Context, emit func(agent.Event) error) error {
		for {
			if err := emit(agent.Event{Type: agent.EventThinkingDelta, Delta: "text"}); err != nil {
				return err
			}
		}
	}, func(context.Context, agent.Event) error { return failed })
	if !errors.Is(err, failed) {
		t.Fatal(err)
	}
}

func TestBatchCancellationRetainsPendingText(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var text string
	err := consumeBatchedStream(ctx, func(ctx context.Context, emit func(agent.Event) error) error {
		if err := emit(agent.Event{Type: agent.EventThinkingDelta, Delta: "saved"}); err != nil {
			return err
		}
		// 超过有界队列容量，确保首个文本已经进入消费端缓冲；空 delta 不触发刷出。
		for range 33 {
			if err := emit(agent.Event{Type: agent.EventThinkingDelta}); err != nil {
				return err
			}
		}
		cancel()
		return ctx.Err()
	}, func(ctx context.Context, event agent.Event) error {
		if event.Type == agent.EventThinkingDelta {
			text += event.Delta
		}
		return ctx.Err()
	})
	if !errors.Is(err, context.Canceled) || text != "saved" {
		t.Fatalf("text = %q, err = %v", text, err)
	}
}
