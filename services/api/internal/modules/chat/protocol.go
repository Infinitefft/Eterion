// 负责定义浏览器与 Go 服务之间的 WebSocket 指令、事件和载荷结构。
package chat

import "encoding/json"

// CommandType 限制客户端可以发送的指令名称。
// 自定义 string 类型可以避免在业务代码中到处直接比较裸字符串。
type CommandType string

const (
	CommandChatSubmit CommandType = "chat.submit"
	CommandRunCancel  CommandType = "run.cancel"
	CommandPing       CommandType = "ping"
)

// EventType 限制服务端可以推送的事件名称。
type EventType string

const (
	EventConnectionReady  EventType = "connection.ready"
	EventCommandAccepted  EventType = "command.accepted"
	EventCommandRejected  EventType = "command.rejected"
	EventRunCreated       EventType = "run.created"
	EventRunStatus        EventType = "run.status"
	EventMessageStarted   EventType = "message.started"
	EventMessageDelta     EventType = "message.delta"
	EventMessageCompleted EventType = "message.completed"
	EventPong             EventType = "pong"
	EventError            EventType = "error"
)

// RunStatus 表示一次 AI 执行当前所处的阶段。
type RunStatus string

const (
	RunStatusCreated   RunStatus = "created"
	RunStatusRunning   RunStatus = "running"
	RunStatusStreaming RunStatus = "streaming"
	RunStatusCompleted RunStatus = "completed"
	RunStatusFailed    RunStatus = "failed"
	RunStatusCancelled RunStatus = "cancelled"
)

// ClientEnvelope 是每一个客户端 WebSocket 文本帧的外层结构。
//
// Payload 暂时使用 json.RawMessage 保存原始 JSON。
// Command Router 确认 Type 后，再把它解析成对应的具体 Payload，
// 这样不会把所有指令的字段混在一个巨大结构体中。
// json:"..." 是 struct tag，告诉 Go 在 JSON 转换时使用什么字段名
type ClientEnvelope struct {
	Type           CommandType     `json:"type"`
	RequestID      string          `json:"request_id"`
	IdempotencyKey *string         `json:"idempotency_key"`
	ChatID         *string         `json:"chat_id"`
	RunID          *string         `json:"run_id"`
	Timestamp      int64           `json:"timestamp"`
	Payload        json.RawMessage `json:"payload"`
}

// ServerEnvelope 是服务端推送给浏览器的统一事件结构。
//
// 指针字段允许 JSON 明确输出 null。例如连接级事件没有 ChatID，
// Run 之外的事件也没有 Seq。
// any 表示 Payload 可以接收任意具体载荷结构，序列化时仍会得到普通 JSON。
type ServerEnvelope struct {
	EventID   string    `json:"event_id"`
	Type      EventType `json:"type"`
	RequestID *string   `json:"request_id"`
	ChatID    *string   `json:"chat_id"`
	RunID     *string   `json:"run_id"`
	MessageID *string   `json:"message_id"`
	Seq       *int64    `json:"seq"`
	Cursor    *string   `json:"cursor"`
	Timestamp int64     `json:"timestamp"`
	Payload   any       `json:"payload"`
}

// TextContent 是 chat.submit 当前支持的纯文本内容。
type TextContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// ChatSubmitPayload 是 chat.submit 指令的载荷。
type ChatSubmitPayload struct {
	Content TextContent `json:"content"`
}

// RunCancelPayload 是 run.cancel 指令的载荷。
type RunCancelPayload struct {
	Reason string `json:"reason"`
}

// PingPayload 保存浏览器发出 ping 时的本地时间。
type PingPayload struct {
	ClientTime int64 `json:"client_time"`
}

// ConnectionReadyPayload 告诉浏览器当前连接已经可以接收指令。
type ConnectionReadyPayload struct {
	ConnectionID      string   `json:"connection_id"`
	HeartbeatInterval int64    `json:"heartbeat_interval_ms"`
	Capabilities      []string `json:"capabilities"`
}

// CommandAcceptedPayload 表示 chat.submit 已经成功创建并持久化业务数据。
type CommandAcceptedPayload struct {
	Command            CommandType `json:"command"`
	UserMessageID      string      `json:"user_message_id"`
	AssistantMessageID string      `json:"assistant_message_id"`
	RunID              string      `json:"run_id"`
	Duplicate          bool        `json:"duplicate"`
}

// CommandError 是客户端可以根据 Code 判断的结构化错误。
type CommandError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// CommandRejectedPayload 表示某条客户端指令没有被服务端接受。
type CommandRejectedPayload struct {
	Command CommandType  `json:"command"`
	Error   CommandError `json:"error"`
}

// RunCreatedPayload 表示 Run 已创建但尚未开始调用 Agent。
type RunCreatedPayload struct {
	Status RunStatus `json:"status"`
}

// RunStatusPayload 描述 Run 的一次状态变化。
type RunStatusPayload struct {
	PreviousStatus RunStatus     `json:"previous_status"`
	CurrentStatus  RunStatus     `json:"current_status"`
	Reason         *string       `json:"reason"`
	Error          *CommandError `json:"error"`
}

// TextBlockRef 只描述文本块身份，不包含完整文本。
type TextBlockRef struct {
	BlockID   string `json:"block_id"`
	BlockType string `json:"block_type"`
}

// MessageStartedPayload 表示服务端开始生成 assistant 消息。
type MessageStartedPayload struct {
	Role  string       `json:"role"`
	Block TextBlockRef `json:"block"`
}

// MessageDeltaPayload 是可以直接追加到现有文本末尾的增量。
type MessageDeltaPayload struct {
	BlockID   string `json:"block_id"`
	BlockType string `json:"block_type"`
	Delta     string `json:"delta"`
}

// TextBlock 是消息完成后返回的权威文本快照。
type TextBlock struct {
	BlockID   string `json:"block_id"`
	BlockType string `json:"block_type"`
	Text      string `json:"text"`
}

// MessageCompletedPayload 携带消息的完整 Block 列表。
type MessageCompletedPayload struct {
	Blocks []TextBlock `json:"blocks"`
}

// PongPayload 回传客户端时间，并附上服务端生成事件的时间。
type PongPayload struct {
	ClientTime int64 `json:"client_time"`
	ServerTime int64 `json:"server_time"`
}

// ErrorPayload 用于无法关联到某条具体指令的连接级错误。
type ErrorPayload struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}
