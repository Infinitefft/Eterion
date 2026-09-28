package knowledge

import (
	"context"
	"github.com/google/uuid"
)

type FileRepository interface {
	OwnsBase(context.Context, uuid.UUID, uuid.UUID) (bool, error)
	SaveFile(context.Context, *KnowledgeFile) (*KnowledgeFile, error)
	ListFiles(context.Context, uuid.UUID) ([]KnowledgeFile, error)
	FindFile(context.Context, uuid.UUID, uuid.UUID) (*KnowledgeFile, error)
	DeleteFile(context.Context, uuid.UUID, uuid.UUID) error
	DeleteBase(context.Context, uuid.UUID, uuid.UUID) error
}

func (r *GormRepository) DeleteBase(ctx context.Context, baseID, userID uuid.UUID) error {
	// 文件外键限制避免并发上传时误删仍有文件的知识库。
	return r.db.WithContext(ctx).Where("id = ? AND user_id = ?", baseID, userID).Delete(&KnowledgeBase{}).Error
}

func (r *GormRepository) DeleteFile(ctx context.Context, baseID, fileID uuid.UUID) error {
	return r.db.WithContext(ctx).Where("id = ? AND knowledge_base_id = ?", fileID, baseID).Delete(&KnowledgeFile{}).Error
}

func (r *GormRepository) FindFile(ctx context.Context, baseID, fileID uuid.UUID) (*KnowledgeFile, error) {
	var file KnowledgeFile
	err := r.db.WithContext(ctx).Where("id = ? AND knowledge_base_id = ?", fileID, baseID).First(&file).Error
	return &file, err
}

func (r *GormRepository) OwnsBase(ctx context.Context, baseID, userID uuid.UUID) (bool, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&KnowledgeBase{}).Where("id = ? AND user_id = ?", baseID, userID).Count(&count).Error
	return count > 0, err
}

func (r *GormRepository) SaveFile(ctx context.Context, file *KnowledgeFile) (*KnowledgeFile, error) {
	if err := r.db.WithContext(ctx).Create(file).Error; err != nil {
		return nil, err
	}
	return file, nil
}

func (r *GormRepository) ListFiles(ctx context.Context, baseID uuid.UUID) ([]KnowledgeFile, error) {
	files := make([]KnowledgeFile, 0)
	err := r.db.WithContext(ctx).Where("knowledge_base_id = ?", baseID).Order("created_at DESC").Order("id DESC").Find(&files).Error
	return files, err
}
