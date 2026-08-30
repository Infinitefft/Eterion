// Defines the camelCase WebSocket contract owned by apps/web/src/service/im/protocol.ts.
package chat

import "encoding/json"

type CommandType string

const (
	CommandThreadStart        CommandType = "thread.start"
	CommandMessageSend        CommandType = "message.send"
	CommandRunCancel          CommandType = "run.cancel"
	CommandInteractionRespond CommandType = "interaction.respond"
)

type EventType string

const (
	EventThreadUpdated        EventType = "thread.updated"
	EventRunStatus            EventType = "run.status"
	EventThinkingDelta        EventType = "thinking.delta"
	EventThinkingCompleted    EventType = "thinking.completed"
	EventMessageStarted       EventType = "message.started"
	EventMessageDelta         EventType = "message.delta"
	EventMessageCompleted     EventType = "message.completed"
	EventToolStarted          EventType = "tool.started"
	EventToolCompleted        EventType = "tool.completed"
	EventToolFailed           EventType = "tool.failed"
	EventInteractionRequested EventType = "interaction.requested"
	EventInteractionResolved  EventType = "interaction.resolved"
)

type ClientCommand struct {
	Type          CommandType     `json:"type"`
	RequestID     string          `json:"requestId"`
	ThreadID      string          `json:"threadId"`
	MessageID     string          `json:"messageId,omitempty"`
	RunID         string          `json:"runId,omitempty"`
	InteractionID string          `json:"interactionId,omitempty"`
	Payload       json.RawMessage `json:"payload,omitempty"`
}

type MessageCommandPayload struct {
	Content string  `json:"content"`
	ModelID *string `json:"modelId,omitempty"`
}

type HITLAnswer struct {
	QuestionID string `json:"questionId"`
	Value      any    `json:"value"`
}

type InteractionRespondPayload struct {
	Answers []HITLAnswer `json:"answers"`
}

type ProtocolError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type AckFrame struct {
	Type            string         `json:"type"`
	OK              bool           `json:"ok"`
	RequestID       string         `json:"requestId"`
	Timestamp       int64          `json:"timestamp"`
	CommandType     CommandType    `json:"commandType"`
	ThreadID        string         `json:"threadId,omitempty"`
	InputMessageID  string         `json:"inputMessageId,omitempty"`
	OutputMessageID string         `json:"outputMessageId,omitempty"`
	RunID           string         `json:"runId,omitempty"`
	InteractionID   string         `json:"interactionId,omitempty"`
	Error           *ProtocolError `json:"error,omitempty"`
}

type ThreadEvent struct {
	Type          EventType `json:"type"`
	ThreadID      string    `json:"threadId"`
	SeqID         int64     `json:"seqId"`
	Timestamp     int64     `json:"timestamp"`
	RunID         string    `json:"runId,omitempty"`
	MessageID     string    `json:"messageId,omitempty"`
	ThinkingID    string    `json:"thinkingId,omitempty"`
	ToolCallID    string    `json:"toolCallId,omitempty"`
	InteractionID string    `json:"interactionId,omitempty"`
	Payload       any       `json:"payload"`
}

type ThreadUpdatedPayload struct {
	Title     string `json:"title"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

type RunStatusPayload struct {
	Status          RunStatus      `json:"status"`
	ModelID         string         `json:"modelId"`
	InputMessageID  string         `json:"inputMessageId"`
	OutputMessageID string         `json:"outputMessageId"`
	CreatedAt       int64          `json:"createdAt"`
	StartedAt       *int64         `json:"startedAt"`
	CompletedAt     *int64         `json:"completedAt"`
	Error           *ProtocolError `json:"error"`
}

type ThinkingDeltaPayload struct {
	Delta string `json:"delta"`
}

type ThinkingCompletedPayload struct {
	Content string `json:"content"`
}

type MessageStartedPayload struct {
	Role      MessageRole `json:"role"`
	Format    TextFormat  `json:"format"`
	CreatedAt int64       `json:"createdAt"`
}

type MessageDeltaPayload struct {
	Delta string `json:"delta"`
}

type MessageCompletedPayload struct {
	Role        MessageRole    `json:"role"`
	Content     string         `json:"content"`
	Format      TextFormat     `json:"format"`
	Status      MessageStatus  `json:"status"`
	CreatedAt   int64          `json:"createdAt"`
	CompletedAt int64          `json:"completedAt"`
	Error       *ProtocolError `json:"error"`
}

type ToolStartedPayload struct {
	Name        string  `json:"name"`
	DisplayName *string `json:"displayName"`
	Args        any     `json:"args"`
}

type ToolCompletedPayload struct {
	Summary *string `json:"summary"`
	Result  any     `json:"result"`
}

type ToolFailedPayload struct {
	Error ProtocolError `json:"error"`
}

type HITLQuestion struct {
	QuestionID string   `json:"questionId"`
	Prompt     string   `json:"prompt"`
	Options    []string `json:"options,omitempty"`
	Multiple   bool     `json:"multiple,omitempty"`
	Required   bool     `json:"required,omitempty"`
}

type InteractionRequestedPayload struct {
	Questions []HITLQuestion `json:"questions"`
}

type InteractionResolvedPayload struct {
	Answers []HITLAnswer `json:"answers"`
}
