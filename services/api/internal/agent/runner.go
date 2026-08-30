// Package agent defines the application-owned boundary between the Go API and
// the independent Node.js Agent service.
package agent

import "context"

// Message is one persisted conversation message sent to the Agent.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Input contains the complete conversation required to execute one run.
type Input struct {
	RunID    string
	ThreadID string
	ModelID  string
	Messages []Message
}

// ModelInfo is the public, credential-free model catalog entry.
type ModelInfo struct {
	ID           string `json:"id"`
	ModelName    string `json:"modelName"`
	Provider     string `json:"provider"`
	ProviderName string `json:"providerName"`
	IconURL      string `json:"icon_url"`
}

// ModelCatalog resolves stable model IDs accepted from the browser.
type ModelCatalog interface {
	DefaultModelID() string
	ResolveModelID(modelID string) (string, bool)
	Models() []ModelInfo
}

// EventType mirrors agent/src/runtime/events.ts exactly.
type EventType string

const (
	EventRunStarted        EventType = "run.started"
	EventRunCompleted      EventType = "run.completed"
	EventRunFailed         EventType = "run.failed"
	EventThinkingDelta     EventType = "thinking.delta"
	EventThinkingCompleted EventType = "thinking.completed"
	EventContentStarted    EventType = "content.started"
	EventContentDelta      EventType = "content.delta"
	EventContentCompleted  EventType = "content.completed"
	EventToolStarted       EventType = "tool.started"
	EventToolCompleted     EventType = "tool.completed"
	EventToolFailed        EventType = "tool.failed"
)

// ToolEvent is the provider-independent representation of one tool call.
type ToolEvent struct {
	CallID      string
	Name        string
	DisplayName *string
	Args        any
	Summary     *string
	Result      any
	Error       *Failure
}

// Event is the normalized Agent event consumed by the chat RunManager.
type Event struct {
	Type    EventType
	RunID   string
	ModelID string
	Format  string
	Delta   string
	Content string
	Status  string
	Tool    *ToolEvent
	Error   *Failure
}

// Failure is safe to expose after Cause is removed at the IM boundary.
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

func (e *Failure) Unwrap() error { return e.Cause }

// Runner executes an Agent run and emits ordered normalized events.
type Runner interface {
	Run(ctx context.Context, input Input, handle func(Event) error) error
	Close() error
}
