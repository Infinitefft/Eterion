// 负责定义 Chat、消息和 Agent Run 在数据库中的持久化模型。
package chat

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type MessageRole string

const (
	MessageRoleUser      MessageRole = "user"
	MessageRoleAssistant MessageRole = "assistant"
	MessageRoleSystem    MessageRole = "system"
)

type MessageStatus string

type TextFormat string

// RunStatus is intentionally limited to the lifecycle rendered by the web IM
// service. Tool and content streaming are activities while the run is running.
type RunStatus string

const (
	RunStatusPending     RunStatus = "pending"
	RunStatusRunning     RunStatus = "running"
	RunStatusWaitingUser RunStatus = "waiting_user"
	RunStatusCompleted   RunStatus = "completed"
	RunStatusFailed      RunStatus = "failed"
	RunStatusCancelled   RunStatus = "cancelled"

	// Temporary source aliases keep repository changes reviewable while all old
	// call sites are migrated to the frontend lifecycle.
	RunStatusCreated   = RunStatusPending
	RunStatusStreaming = RunStatusRunning
)

const (
	MessageStatusPending   MessageStatus = "pending"
	MessageStatusStreaming MessageStatus = "streaming"
	MessageStatusCompleted MessageStatus = "completed"
	MessageStatusFailed    MessageStatus = "failed"
	MessageStatusCancelled MessageStatus = "cancelled"
)

const (
	BlockKindThinking    = "thinking"
	BlockKindTool        = "tool"
	BlockKindInteraction = "hitl"
)

const (
	TextFormatPlainText TextFormat = "plain_text"
	TextFormatMarkdown  TextFormat = "markdown"
)

// Chat 属于一个用户，是消息和 Run 的顶层容器。
type Chat struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey"`
	UserID    uuid.UUID `gorm:"type:uuid;index"`
	Title     string
	LastSeq   int64
	CreatedAt time.Time
	UpdatedAt time.Time
}

func (Chat) TableName() string {
	return "chats"
}

// Message 第一阶段直接保存文本快照。
// RunID 为空表示这条消息不是由某次 Agent Run 产生。
type Message struct {
	ID            uuid.UUID  `gorm:"type:uuid;primaryKey"`
	ChatID        uuid.UUID  `gorm:"type:uuid;index"`
	RunID         *uuid.UUID `gorm:"type:uuid;index"`
	Role          MessageRole
	Status        MessageStatus
	Content       string
	ContentFormat TextFormat `gorm:"column:content_format"`
	CreatedAt     time.Time
	UpdatedAt     time.Time
	CompletedAt   *time.Time
}

func (Message) TableName() string {
	return "messages"
}

// Run 描述一次从用户消息到 assistant 消息的完整 Agent 执行。
type Run struct {
	ID              uuid.UUID `gorm:"type:uuid;primaryKey"`
	ChatID          uuid.UUID `gorm:"type:uuid;index"`
	UserID          uuid.UUID `gorm:"type:uuid;index"`
	ModelID         string    `gorm:"column:model_id"`
	InputMessageID  uuid.UUID `gorm:"type:uuid"`
	OutputMessageID uuid.UUID `gorm:"type:uuid"`
	Status          RunStatus
	IdempotencyKey  string
	// LastSeq is retained for databases created by older migrations. New IM
	// ordering is owned by Chat.LastSeq and never reads this field.
	LastSeq        int64
	ErrorCode      *string
	ErrorMessage   *string
	ErrorRetryable bool
	CreatedAt      time.Time
	StartedAt      *time.Time
	UpdatedAt      time.Time
	CompletedAt    *time.Time

	// StepIDs is transient live-run state; tool steps are not persisted yet.
	StepIDs []string `gorm:"-"`
}

func (Run) TableName() string {
	return "runs"
}

// AgentBlock persists the latest snapshot of a Thinking, Tool, or HITL block.
// Data is application JSON decoded according to Kind when building a snapshot.
type AgentBlock struct {
	ID        string    `gorm:"primaryKey;size:128"`
	ChatID    uuid.UUID `gorm:"type:uuid;index"`
	RunID     uuid.UUID `gorm:"type:uuid;primaryKey;index"`
	Kind      string    `gorm:"size:16"`
	Status    string    `gorm:"size:16"`
	Sequence  int64
	Data      json.RawMessage `gorm:"type:jsonb"`
	CreatedAt time.Time
	UpdatedAt time.Time
}

func (AgentBlock) TableName() string { return "agent_blocks" }
