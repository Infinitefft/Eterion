package chat

import (
	"io"
	"log/slog"
	"testing"
)

func TestHubPublishesOnlyToTargetUser(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(logger)
	first := testConnection("first", "user-1", logger)
	second := testConnection("second", "user-1", logger)
	other := testConnection("other", "user-2", logger)
	hub.Register(first)
	hub.Register(second)
	hub.Register(other)

	event := ServerEnvelope{EventID: "event-1", Type: EventRunStatus, Payload: struct{}{}}
	if delivered := hub.PublishToUser("user-1", event); delivered != 2 {
		t.Fatalf("delivered=%d want=2", delivered)
	}
	if len(first.send) != 1 || len(second.send) != 1 || len(other.send) != 0 {
		t.Fatalf(
			"unexpected queues: first=%d second=%d other=%d",
			len(first.send), len(second.send), len(other.send),
		)
	}
	if hub.ConnectionCount("user-1") != 2 || hub.ConnectionCount("user-2") != 1 {
		t.Fatalf("unexpected connection counts")
	}
}

func testConnection(id string, userID string, logger *slog.Logger) *Connection {
	return &Connection{
		id: id, userID: userID,
		send: make(chan ServerEnvelope, 4), done: make(chan struct{}), logger: logger,
	}
}
