// Defines REST DTOs and the camelCase ThreadSnapshot consumed by the web store.
package chat

import "time"

type CreateChatRequest struct {
	Title string `json:"title"`
}

type UpdateChatRequest struct {
	Title string `json:"title"`
}

// Thread list endpoints intentionally keep their existing snake_case dates;
// apps/web/src/api/im.ts maps them to Unix milliseconds.
type ChatResponse struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type SnapshotThread struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

type SnapshotMessage struct {
	ID          string         `json:"id"`
	ThreadID    string         `json:"threadId"`
	RunID       *string        `json:"runId"`
	Role        MessageRole    `json:"role"`
	Format      TextFormat     `json:"format"`
	Content     string         `json:"content"`
	Status      MessageStatus  `json:"status"`
	CreatedAt   int64          `json:"createdAt"`
	CompletedAt *int64         `json:"completedAt"`
	Error       *ProtocolError `json:"error"`
}

type SnapshotRun struct {
	ID              string         `json:"id"`
	ThreadID        string         `json:"threadId"`
	ModelID         string         `json:"modelId"`
	InputMessageID  string         `json:"inputMessageId"`
	OutputMessageID string         `json:"outputMessageId"`
	Status          RunStatus      `json:"status"`
	CreatedAt       int64          `json:"createdAt"`
	StartedAt       *int64         `json:"startedAt"`
	CompletedAt     *int64         `json:"completedAt"`
	Error           *ProtocolError `json:"error"`
}

type SnapshotThinkingBlock struct {
	Kind     string `json:"kind"`
	ID       string `json:"id"`
	ThreadID string `json:"threadId"`
	RunID    string `json:"runId"`
	Status   string `json:"status"`
	Content  string `json:"content"`
}

type SnapshotToolBlock struct {
	Kind        string         `json:"kind"`
	ID          string         `json:"id"`
	ThreadID    string         `json:"threadId"`
	RunID       string         `json:"runId"`
	Status      string         `json:"status"`
	Name        string         `json:"name"`
	DisplayName *string        `json:"displayName"`
	Args        any            `json:"args"`
	Summary     *string        `json:"summary"`
	Result      any            `json:"result"`
	Error       *ProtocolError `json:"error"`
}

type SnapshotInteractionBlock struct {
	Kind      string         `json:"kind"`
	ID        string         `json:"id"`
	ThreadID  string         `json:"threadId"`
	RunID     string         `json:"runId"`
	Status    string         `json:"status"`
	Questions []HITLQuestion `json:"questions"`
	Answers   []HITLAnswer   `json:"answers"`
}

type SnapshotResponse struct {
	Thread    SnapshotThread    `json:"thread"`
	Messages  []SnapshotMessage `json:"messages"`
	Runs      []SnapshotRun     `json:"runs"`
	Blocks    []any             `json:"blocks"`
	LastSeqID int64             `json:"lastSeqId"`
}

type thinkingBlockData struct {
	Content string `json:"content"`
}

type toolBlockData struct {
	Name        string         `json:"name"`
	DisplayName *string        `json:"displayName"`
	Args        any            `json:"args"`
	Summary     *string        `json:"summary"`
	Result      any            `json:"result"`
	Error       *ProtocolError `json:"error"`
}

type interactionBlockData struct {
	Questions []HITLQuestion `json:"questions"`
	Answers   []HITLAnswer   `json:"answers"`
}
