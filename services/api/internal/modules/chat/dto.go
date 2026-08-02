// Defines REST request/response DTOs and the frontend-ready chat snapshot.
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

type SnapshotChat struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

type SnapshotMessage struct {
	ID          string        `json:"id"`
	ChatID      string        `json:"chatId"`
	RunID       *string       `json:"runId"`
	Role        MessageRole   `json:"role"`
	Status      MessageStatus `json:"status"`
	Content     TextContent   `json:"content"`
	CreatedAt   int64         `json:"createdAt"`
	UpdatedAt   int64         `json:"updatedAt"`
	CompletedAt *int64        `json:"completedAt"`
	Error       *CommandError `json:"error"`
}

type SnapshotRun struct {
	ID              string        `json:"id"`
	ChatID          string        `json:"chatId"`
	InputMessageID  string        `json:"inputMessageId"`
	OutputMessageID string        `json:"outputMessageId"`
	Status          RunStatus     `json:"status"`
	StepIDs         []string      `json:"stepIds"`
	LastSeq         int64         `json:"lastSeq"`
	Desynced        bool          `json:"desynced"`
	CreatedAt       int64         `json:"createdAt"`
	StartedAt       *int64        `json:"startedAt"`
	UpdatedAt       int64         `json:"updatedAt"`
	CompletedAt     *int64        `json:"completedAt"`
	Error           *CommandError `json:"error"`
}

type SnapshotResponse struct {
	Chat     SnapshotChat      `json:"chat"`
	Messages []SnapshotMessage `json:"messages"`
	Runs     []SnapshotRun     `json:"runs"`
	Steps    []any             `json:"steps"`
	Cursor   *string           `json:"cursor"`
}
