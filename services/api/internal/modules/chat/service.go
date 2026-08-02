// 负责处理 Chat 创建、查询、消息提交和资源归属等业务规则。
package chat

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	defaultChatTitle  = "新对话"
	maxChatTitleRunes = 120
)

type Service struct {
	repository Repository
	now        func() time.Time
}

func (s *Service) StartChat(
	ctx context.Context,
	userID uuid.UUID,
	chatID uuid.UUID,
	messageID uuid.UUID,
	idempotencyKey string,
	title *string,
	content string,
	format TextFormat,
) (*SubmitRecord, error) {
	normalizedTitle := ""
	if title != nil {
		normalizedTitle = strings.TrimSpace(*title)
	}
	if normalizedTitle == "" {
		normalizedTitle = firstRunes(content, 30)
	}
	if utf8.RuneCountInString(normalizedTitle) > maxChatTitleRunes {
		return nil, newBusinessError(
			ErrorInvalidEnvelope,
			"Chat 标题不能超过 120 个字符",
			false,
			http.StatusBadRequest,
		)
	}

	record, err := s.repository.StartChat(
		ctx,
		userID,
		chatID,
		messageID,
		idempotencyKey,
		normalizedTitle,
		content,
		format,
		s.now(),
	)
	return record, s.mapSubmitError(err)
}

func NewService(repository Repository) *Service {
	return &Service{
		repository: repository,
		now: func() time.Time {
			return time.Now().UTC()
		},
	}
}

func (s *Service) CreateChat(
	ctx context.Context,
	userID uuid.UUID,
	request CreateChatRequest,
) (*ChatResponse, error) {
	title := strings.TrimSpace(request.Title)
	if title == "" {
		title = defaultChatTitle
	}
	if utf8.RuneCountInString(title) > maxChatTitleRunes {
		return nil, newBusinessError(
			ErrorInvalidEnvelope,
			"Chat 标题不能超过 120 个字符",
			false,
			http.StatusBadRequest,
		)
	}

	now := s.now()
	chat := &Chat{
		ID:        uuid.New(),
		UserID:    userID,
		Title:     title,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := s.repository.CreateChat(ctx, chat); err != nil {
		return nil, err
	}

	result := chatResponse(*chat)
	return &result, nil
}

func (s *Service) ListChats(
	ctx context.Context,
	userID uuid.UUID,
) ([]ChatResponse, error) {
	chats, err := s.repository.ListChats(ctx, userID)
	if err != nil {
		return nil, err
	}

	result := make([]ChatResponse, 0, len(chats))
	for _, chat := range chats {
		result = append(result, chatResponse(chat))
	}
	return result, nil
}

func (s *Service) RequireChat(
	ctx context.Context,
	userID uuid.UUID,
	chatID uuid.UUID,
) (*Chat, error) {
	chat, err := s.repository.FindChatOwned(ctx, userID, chatID)
	if errors.Is(err, ErrRepositoryChatNotFound) {
		return nil, newBusinessError(
			ErrorChatNotFound,
			"Chat 不存在或无权访问",
			false,
			http.StatusNotFound,
		)
	}
	return chat, err
}

func (s *Service) Snapshot(
	ctx context.Context,
	userID uuid.UUID,
	chatID uuid.UUID,
) (*SnapshotResponse, error) {
	chat, messages, runs, err := s.repository.Snapshot(
		ctx,
		userID,
		chatID,
	)
	if errors.Is(err, ErrRepositoryChatNotFound) {
		return nil, newBusinessError(
			ErrorChatNotFound,
			"Chat 不存在或无权访问",
			false,
			http.StatusNotFound,
		)
	}
	if err != nil {
		return nil, err
	}

	runsByID := make(map[uuid.UUID]Run, len(runs))
	for _, run := range runs {
		runsByID[run.ID] = run
	}

	messageResponses := make([]SnapshotMessage, 0, len(messages))
	for _, message := range messages {
		var messageError *CommandError
		if message.Status == MessageStatusFailed && message.RunID != nil {
			messageError = runCommandError(runsByID[*message.RunID])
		}
		messageResponses = append(messageResponses, snapshotMessage(
			wireChatMessage(message, messageError),
		))
	}

	runResponses := make([]SnapshotRun, 0, len(runs))
	for _, run := range runs {
		runResponses = append(runResponses, snapshotRun(wireAgentRun(run)))
	}

	return &SnapshotResponse{
		Chat: SnapshotChat{
			ID:        chat.ID.String(),
			Title:     chat.Title,
			CreatedAt: chat.CreatedAt.UnixMilli(),
			UpdatedAt: chat.UpdatedAt.UnixMilli(),
		},
		Messages: messageResponses,
		Runs:     runResponses,
		Steps:    []any{},
		Cursor:   nil,
	}, nil
}

func (s *Service) Submit(
	ctx context.Context,
	userID uuid.UUID,
	chatID uuid.UUID,
	messageID uuid.UUID,
	idempotencyKey string,
	content string,
	format TextFormat,
) (*SubmitRecord, error) {
	record, err := s.repository.Submit(
		ctx,
		userID,
		chatID,
		messageID,
		idempotencyKey,
		content,
		format,
		s.now(),
	)
	return record, s.mapSubmitError(err)
}

func (s *Service) mapSubmitError(err error) error {
	switch {
	case errors.Is(err, ErrRepositoryChatNotFound):
		return newBusinessError(
			ErrorChatNotFound,
			"Chat 不存在或无权访问",
			false,
			http.StatusNotFound,
		)
	case errors.Is(err, ErrRepositoryRunActive):
		return newBusinessError(
			ErrorRunActive,
			"当前 Chat 已有正在执行的任务",
			false,
			http.StatusConflict,
		)
	case errors.Is(err, ErrRepositoryIdempotencyConflict):
		return newBusinessError(
			ErrorInvalidEnvelope,
			"幂等键与原始请求不匹配",
			false,
			http.StatusConflict,
		)
	case errors.Is(err, ErrRepositoryChatAlreadyExists):
		return newBusinessError(
			ErrorInvalidEnvelope,
			"Chat ID 已被使用",
			false,
			http.StatusConflict,
		)
	case errors.Is(err, ErrRepositoryMessageIDConflict):
		return newBusinessError(
			ErrorInvalidEnvelope,
			"Message ID 已被使用",
			false,
			http.StatusConflict,
		)
	case err != nil:
		return err
	default:
		return nil
	}
}

func (s *Service) FindRun(
	ctx context.Context,
	userID uuid.UUID,
	chatID uuid.UUID,
	runID uuid.UUID,
) (*Run, error) {
	run, err := s.repository.FindRunOwned(
		ctx,
		userID,
		chatID,
		runID,
	)
	if errors.Is(err, ErrRepositoryRunNotFound) {
		return nil, newBusinessError(
			ErrorRunNotFound,
			"Run 不存在或无权访问",
			false,
			http.StatusNotFound,
		)
	}
	return run, err
}

func chatResponse(chat Chat) ChatResponse {
	return ChatResponse{
		ID:        chat.ID.String(),
		Title:     chat.Title,
		CreatedAt: chat.CreatedAt,
		UpdatedAt: chat.UpdatedAt,
	}
}

func firstRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
