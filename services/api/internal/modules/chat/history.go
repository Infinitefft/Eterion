package chat

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type historyMessage struct {
	ID      uuid.UUID     `json:"id"`
	Role    MessageRole   `json:"role"`
	Status  MessageStatus `json:"status"`
	Content string        `json:"content"`
}

type historyPage struct {
	Messages   []historyMessage `json:"messages"`
	NextCursor *string          `json:"next_cursor"`
}

// Only an active Run's bearer capability can read its history. The capability
// is sent privately to Node and disappears when RunManager removes the Run.
func RegisterHistoryRoute(engine *gin.Engine, runs *RunManager, repository *GormRepository) {
	engine.GET("/internal/agent/runs/:id/messages", func(c *gin.Context) {
		runID, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.Status(http.StatusBadRequest)
			return
		}
		token, bearer := strings.CutPrefix(c.GetHeader("Authorization"), "Bearer ")
		runs.mu.Lock()
		active, exists := runs.active[runID]
		runs.mu.Unlock()
		if !bearer || !exists || subtle.ConstantTimeCompare([]byte(token), []byte(active.historyToken)) != 1 {
			c.Status(http.StatusUnauthorized)
			return
		}
		cursor := uuid.Nil
		if raw := c.Query("after"); raw != "" {
			cursor, err = uuid.Parse(raw)
			if err != nil {
				c.Status(http.StatusBadRequest)
				return
			}
		}
		page, err := repository.readHistoryPage(c.Request.Context(), active.run, cursor)
		if err != nil {
			if errors.Is(err, ErrRepositoryChatNotFound) {
				c.Status(http.StatusNotFound)
			} else {
				runs.logger.Error("read conversation history", "run_id", runID, "error", err)
				c.Status(http.StatusInternalServerError)
			}
			return
		}
		c.JSON(http.StatusOK, page)
	})
}

// Return raw facts, including status. Model-context selection belongs to Node.
// The input message bounds every page so later turns cannot enter this Run.
func (r *GormRepository) readHistoryPage(ctx context.Context, run Run, cursor uuid.UUID) (*historyPage, error) {
	if _, err := r.FindChatOwned(ctx, run.UserID, run.ChatID); err != nil {
		return nil, err
	}
	var anchor Message
	if err := r.db.WithContext(ctx).Where("id = ? AND chat_id = ?", run.InputMessageID, run.ChatID).First(&anchor).Error; err != nil {
		return nil, err
	}
	query := r.db.WithContext(ctx).Model(&Message{}).
		Where("chat_id = ? AND (created_at, id) <= (?, ?)", run.ChatID, anchor.CreatedAt, anchor.ID)
	if cursor != uuid.Nil {
		var after Message
		if err := r.db.WithContext(ctx).Where("id = ? AND chat_id = ?", cursor, run.ChatID).First(&after).Error; err != nil {
			return nil, ErrRepositoryChatNotFound
		}
		query = query.Where("(created_at, id) > (?, ?)", after.CreatedAt, after.ID)
	}
	const pageSize = 100
	var rows []Message
	if err := query.Order("created_at ASC, id ASC").Limit(pageSize + 1).Find(&rows).Error; err != nil {
		return nil, err
	}
	page := &historyPage{Messages: make([]historyMessage, 0, len(rows))}
	if len(rows) > pageSize {
		rows = rows[:pageSize]
		cursor := rows[len(rows)-1].ID.String()
		page.NextCursor = &cursor
	}
	for _, row := range rows {
		page.Messages = append(page.Messages, historyMessage{ID: row.ID, Role: row.Role, Status: row.Status, Content: row.Content})
	}
	return page, nil
}
