package knowledge

import (
	"time"

	"github.com/google/uuid"
)

type KnowledgeBase struct {
	ID          uuid.UUID `gorm:"type:uuid;primaryKey"`
	UserID      uuid.UUID `gorm:"type:uuid"`
	Title       string
	Description string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}
