// 负责定义 Chat、消息和 Agent Run 在数据库中的持久化模型。
package chat

import (
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

const (
	MessageStatusPending   MessageStatus = "pending"
	MessageStatusStreaming MessageStatus = "streaming"
	MessageStatusCompleted MessageStatus = "completed"
	MessageStatusFailed    MessageStatus = "failed"
	MessageStatusCancelled MessageStatus = "cancelled"
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
	LastSeq         int64
	ErrorCode       *string
	ErrorMessage    *string
	ErrorRetryable  bool
	CreatedAt       time.Time
	StartedAt       *time.Time
	UpdatedAt       time.Time
	CompletedAt     *time.Time
}

func (Run) TableName() string {
	return "runs"
}
