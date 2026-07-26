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

	messageResponses := make([]MessageResponse, 0, len(messages))
	for _, message := range messages {
		messageResponses = append(
			messageResponses,
			messageResponse(message),
		)
	}

	runResponses := make([]RunResponse, 0, len(runs))
	for _, run := range runs {
		runResponses = append(runResponses, runResponse(run))
	}

	return &SnapshotResponse{
		Chat:     chatResponse(*chat),
		Messages: messageResponses,
		Runs:     runResponses,
	}, nil
}

func (s *Service) Submit(
	ctx context.Context,
	userID uuid.UUID,
	chatID uuid.UUID,
	idempotencyKey string,
	content string,
) (*SubmitRecord, error) {
	record, err := s.repository.Submit(
		ctx,
		userID,
		chatID,
		idempotencyKey,
		content,
		s.now(),
	)
	switch {
	case errors.Is(err, ErrRepositoryChatNotFound):
		return nil, newBusinessError(
			ErrorChatNotFound,
			"Chat 不存在或无权访问",
			false,
			http.StatusNotFound,
		)
	case errors.Is(err, ErrRepositoryRunActive):
		return nil, newBusinessError(
			ErrorRunActive,
			"当前 Chat 已有正在执行的任务",
			false,
			http.StatusConflict,
		)
	case errors.Is(err, ErrRepositoryIdempotencyConflict):
		return nil, newBusinessError(
			ErrorInvalidEnvelope,
			"幂等键已用于其他 Chat",
			false,
			http.StatusConflict,
		)
	case err != nil:
		return nil, err
	default:
		return record, nil
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

func messageResponse(message Message) MessageResponse {
	var runID *string
	if message.RunID != nil {
		value := message.RunID.String()
		runID = &value
	}

	return MessageResponse{
		ID:          message.ID.String(),
		ChatID:      message.ChatID.String(),
		RunID:       runID,
		Role:        message.Role,
		Status:      message.Status,
		Content:     message.Content,
		CreatedAt:   message.CreatedAt,
		UpdatedAt:   message.UpdatedAt,
		CompletedAt: message.CompletedAt,
	}
}

func runResponse(run Run) RunResponse {
	var runError *RunErrorResponse
	if run.ErrorCode != nil {
		runError = &RunErrorResponse{
			Code: *run.ErrorCode,
		}
		if run.ErrorMessage != nil {
			runError.Message = *run.ErrorMessage
		}
	}

	return RunResponse{
		ID:              run.ID.String(),
		ChatID:          run.ChatID.String(),
		InputMessageID:  run.InputMessageID.String(),
		OutputMessageID: run.OutputMessageID.String(),
		Status:          run.Status,
		LastSeq:         run.LastSeq,
		Error:           runError,
		CreatedAt:       run.CreatedAt,
		StartedAt:       run.StartedAt,
		UpdatedAt:       run.UpdatedAt,
		CompletedAt:     run.CompletedAt,
	}
}
