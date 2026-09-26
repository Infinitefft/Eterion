package chat

import (
	"context"
	"errors"
	"net/http"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
	"github.com/Infinitefft/Eterion/services/api/internal/shared/response"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (h *Handler) RegisterCompactionRoute(api *gin.RouterGroup, auth gin.HandlerFunc, repository *GormRepository, compactor agent.ContextCompactor) {
	api.POST("/chat/:id/context/compact", auth, func(c *gin.Context) {
		identity, chatID, ok := h.identityAndChatID(c)
		if !ok {
			return
		}
		var request struct {
			ModelID string `json:"model_id"`
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
		if err := c.ShouldBindJSON(&request); err != nil {
			h.writeError(c, invalidEnvelope("请求体必须是 JSON 对象"))
			return
		}
		modelID, ok := h.models.ResolveModelID(request.ModelID)
		if !ok {
			h.writeError(c, invalidEnvelope("所选模型不可用"))
			return
		}
		result, err := repository.compactContext(c.Request.Context(), identity.UserID, chatID, modelID, compactor)
		switch {
		case errors.Is(err, ErrRepositoryChatNotFound):
			h.writeError(c, newBusinessError(ErrorChatNotFound, "会话不存在或无权访问", false, http.StatusNotFound))
		case errors.Is(err, ErrRepositoryRunActive):
			h.writeError(c, newBusinessError("CONTEXT_BUSY", "会话正在运行或压缩，请稍后重试", true, http.StatusConflict))
		case err != nil:
			h.logger.Warn("context compaction failed", "chat_id", chatID)
			h.writeError(c, newBusinessError("COMPACTION_FAILED", "压缩失败，原有上下文未修改", true, http.StatusBadGateway))
		default:
			response.JSON(c, http.StatusOK, gin.H{"changed": result.Changed, "truncated": result.Truncated})
		}
	})
}

// 复用提交消息时的 Chat 行锁，压缩期间不允许新 Run 或第二次压缩覆盖上下文。
// 个人项目采用一个有超时的事务，无需额外锁表或分布式基础设施。
func (r *GormRepository) compactContext(ctx context.Context, userID, chatID uuid.UUID, modelID string, compactor agent.ContextCompactor) (*agent.CompactResult, error) {
	result := &agent.CompactResult{}
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var chat Chat
		err := tx.Clauses(clause.Locking{Strength: "UPDATE", Options: "NOWAIT"}).
			Where("id = ? AND user_id = ?", chatID, userID).First(&chat).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrRepositoryChatNotFound
		}
		if isChatLockBusy(err) {
			return ErrRepositoryRunActive
		}
		if err != nil {
			return err
		}
		var active int64
		if err := tx.Model(&Run{}).Where("chat_id = ? AND status IN ?", chatID,
			[]RunStatus{RunStatusPending, RunStatusRunning, RunStatusWaitingUser}).Count(&active).Error; err != nil {
			return err
		}
		if active > 0 {
			return ErrRepositoryRunActive
		}
		// 覆盖边界固定在最后一条成功的 assistant，不包含它之后的失败轮次或用户输入。
		var target Message
		err = tx.Where("chat_id = ? AND role = ? AND status = ?", chatID, MessageRoleAssistant, MessageStatusCompleted).
			Order("created_at DESC, id DESC").First(&target).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		var latest Message
		err = tx.Where("chat_id = ? AND role = ? AND status = ? AND agent_context IS NOT NULL AND (created_at, id) <= (?, ?)",
			chatID, MessageRoleAssistant, MessageStatusCompleted, target.CreatedAt, target.ID).
			Order("created_at DESC, id DESC").First(&latest).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		input := agent.CompactInput{ModelID: modelID, AgentContext: latest.AgentContext, History: []agent.ContextHistoryMessage{}}
		query := tx.Omit("AgentContext").Where("chat_id = ? AND (created_at, id) <= (?, ?)", chatID, target.CreatedAt, target.ID)
		if latest.ID != uuid.Nil {
			query = query.Where("(created_at, id) > (?, ?)", latest.CreatedAt, latest.ID)
		}
		var rows []Message
		if err := query.Order("created_at ASC, id ASC").Find(&rows).Error; err != nil {
			return err
		}
		for _, row := range rows {
			input.History = append(input.History, agent.ContextHistoryMessage{ID: row.ID.String(), Role: string(row.Role), Status: string(row.Status), Content: row.Content})
		}
		result, err = compactor.Compact(ctx, input)
		if err != nil {
			return err
		}
		if !result.Changed {
			return nil
		}
		return tx.Model(&Message{}).Where("id = ?", target.ID).Update("agent_context", result.AgentContext).Error
	})
	return result, err
}

func isChatLockBusy(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "55P03"
}
