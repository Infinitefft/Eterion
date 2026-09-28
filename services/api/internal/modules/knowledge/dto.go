package knowledge

import "time"

type CreateRequest struct {
	Title       string `json:"title"`
	Description string `json:"description"`
}

type KnowledgeBaseResponse struct {
	FileCount   int64     `json:"file_count"`
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}
