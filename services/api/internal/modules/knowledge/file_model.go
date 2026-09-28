package knowledge

import (
	"github.com/google/uuid"
	"time"
)

type KnowledgeFile struct {
	ID              uuid.UUID `gorm:"type:uuid;primaryKey" json:"id"`
	KnowledgeBaseID uuid.UUID `gorm:"type:uuid" json:"knowledge_base_id"`
	OriginalName    string    `json:"original_name"`
	ObjectKey       string    `json:"object_key"`
	MimeType        string    `json:"mime_type"`
	SizeBytes       int64     `json:"size_bytes"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}
