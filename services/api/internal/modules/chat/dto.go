// 负责定义 Chat REST 接口的请求、响应和页面恢复快照结构。
package chat

import "time"

type CreateChatRequest struct {
	Title string `json:"title"`
}

type ChatResponse struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type MessageResponse struct {
	ID          string        `json:"id"`
	ChatID      string        `json:"chat_id"`
	RunID       *string       `json:"run_id"`
	Role        MessageRole   `json:"role"`
	Status      MessageStatus `json:"status"`
	Content     string        `json:"content"`
	CreatedAt   time.Time     `json:"created_at"`
	UpdatedAt   time.Time     `json:"updated_at"`
	CompletedAt *time.Time    `json:"completed_at"`
}

type RunErrorResponse struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type RunResponse struct {
	ID              string            `json:"id"`
	ChatID          string            `json:"chat_id"`
	InputMessageID  string            `json:"input_message_id"`
	OutputMessageID string            `json:"output_message_id"`
	Status          RunStatus         `json:"status"`
	LastSeq         int64             `json:"last_seq"`
	Error           *RunErrorResponse `json:"error"`
	CreatedAt       time.Time         `json:"created_at"`
	StartedAt       *time.Time        `json:"started_at"`
	UpdatedAt       time.Time         `json:"updated_at"`
	CompletedAt     *time.Time        `json:"completed_at"`
}

// SnapshotResponse 是页面刷新后恢复 Chat 的权威快照。
type SnapshotResponse struct {
	Chat     ChatResponse      `json:"chat"`
	Messages []MessageResponse `json:"messages"`
	Runs     []RunResponse     `json:"runs"`
}
