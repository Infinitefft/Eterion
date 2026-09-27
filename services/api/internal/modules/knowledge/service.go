package knowledge

import (
	"context"
	"strings"
	"time"
	"unicode/utf8"

	apperrors "github.com/Infinitefft/Eterion/services/api/internal/shared/errors"
	"github.com/google/uuid"
)

type Service struct {
	repository Repository
}

func NewService(repository Repository) *Service {
	return &Service{repository: repository}
}

func (s *Service) Create(ctx context.Context, userID uuid.UUID, request CreateRequest) (*KnowledgeBaseResponse, error) {
	title := strings.TrimSpace(request.Title)
	description := strings.TrimSpace(request.Description)
	fields := make(map[string]string)
	if title == "" {
		fields["title"] = "请输入知识库标题"
	} else if utf8.RuneCountInString(title) > 120 {
		fields["title"] = "知识库标题不能超过 120 个字符"
	}
	if utf8.RuneCountInString(description) > 2000 {
		fields["description"] = "知识库描述不能超过 2000 个字符"
	}
	if len(fields) > 0 {
		return nil, apperrors.Validation(fields)
	}

	now := time.Now().UTC()
	base := &KnowledgeBase{
		ID: uuid.New(), UserID: userID, Title: title, Description: description,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := s.repository.Create(ctx, base); err != nil {
		return nil, err
	}
	return &KnowledgeBaseResponse{
		ID: base.ID.String(), Title: base.Title, Description: base.Description,
		CreatedAt: base.CreatedAt, UpdatedAt: base.UpdatedAt,
	}, nil
}
