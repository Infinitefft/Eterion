package chat

import (
	"context"
	"errors"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
	"github.com/google/uuid"
)

type generatedTitleRepository interface {
	UpdateGeneratedTitle(context.Context, uuid.UUID, uuid.UUID, string, string, time.Time) (*Chat, error)
}

func (m *RunManager) GenerateTitle(record SubmitRecord) {
	generator, supported := m.runner.(agent.TitleGenerator)
	repository, writable := m.repository.(generatedTitleRepository)
	if !supported || !writable {
		return
	}
	m.runs.Add(1)
	go func() {
		defer m.runs.Done()
		// 与 WebSocket 连接和回答 Run 独立，但仍受服务生命周期和超时约束。
		ctx, cancel := context.WithTimeout(m.appContext, 30*time.Second)
		defer cancel()
		title, err := generator.GenerateTitle(ctx, agent.TitleInput{ModelID: record.Run.ModelID, Content: firstRunes(record.UserMessage.Content, 4000)})
		if err != nil {
			if m.appContext.Err() == nil {
				m.logger.Warn("title generation failed; keeping initial title", "chat_id", record.Chat.ID)
			}
			return
		}
		chat, err := repository.UpdateGeneratedTitle(ctx, record.Run.UserID, record.Chat.ID, record.Chat.Title, title, m.now())
		if errors.Is(err, ErrRepositoryChatNotFound) {
			return
		}
		if err != nil {
			m.logger.Warn("save generated title failed", "chat_id", record.Chat.ID)
			return
		}
		if chat != nil {
			m.publisher.ThreadUpdated(record.Run.UserID.String(), *chat, chat.LastSeq)
		}
	}()
}
