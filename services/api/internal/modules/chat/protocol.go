// Defines the WebSocket commands and events shared by the browser and Go API.
package chat

import "encoding/json"

type CommandType string

const (
	CommandChatStart  CommandType = "chat.start"
	CommandChatSubmit CommandType = "chat.submit"
	CommandRunCancel  CommandType = "run.cancel"
	CommandPing       CommandType = "ping"
)

type EventType string

const (
	EventConnectionReady  EventType = "connection.ready"
	EventCommandAccepted  EventType = "command.accepted"
	EventCommandRejected  EventType = "command.rejected"
	EventRunCreated       EventType = "run.created"
	EventRunStatus        EventType = "run.status"
	EventStepStarted      EventType = "step.started"
	EventStepProgress     EventType = "step.progress"
	EventStepCompleted    EventType = "step.completed"
	EventStepFailed       EventType = "step.failed"
	EventMessageStarted   EventType = "message.started"
	EventMessageDelta     EventType = "message.delta"
	EventMessageCompleted EventType = "message.completed"
	EventPong             EventType = "pong"
	EventError            EventType = "error"
)

type RunStatus string

const (
	RunStatusCreated   RunStatus = "created"
	RunStatusRunning   RunStatus = "running"
	RunStatusStreaming RunStatus = "streaming"
	RunStatusCompleted RunStatus = "completed"
	RunStatusFailed    RunStatus = "failed"
	RunStatusCancelled RunStatus = "cancelled"
)

type ClientEnvelope struct {
	Type           CommandType     `json:"type"`
	RequestID      string          `json:"request_id"`
	IdempotencyKey *string         `json:"idempotency_key"`
	ChatID         *string         `json:"chat_id"`
	RunID          *string         `json:"run_id"`
	Timestamp      int64           `json:"timestamp"`
	Payload        json.RawMessage `json:"payload"`
}

type ServerEnvelope struct {
	EventID   string    `json:"event_id"`
	Type      EventType `json:"type"`
	RequestID *string   `json:"request_id"`
	ChatID    *string   `json:"chat_id"`
	RunID     *string   `json:"run_id"`
	MessageID *string   `json:"message_id"`
	StepID    *string   `json:"step_id"`
	Seq       *int64    `json:"seq"`
	Cursor    *string   `json:"cursor"`
	Timestamp int64     `json:"timestamp"`
	Payload   any       `json:"payload"`
}

type TextContent struct {
	Type    string     `json:"type"`
	Format  TextFormat `json:"format"`
	Content string     `json:"content"`
}

type ChatStartPayload struct {
	MessageID string      `json:"message_id"`
	ModelID   *string     `json:"model_id"`
	Title     *string     `json:"title"`
	Content   TextContent `json:"content"`
}

type ChatSubmitPayload struct {
	MessageID string      `json:"message_id"`
	ModelID   *string     `json:"model_id"`
	Content   TextContent `json:"content"`
}

type RunCancelPayload struct {
	Reason string `json:"reason"`
}

type PingPayload struct {
	ClientTime int64 `json:"client_time"`
}

type ConnectionReadyPayload struct {
	ConnectionID      string `json:"connection_id"`
	HeartbeatInterval int64  `json:"heartbeat_interval_ms"`
	ResumeSupported   bool   `json:"resume_supported"`
}

type CommandAcceptedPayload struct {
	CommandType CommandType `json:"command_type"`
}

type CommandError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type CommandRejectedPayload struct {
	CommandType CommandType  `json:"command_type"`
	Error       CommandError `json:"error"`
}

type WireChatMessage struct {
	MessageID   string        `json:"message_id"`
	ChatID      string        `json:"chat_id"`
	RunID       *string       `json:"run_id"`
	Role        MessageRole   `json:"role"`
	Status      MessageStatus `json:"status"`
	Content     TextContent   `json:"content"`
	CreatedAt   int64         `json:"created_at"`
	UpdatedAt   int64         `json:"updated_at"`
	CompletedAt *int64        `json:"completed_at"`
	Error       *CommandError `json:"error"`
}

type WireAgentRun struct {
	RunID           string        `json:"run_id"`
	ChatID          string        `json:"chat_id"`
	ModelID         string        `json:"model_id"`
	InputMessageID  string        `json:"input_message_id"`
	OutputMessageID string        `json:"output_message_id"`
	Status          RunStatus     `json:"status"`
	StepIDs         []string      `json:"step_ids"`
	LastSeq         int64         `json:"last_seq"`
	Desynced        bool          `json:"desynced"`
	CreatedAt       int64         `json:"created_at"`
	StartedAt       *int64        `json:"started_at"`
	UpdatedAt       int64         `json:"updated_at"`
	CompletedAt     *int64        `json:"completed_at"`
	Error           *CommandError `json:"error"`
}

type WireAgentStepBase struct {
	StepID       string        `json:"step_id"`
	ChatID       string        `json:"chat_id"`
	RunID        string        `json:"run_id"`
	Kind         string        `json:"kind"`
	Title        string        `json:"title"`
	Status       string        `json:"status"`
	Sequence     int64         `json:"sequence"`
	ParentStepID *string       `json:"parent_step_id"`
	StartedAt    *int64        `json:"started_at"`
	CompletedAt  *int64        `json:"completed_at"`
	Error        *CommandError `json:"error"`
}

type WireReasoningStep struct {
	WireAgentStepBase
	Summary *string `json:"summary"`
}

type WireToolReference struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type WireToolStep struct {
	WireAgentStepBase
	CallID string            `json:"call_id"`
	Tool   WireToolReference `json:"tool"`
	Input  any               `json:"input"`
	Output any               `json:"output"`
}

type WireSkillReference struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type WireSkillStep struct {
	WireAgentStepBase
	CallID string             `json:"call_id"`
	Skill  WireSkillReference `json:"skill"`
	Input  any                `json:"input"`
	Output any                `json:"output"`
}

type WireRetrievalStep struct {
	WireAgentStepBase
	RetrievalID string  `json:"retrieval_id"`
	Query       *string `json:"query"`
	Documents   []any   `json:"documents"`
}

type RunSnapshotPayload struct {
	Run WireAgentRun `json:"run"`
}

type StepSnapshotPayload struct {
	Step any `json:"step"`
}

type MessageSnapshotPayload struct {
	Message WireChatMessage `json:"message"`
}

type MessageDeltaPayload struct {
	Delta string `json:"delta"`
}

type PongPayload struct {
	ClientTime int64 `json:"client_time"`
	ServerTime int64 `json:"server_time"`
}

type ErrorPayload struct {
	Error CommandError `json:"error"`
}
