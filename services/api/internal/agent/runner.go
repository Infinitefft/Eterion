// Package agent defines the application-owned boundary between the Go API and
// the independent Node.js Agent service.
package agent

import (
	"context"
	"encoding/json"
)

// Message is one persisted conversation message sent to the Agent.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Input identifies one run; the Agent fetches history and builds its own context.
type Input struct {
	RunID          string
	UserID         string
	ThreadID       string
	ModelID        string
	InputMessageID string
	HistoryToken   string
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
	// AgentContext is internal persistence data, not frontend presentation data.
	AgentContext     json.RawMessage
	ContextTruncated bool
	Type             EventType
	RunID            string
	ModelID          string
	Format           string
	Delta            string
	Content          string
	Status           string
	Tool             *ToolEvent
	Error            *Failure
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

type ContextHistoryMessage struct {
	ID      string `json:"id"`
	Role    string `json:"role"`
	Status  string `json:"status"`
	Content string `json:"content"`
}

type CompactInput struct {
	ModelID      string                  `json:"model_id"`
	AgentContext json.RawMessage         `json:"agent_context"`
	History      []ContextHistoryMessage `json:"history"`
}

type CompactResult struct {
	AgentContext json.RawMessage `json:"agent_context"`
	Changed      bool            `json:"changed"`
	Truncated    bool            `json:"truncated"`
}

type ContextCompactor interface {
	Compact(context.Context, CompactInput) (*CompactResult, error)
}

type ContextUsage struct {
	AutoCompactTokenLimit int64  `json:"autoCompactTokenLimit"`
	ModelID               string `json:"modelId"`
	ContextWindow         int64  `json:"contextWindow"`
	UsedTokens            int64  `json:"usedTokens"`
	RemainingTokens       int64  `json:"remainingTokens"`
}

type ContextUsageReader interface {
	ReadContextUsage(context.Context, CompactInput) (*ContextUsage, error)
}
