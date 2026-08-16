// 负责通过 GORM 持久化 Chat、消息、Run，并保证关键状态变化的原子性。
package chat

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	ErrRepositoryChatNotFound        = errors.New("chat not found")
	ErrRepositoryRunNotFound         = errors.New("run not found")
	ErrRepositoryRunActive           = errors.New("chat already has an active run")
	ErrRepositoryInvalidRunState     = errors.New("invalid run state")
	ErrRepositoryIdempotencyConflict = errors.New("idempotency key belongs to another chat")
	ErrRepositoryChatAlreadyExists   = errors.New("chat already exists")
	ErrRepositoryMessageIDConflict   = errors.New("message id is already in use")
)

type SubmitRecord struct {
	Chat             Chat
	Run              Run
	UserMessage      Message
	AssistantMessage Message
	Duplicate        bool
}

type RunExecution struct {
	Run           Run
	OutputMessage Message
	Messages      []Message
}

// Repository 让 Service 和 RunManager 不依赖 GORM 的具体写法，方便后续测试。
type Repository interface {
	CreateChat(ctx context.Context, chat *Chat) error
	ListChats(ctx context.Context, userID uuid.UUID) ([]Chat, error)
	FindChatOwned(ctx context.Context, userID, chatID uuid.UUID) (*Chat, error)
	UpdateChatTitle(
		ctx context.Context,
		userID uuid.UUID,
		chatID uuid.UUID,
		title string,
		now time.Time,
	) (*Chat, error)
	DeleteChat(ctx context.Context, userID, chatID uuid.UUID) error
	Snapshot(ctx context.Context, userID, chatID uuid.UUID) (*Chat, []Message, []Run, error)
	StartChat(
		ctx context.Context,
		userID uuid.UUID,
		chatID uuid.UUID,
		messageID uuid.UUID,
		idempotencyKey string,
		modelID string,
		title string,
		content string,
		format TextFormat,
		now time.Time,
	) (*SubmitRecord, error)
	Submit(
		ctx context.Context,
		userID uuid.UUID,
		chatID uuid.UUID,
		messageID uuid.UUID,
		idempotencyKey string,
		modelID string,
		content string,
		format TextFormat,
		now time.Time,
	) (*SubmitRecord, error)
	FindRunOwned(
		ctx context.Context,
		userID uuid.UUID,
		chatID uuid.UUID,
		runID uuid.UUID,
	) (*Run, error)
	LoadRunExecution(ctx context.Context, runID uuid.UUID) (*RunExecution, error)
	NextSeq(
		ctx context.Context,
		runID uuid.UUID,
		allowed []RunStatus,
		now time.Time,
	) (int64, error)
	TransitionRun(
		ctx context.Context,
		runID uuid.UUID,
		allowed []RunStatus,
		next RunStatus,
		now time.Time,
	) (RunStatus, int64, error)
	StartMessage(
		ctx context.Context,
		runID uuid.UUID,
		messageID uuid.UUID,
		now time.Time,
	) (int64, error)
	AppendDelta(
		ctx context.Context,
		runID uuid.UUID,
		messageID uuid.UUID,
		delta string,
		now time.Time,
	) (int64, error)
	CompleteRun(
		ctx context.Context,
		runID uuid.UUID,
		messageID uuid.UUID,
		fullText string,
		now time.Time,
	) (int64, int64, error)
	EndRun(
		ctx context.Context,
		runID uuid.UUID,
		messageID uuid.UUID,
		status RunStatus,
		code string,
		message string,
		retryable bool,
		now time.Time,
	) (RunStatus, int64, int64, error)
}

type GormRepository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) *GormRepository {
	return &GormRepository{db: db}
}

func (r *GormRepository) CreateChat(
	ctx context.Context,
	chat *Chat,
) error {
	if err := r.db.WithContext(ctx).Create(chat).Error; err != nil {
		return fmt.Errorf("create chat: %w", err)
	}
	return nil
}

func (r *GormRepository) ListChats(
	ctx context.Context,
	userID uuid.UUID,
) ([]Chat, error) {
	var chats []Chat
	if err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("updated_at DESC").
		Find(&chats).Error; err != nil {
		return nil, fmt.Errorf("list chats: %w", err)
	}
	return chats, nil
}

func (r *GormRepository) FindChatOwned(
	ctx context.Context,
	userID uuid.UUID,
	chatID uuid.UUID,
) (*Chat, error) {
	var chat Chat
	err := r.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", chatID, userID).
		First(&chat).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrRepositoryChatNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("find chat: %w", err)
	}
	return &chat, nil
}

func (r *GormRepository) UpdateChatTitle(
	ctx context.Context,
	userID uuid.UUID,
	chatID uuid.UUID,
	title string,
	now time.Time,
) (*Chat, error) {
	var chat Chat
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		err := tx.
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ? AND user_id = ?", chatID, userID).
			First(&chat).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrRepositoryChatNotFound
		}
		if err != nil {
			return fmt.Errorf("lock chat for title update: %w", err)
		}

		if err := tx.Model(&chat).Updates(map[string]any{
			"title":      title,
			"updated_at": now,
		}).Error; err != nil {
			return fmt.Errorf("update chat title: %w", err)
		}
		chat.Title = title
		chat.UpdatedAt = now
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &chat, nil
}

func (r *GormRepository) DeleteChat(
	ctx context.Context,
	userID uuid.UUID,
	chatID uuid.UUID,
) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var chat Chat
		err := tx.
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ? AND user_id = ?", chatID, userID).
			First(&chat).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrRepositoryChatNotFound
		}
		if err != nil {
			return fmt.Errorf("lock chat for deletion: %w", err)
		}

		var activeRunCount int64
		if err := tx.Model(&Run{}).
			Where(
				"chat_id = ? AND status IN ?",
				chatID,
				[]RunStatus{RunStatusCreated, RunStatusRunning, RunStatusStreaming},
			).
			Count(&activeRunCount).Error; err != nil {
			return fmt.Errorf("check active runs before deleting chat: %w", err)
		}
		if activeRunCount > 0 {
			return ErrRepositoryRunActive
		}

		// runs 引用 messages，按依赖顺序显式删除，避免 RESTRICT 外键阻止级联。
		if err := tx.Where("chat_id = ?", chatID).Delete(&Run{}).Error; err != nil {
			return fmt.Errorf("delete chat runs: %w", err)
		}
		if err := tx.Where("chat_id = ?", chatID).Delete(&Message{}).Error; err != nil {
			return fmt.Errorf("delete chat messages: %w", err)
		}
		if err := tx.Delete(&chat).Error; err != nil {
			return fmt.Errorf("delete chat: %w", err)
		}
		return nil
	})
}

func (r *GormRepository) Snapshot(
	ctx context.Context,
	userID uuid.UUID,
	chatID uuid.UUID,
) (*Chat, []Message, []Run, error) {
	chat, err := r.FindChatOwned(ctx, userID, chatID)
	if err != nil {
		return nil, nil, nil, err
	}

	var messages []Message
	if err := r.db.WithContext(ctx).
		Where("chat_id = ?", chatID).
		Order("created_at ASC, id ASC").
		Find(&messages).Error; err != nil {
		return nil, nil, nil, fmt.Errorf("load chat messages: %w", err)
	}

	var runs []Run
	if err := r.db.WithContext(ctx).
		Where("chat_id = ? AND user_id = ?", chatID, userID).
		Order("created_at ASC, id ASC").
		Find(&runs).Error; err != nil {
		return nil, nil, nil, fmt.Errorf("load chat runs: %w", err)
	}

	return chat, messages, runs, nil
}

func (r *GormRepository) StartChat(
	ctx context.Context,
	userID uuid.UUID,
	chatID uuid.UUID,
	messageID uuid.UUID,
	idempotencyKey string,
	modelID string,
	title string,
	content string,
	format TextFormat,
	now time.Time,
) (*SubmitRecord, error) {
	var result *SubmitRecord
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		duplicate, err := findSubmitByIdempotency(tx, userID, idempotencyKey)
		if err != nil {
			return err
		}
		if duplicate != nil {
			if !sameSubmitIntent(duplicate, chatID, messageID, modelID, content, format) ||
				duplicate.Chat.Title != title {
				return ErrRepositoryIdempotencyConflict
			}
			duplicate.Duplicate = true
			result = duplicate
			return nil
		}

		var existingCount int64
		if err := tx.Model(&Chat{}).
			Where("id = ?", chatID).
			Count(&existingCount).Error; err != nil {
			return fmt.Errorf("check chat id: %w", err)
		}
		if existingCount > 0 {
			return ErrRepositoryChatAlreadyExists
		}

		chat := Chat{
			ID:        chatID,
			UserID:    userID,
			Title:     title,
			CreatedAt: now,
			UpdatedAt: now,
		}
		if err := tx.Create(&chat).Error; err != nil {
			return fmt.Errorf("create chat: %w", err)
		}

		record, err := createRunRecord(
			tx,
			chat,
			messageID,
			idempotencyKey,
			modelID,
			content,
			format,
			now,
		)
		if err != nil {
			return err
		}
		result = record
		return nil
	})
	if err != nil {
		if uniqueViolationConstraint(err) != "" {
			duplicate, lookupErr := findSubmitByIdempotency(
				r.db.WithContext(ctx),
				userID,
				idempotencyKey,
			)
			if lookupErr != nil {
				return nil, lookupErr
			}
			if duplicate != nil &&
				sameSubmitIntent(duplicate, chatID, messageID, modelID, content, format) &&
				duplicate.Chat.Title == title {
				duplicate.Duplicate = true
				return duplicate, nil
			}
			switch uniqueViolationConstraint(err) {
			case "chats_pkey":
				return nil, ErrRepositoryChatAlreadyExists
			case "messages_pkey":
				return nil, ErrRepositoryMessageIDConflict
			default:
				return nil, ErrRepositoryIdempotencyConflict
			}
		}
		return nil, err
	}
	return result, nil
}

func (r *GormRepository) Submit(
	ctx context.Context,
	userID uuid.UUID,
	chatID uuid.UUID,
	messageID uuid.UUID,
	idempotencyKey string,
	modelID string,
	content string,
	format TextFormat,
	now time.Time,
) (*SubmitRecord, error) {
	var result *SubmitRecord

	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 锁定 Chat 可以串行化同一 Chat 的并发提交。
		var lockedChat Chat
		err := tx.
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ? AND user_id = ?", chatID, userID).
			First(&lockedChat).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrRepositoryChatNotFound
		}
		if err != nil {
			return fmt.Errorf("lock chat: %w", err)
		}

		duplicate, err := findSubmitByIdempotency(
			tx,
			userID,
			idempotencyKey,
		)
		if err != nil {
			return err
		}
		if duplicate != nil {
			if !sameSubmitIntent(duplicate, chatID, messageID, modelID, content, format) {
				return ErrRepositoryIdempotencyConflict
			}
			duplicate.Duplicate = true
			result = duplicate
			return nil
		}

		var activeCount int64
		if err := tx.Model(&Run{}).
			Where(
				"chat_id = ? AND status IN ?",
				chatID,
				[]RunStatus{
					RunStatusCreated,
					RunStatusRunning,
					RunStatusStreaming,
				},
			).
			Count(&activeCount).Error; err != nil {
			return fmt.Errorf("check active run: %w", err)
		}
		if activeCount > 0 {
			return ErrRepositoryRunActive
		}

		record, err := createRunRecord(
			tx,
			lockedChat,
			messageID,
			idempotencyKey,
			modelID,
			content,
			format,
			now,
		)
		if err != nil {
			return err
		}
		result = record
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (r *GormRepository) FindRunOwned(
	ctx context.Context,
	userID uuid.UUID,
	chatID uuid.UUID,
	runID uuid.UUID,
) (*Run, error) {
	var run Run
	err := r.db.WithContext(ctx).
		Where(
			"id = ? AND user_id = ? AND chat_id = ?",
			runID,
			userID,
			chatID,
		).
		First(&run).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrRepositoryRunNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("find run: %w", err)
	}
	return &run, nil
}

func (r *GormRepository) LoadRunExecution(
	ctx context.Context,
	runID uuid.UUID,
) (*RunExecution, error) {
	var run Run
	if err := r.db.WithContext(ctx).First(&run, "id = ?", runID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrRepositoryRunNotFound
		}
		return nil, fmt.Errorf("load run: %w", err)
	}

	var messages []Message
	if err := r.db.WithContext(ctx).
		Where(
			"chat_id = ? AND id <> ? AND content <> '' AND status = ?",
			run.ChatID,
			run.OutputMessageID,
			MessageStatusCompleted,
		).
		Order("created_at ASC, id ASC").
		Find(&messages).Error; err != nil {
		return nil, fmt.Errorf("load agent message history: %w", err)
	}
	var outputMessage Message
	if err := r.db.WithContext(ctx).
		First(&outputMessage, "id = ?", run.OutputMessageID).Error; err != nil {
		return nil, fmt.Errorf("load output message: %w", err)
	}

	return &RunExecution{
		Run:           run,
		OutputMessage: outputMessage,
		Messages:      messages,
	}, nil
}

func (r *GormRepository) NextSeq(
	ctx context.Context,
	runID uuid.UUID,
	allowed []RunStatus,
	now time.Time,
) (int64, error) {
	var seq int64
	err := r.withLockedRun(ctx, runID, func(tx *gorm.DB, run *Run) error {
		if !containsRunStatus(allowed, run.Status) {
			return ErrRepositoryInvalidRunState
		}
		seq = run.LastSeq + 1
		return tx.Model(run).Updates(map[string]any{
			"last_seq":   seq,
			"updated_at": now,
		}).Error
	})
	return seq, err
}

func (r *GormRepository) TransitionRun(
	ctx context.Context,
	runID uuid.UUID,
	allowed []RunStatus,
	next RunStatus,
	now time.Time,
) (RunStatus, int64, error) {
	var previous RunStatus
	var seq int64

	err := r.withLockedRun(ctx, runID, func(tx *gorm.DB, run *Run) error {
		if !containsRunStatus(allowed, run.Status) {
			return ErrRepositoryInvalidRunState
		}

		previous = run.Status
		seq = run.LastSeq + 1
		updates := map[string]any{
			"status":     next,
			"last_seq":   seq,
			"updated_at": now,
		}
		if next == RunStatusRunning {
			updates["started_at"] = now
		}
		return tx.Model(run).Updates(updates).Error
	})
	return previous, seq, err
}

func (r *GormRepository) StartMessage(
	ctx context.Context,
	runID uuid.UUID,
	messageID uuid.UUID,
	now time.Time,
) (int64, error) {
	var seq int64
	err := r.withLockedRun(ctx, runID, func(tx *gorm.DB, run *Run) error {
		if !containsRunStatus(
			[]RunStatus{RunStatusRunning, RunStatusStreaming},
			run.Status,
		) {
			return ErrRepositoryInvalidRunState
		}
		result := tx.Model(&Message{}).
			Where("id = ? AND run_id = ?", messageID, runID).
			Updates(map[string]any{
				"status":     MessageStatusStreaming,
				"updated_at": now,
			})
		if result.Error != nil {
			return fmt.Errorf("start assistant message: %w", result.Error)
		}
		if result.RowsAffected != 1 {
			return errors.New("assistant message not found")
		}
		seq = run.LastSeq + 1
		return tx.Model(run).Updates(map[string]any{
			"last_seq":   seq,
			"updated_at": now,
		}).Error
	})
	return seq, err
}

func (r *GormRepository) AppendDelta(
	ctx context.Context,
	runID uuid.UUID,
	messageID uuid.UUID,
	delta string,
	now time.Time,
) (int64, error) {
	var seq int64

	err := r.withLockedRun(ctx, runID, func(tx *gorm.DB, run *Run) error {
		if !containsRunStatus(
			[]RunStatus{RunStatusRunning, RunStatusStreaming},
			run.Status,
		) {
			return ErrRepositoryInvalidRunState
		}

		messageResult := tx.Model(&Message{}).
			Where("id = ? AND run_id = ?", messageID, runID).
			Updates(map[string]any{
				"content":    gorm.Expr("content || ?", delta),
				"status":     MessageStatusStreaming,
				"updated_at": now,
			})
		if messageResult.Error != nil {
			return fmt.Errorf("append assistant message: %w", messageResult.Error)
		}
		if messageResult.RowsAffected != 1 {
			return errors.New("assistant message not found")
		}

		seq = run.LastSeq + 1
		return tx.Model(run).Updates(map[string]any{
			"last_seq":   seq,
			"updated_at": now,
		}).Error
	})
	return seq, err
}

func (r *GormRepository) CompleteRun(
	ctx context.Context,
	runID uuid.UUID,
	messageID uuid.UUID,
	fullText string,
	now time.Time,
) (int64, int64, error) {
	var messageSeq int64
	var statusSeq int64

	err := r.withLockedRun(ctx, runID, func(tx *gorm.DB, run *Run) error {
		if !containsRunStatus(
			[]RunStatus{
				RunStatusCreated,
				RunStatusRunning,
				RunStatusStreaming,
			},
			run.Status,
		) {
			return ErrRepositoryInvalidRunState
		}

		messageResult := tx.Model(&Message{}).
			Where("id = ? AND run_id = ?", messageID, runID).
			Updates(map[string]any{
				"content":      fullText,
				"status":       MessageStatusCompleted,
				"updated_at":   now,
				"completed_at": now,
			})
		if messageResult.Error != nil {
			return fmt.Errorf("complete assistant message: %w", messageResult.Error)
		}
		if messageResult.RowsAffected != 1 {
			return errors.New("assistant message not found")
		}

		messageSeq = run.LastSeq + 1
		statusSeq = run.LastSeq + 2
		return tx.Model(run).Updates(map[string]any{
			"status":          RunStatusCompleted,
			"last_seq":        statusSeq,
			"error_code":      nil,
			"error_message":   nil,
			"error_retryable": false,
			"updated_at":      now,
			"completed_at":    now,
		}).Error
	})
	return messageSeq, statusSeq, err
}

func (r *GormRepository) EndRun(
	ctx context.Context,
	runID uuid.UUID,
	messageID uuid.UUID,
	status RunStatus,
	code string,
	message string,
	retryable bool,
	now time.Time,
) (RunStatus, int64, int64, error) {
	if status != RunStatusFailed && status != RunStatusCancelled {
		return "", 0, 0, errors.New("end run requires failed or cancelled status")
	}

	var previous RunStatus
	var messageSeq int64
	var statusSeq int64
	err := r.withLockedRun(ctx, runID, func(tx *gorm.DB, run *Run) error {
		if !containsRunStatus(
			[]RunStatus{
				RunStatusCreated,
				RunStatusRunning,
				RunStatusStreaming,
			},
			run.Status,
		) {
			return ErrRepositoryInvalidRunState
		}

		previous = run.Status
		messageSeq = run.LastSeq + 1
		statusSeq = run.LastSeq + 2
		messageStatus := MessageStatusFailed
		if status == RunStatusCancelled {
			messageStatus = MessageStatusCancelled
		}

		messageResult := tx.Model(&Message{}).
			Where("id = ? AND run_id = ?", messageID, runID).
			Updates(map[string]any{
				"status":       messageStatus,
				"updated_at":   now,
				"completed_at": now,
			})
		if messageResult.Error != nil {
			return fmt.Errorf("end assistant message: %w", messageResult.Error)
		}
		if messageResult.RowsAffected != 1 {
			return errors.New("assistant message not found")
		}

		updates := map[string]any{
			"status":          status,
			"last_seq":        statusSeq,
			"updated_at":      now,
			"completed_at":    now,
			"error_code":      nil,
			"error_message":   nil,
			"error_retryable": false,
		}
		if code != "" {
			updates["error_code"] = code
		}
		if message != "" {
			updates["error_message"] = message
		}
		if code != "" {
			updates["error_retryable"] = retryable
		}
		return tx.Model(run).Updates(updates).Error
	})
	return previous, messageSeq, statusSeq, err
}

func (r *GormRepository) withLockedRun(
	ctx context.Context,
	runID uuid.UUID,
	fn func(tx *gorm.DB, run *Run) error,
) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var run Run
		err := tx.
			Clauses(clause.Locking{Strength: "UPDATE"}).
			First(&run, "id = ?", runID).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrRepositoryRunNotFound
		}
		if err != nil {
			return fmt.Errorf("lock run: %w", err)
		}
		if err := fn(tx, &run); err != nil {
			return err
		}
		return nil
	})
}

func findSubmitByIdempotency(
	tx *gorm.DB,
	userID uuid.UUID,
	idempotencyKey string,
) (*SubmitRecord, error) {
	var run Run
	err := tx.
		Where(
			"user_id = ? AND idempotency_key = ?",
			userID,
			idempotencyKey,
		).
		First(&run).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find idempotent run: %w", err)
	}
	var chat Chat
	if err := tx.First(&chat, "id = ?", run.ChatID).Error; err != nil {
		return nil, fmt.Errorf("load idempotent chat: %w", err)
	}

	var userMessage Message
	if err := tx.First(&userMessage, "id = ?", run.InputMessageID).Error; err != nil {
		return nil, fmt.Errorf("load idempotent user message: %w", err)
	}
	var assistantMessage Message
	if err := tx.First(
		&assistantMessage,
		"id = ?",
		run.OutputMessageID,
	).Error; err != nil {
		return nil, fmt.Errorf("load idempotent assistant message: %w", err)
	}

	return &SubmitRecord{
		Chat:             chat,
		Run:              run,
		UserMessage:      userMessage,
		AssistantMessage: assistantMessage,
	}, nil
}

func createRunRecord(
	tx *gorm.DB,
	chat Chat,
	messageID uuid.UUID,
	idempotencyKey string,
	modelID string,
	content string,
	format TextFormat,
	now time.Time,
) (*SubmitRecord, error) {
	runID := uuid.New()
	userMessage := Message{
		ID:            messageID,
		ChatID:        chat.ID,
		Role:          MessageRoleUser,
		Status:        MessageStatusCompleted,
		Content:       content,
		ContentFormat: format,
		CreatedAt:     now,
		UpdatedAt:     now,
		CompletedAt:   timePointer(now),
	}
	assistantCreatedAt := now.Add(time.Microsecond)
	assistantMessage := Message{
		ID:            uuid.New(),
		ChatID:        chat.ID,
		Role:          MessageRoleAssistant,
		Status:        MessageStatusPending,
		Content:       "",
		ContentFormat: TextFormatMarkdown,
		CreatedAt:     assistantCreatedAt,
		UpdatedAt:     assistantCreatedAt,
	}

	if err := tx.Create(&userMessage).Error; err != nil {
		if uniqueViolationConstraint(err) != "" {
			return nil, ErrRepositoryMessageIDConflict
		}
		return nil, fmt.Errorf("create user message: %w", err)
	}
	if err := tx.Create(&assistantMessage).Error; err != nil {
		return nil, fmt.Errorf("create assistant message: %w", err)
	}

	run := Run{
		ID:              runID,
		ChatID:          chat.ID,
		UserID:          chat.UserID,
		ModelID:         modelID,
		InputMessageID:  userMessage.ID,
		OutputMessageID: assistantMessage.ID,
		Status:          RunStatusCreated,
		IdempotencyKey:  idempotencyKey,
		LastSeq:         0,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := tx.Create(&run).Error; err != nil {
		switch uniqueViolationConstraint(err) {
		case "runs_one_active_per_chat":
			return nil, ErrRepositoryRunActive
		case "runs_idempotency_unique":
			return nil, ErrRepositoryIdempotencyConflict
		}
		return nil, fmt.Errorf("create run: %w", err)
	}

	if err := tx.Model(&Message{}).
		Where("id IN ?", []uuid.UUID{userMessage.ID, assistantMessage.ID}).
		Update("run_id", runID).Error; err != nil {
		return nil, fmt.Errorf("link messages to run: %w", err)
	}
	userMessage.RunID = &runID
	assistantMessage.RunID = &runID

	if err := tx.Model(&Chat{}).
		Where("id = ?", chat.ID).
		Update("updated_at", now).Error; err != nil {
		return nil, fmt.Errorf("touch chat: %w", err)
	}
	chat.UpdatedAt = now

	return &SubmitRecord{
		Chat:             chat,
		Run:              run,
		UserMessage:      userMessage,
		AssistantMessage: assistantMessage,
	}, nil
}

func sameSubmitIntent(
	record *SubmitRecord,
	chatID uuid.UUID,
	messageID uuid.UUID,
	modelID string,
	content string,
	format TextFormat,
) bool {
	return record.Run.ChatID == chatID &&
		record.UserMessage.ID == messageID &&
		record.Run.ModelID == modelID &&
		record.UserMessage.Content == content &&
		record.UserMessage.ContentFormat == format
}

func containsRunStatus(
	statuses []RunStatus,
	target RunStatus,
) bool {
	for _, status := range statuses {
		if status == target {
			return true
		}
	}
	return false
}

func uniqueViolationConstraint(err error) string {
	var pgError *pgconn.PgError
	if !errors.As(err, &pgError) || pgError.Code != "23505" {
		return ""
	}
	return pgError.ConstraintName
}

func timePointer(value time.Time) *time.Time {
	return &value
}
