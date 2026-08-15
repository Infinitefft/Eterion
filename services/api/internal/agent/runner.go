// Package agent defines the application-owned contract for AI Agent execution.
package agent

import "context"

// Message is a text message passed to an Agent run.
type Message struct {
	Role    string
	Content string
}

// Input contains the persisted conversation needed to execute a run.
type Input struct {
	RunID    string
	ChatID   string
	Messages []Message
}

// EventType identifies an event produced during Agent execution.
type EventType string

const (
	EventStarted   EventType = "started"
	EventDelta     EventType = "content_delta"
	EventCompleted EventType = "completed"
)

// Event is the provider-independent stream consumed by the chat module.
type Event struct {
	Type     EventType
	Model    string
	Delta    string
	FullText string
}

// Failure is a structured Agent failure safe to expose through the IM protocol.
// Cause is retained for server-side diagnostics and is never sent to the client.
type Failure struct {
	Code      string
	Message   string
	Retryable bool
	Cause     error
}

func (e *Failure) Error() string {
	if e.Cause != nil {
		return e.Code + ": " + e.Message + ": " + e.Cause.Error()
	}
	return e.Code + ": " + e.Message
}

// Unwrap exposes the underlying provider error to errors.Is and errors.As.
func (e *Failure) Unwrap() error {
	return e.Cause
}

// Runner executes an Agent run and emits ordered, provider-independent events.
type Runner interface {
	Run(ctx context.Context, input Input, handle func(Event) error) error
	Close() error
}
