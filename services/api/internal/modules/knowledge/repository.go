package knowledge

import (
	"context"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// Repository 隔离知识库的数据访问。
type Repository interface {
	Create(ctx context.Context, base *KnowledgeBase) error
	ListByUser(ctx context.Context, userID uuid.UUID) ([]KnowledgeBase, error)
}

type GormRepository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) *GormRepository {
	return &GormRepository{db: db}
}

func (r *GormRepository) Create(ctx context.Context, base *KnowledgeBase) error {
	return r.db.WithContext(ctx).Create(base).Error
}

func (r *GormRepository) ListByUser(ctx context.Context, userID uuid.UUID) ([]KnowledgeBase, error) {
	var bases []KnowledgeBase
	err := r.db.WithContext(ctx).Select("knowledge_bases.*, (SELECT COUNT(*) FROM knowledge_files WHERE knowledge_base_id = knowledge_bases.id) AS file_count").Where("user_id = ?", userID).
		Order("created_at DESC").Order("id DESC").Find(&bases).Error
	return bases, err
}
