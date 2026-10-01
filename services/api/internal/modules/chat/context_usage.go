package chat

import (
	"context"
	"database/sql"
	"errors"
	"net/http"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
	"github.com/Infinitefft/Eterion/services/api/internal/shared/response"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

func (h *Handler) RegisterContextUsageRoute(api *gin.RouterGroup, auth gin.HandlerFunc, repository *GormRepository, reader agent.ContextUsageReader) {
	api.GET("/chat/:id/context/usage", auth, func(c *gin.Context) {
		identity, chatID, ok := h.identityAndChatID(c)
		if !ok {
			return
		}
		modelID, ok := h.models.ResolveModelID(c.Query("model_id"))
		if !ok {
			h.writeError(c, invalidEnvelope("所选模型不可用"))
			return
		}
		input, err := repository.readContextUsageInput(c.Request.Context(), identity.UserID, chatID, modelID)
		if errors.Is(err, ErrRepositoryChatNotFound) {
			h.writeError(c, newBusinessError(ErrorChatNotFound, "会话不存在或无权访问", false, http.StatusNotFound))
			return
		}
		if errors.Is(err, ErrRepositoryRunActive) {
			h.writeError(c, newBusinessError("CONTEXT_BUSY", "回答生成中，请在完成后查看上下文余量", true, http.StatusConflict))
			return
		}
		var usage *agent.ContextUsage
		if err == nil {
			usage, err = reader.ReadContextUsage(c.Request.Context(), input)
		}
		if err != nil {
			h.logger.Warn("context usage unavailable", "chat_id", chatID)
			h.writeError(c, newBusinessError("CONTEXT_USAGE_FAILED", "上下文余量读取失败，请稍后重试", true, http.StatusBadGateway))
			return
		}
		response.JSON(c, http.StatusOK, usage)
	})
}

func (r *GormRepository) readContextUsageInput(ctx context.Context, userID, chatID uuid.UUID, modelID string) (agent.CompactInput, error) {
	input := agent.CompactInput{ModelID: modelID, History: []agent.ContextHistoryMessage{}}
	// 快照和增量历史在同一数据库视图读取，避免压缩或新回复造成重复计数。
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var chat Chat
		if err := tx.Where("id = ? AND user_id = ?", chatID, userID).First(&chat).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrRepositoryChatNotFound
			}
			return err
		}
		input.SessionStartedAt = chat.CreatedAt.UnixMilli()
		var active int64
		if err := tx.Model(&Run{}).Where("chat_id = ? AND status IN ?", chatID,
			[]RunStatus{RunStatusPending, RunStatusRunning, RunStatusWaitingUser}).Count(&active).Error; err != nil {
			return err
		}
		if active > 0 {
			return ErrRepositoryRunActive
		}
		var latest Message
		err := tx.Where("chat_id = ? AND role = ? AND status = ? AND agent_context IS NOT NULL",
			chatID, MessageRoleAssistant, MessageStatusCompleted).Order("created_at DESC, id DESC").First(&latest).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		query := tx.Omit("AgentContext").Where("chat_id = ?", chatID)
		if latest.ID != uuid.Nil {
			input.AgentContext = latest.AgentContext
			query = query.Where("(created_at, id) > (?, ?)", latest.CreatedAt, latest.ID)
		}
		var rows []Message
		if err := query.Order("created_at ASC, id ASC").Find(&rows).Error; err != nil {
			return err
		}
		for _, row := range rows {
			input.History = append(input.History, agent.ContextHistoryMessage{ID: row.ID.String(), Role: string(row.Role), Status: string(row.Status), Content: row.Content})
		}
		return nil
	}, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	return input, err
}
