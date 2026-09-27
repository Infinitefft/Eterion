package knowledge

import (
	"context"

	"gorm.io/gorm"
)

// Repository 隔离数据库写入，便于独立验证创建规则与失败路径。
type Repository interface {
	Create(ctx context.Context, base *KnowledgeBase) error
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
