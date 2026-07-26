// 负责在 Go 进程内统一注册、移除和广播所有在线 WebSocket 连接。
package chat

import (
	"log/slog"
	"sync"
)

// connectionSet 保存 connection_id 到连接对象的映射。
type connectionSet map[string]*Connection

// chatConnectionSet 保存一个用户在不同 Chat 下建立的连接。
type chatConnectionSet map[string]connectionSet

// Hub 是整个 Go 服务共用的 IM 连接中心。
//
// 当前先保存在单个进程内。以后服务需要多实例部署时，
// 可以在 Hub 外增加 Redis 事件转发，而不修改 Connection。
type Hub struct {
	// RWMutex 是读写锁：多个广播操作可以同时读取连接，
	// 注册或移除连接时才需要独占写锁。
	mu sync.RWMutex

	// 第一层 key 是 user_id，第二层 key 是 chat_id，
	// 第三层 key 是 connection_id。
	connections map[string]chatConnectionSet
	logger      *slog.Logger
}

// NewHub 创建一个空的全局连接中心。
// Hub 应该在应用启动时只创建一次，再注入 Handler 和事件发布器。
func NewHub(logger *slog.Logger) *Hub {
	if logger == nil {
		logger = slog.Default()
	}

	return &Hub{
		connections: make(map[string]chatConnectionSet),
		logger:      logger,
	}
}

// Register 把一条已经完成鉴权的连接加入 Hub。
func (h *Hub) Register(connection *Connection) {
	h.mu.Lock()
	defer h.mu.Unlock()

	userChats, exists := h.connections[connection.UserID()]
	if !exists {
		userChats = make(chatConnectionSet)
		h.connections[connection.UserID()] = userChats
	}

	chatConnections, exists := userChats[connection.ChatID()]
	if !exists {
		chatConnections = make(connectionSet)
		userChats[connection.ChatID()] = chatConnections
	}

	chatConnections[connection.ID()] = connection

	h.logger.Info(
		"websocket connection registered",
		"connection_id", connection.ID(),
		"user_id", connection.UserID(),
		"chat_id", connection.ChatID(),
	)
}

// Unregister 从 Hub 移除连接，并清理已经变空的嵌套 map。
func (h *Hub) Unregister(connection *Connection) {
	h.mu.Lock()
	defer h.mu.Unlock()

	userChats, exists := h.connections[connection.UserID()]
	if !exists {
		return
	}

	chatConnections, exists := userChats[connection.ChatID()]
	if !exists {
		return
	}

	// 比较指针可以防止极端情况下误删相同 ID 对应的新连接。
	current, exists := chatConnections[connection.ID()]
	if !exists || current != connection {
		return
	}

	delete(chatConnections, connection.ID())
	if len(chatConnections) == 0 {
		delete(userChats, connection.ChatID())
	}
	if len(userChats) == 0 {
		delete(h.connections, connection.UserID())
	}

	h.logger.Info(
		"websocket connection unregistered",
		"connection_id", connection.ID(),
		"user_id", connection.UserID(),
		"chat_id", connection.ChatID(),
	)
}

// PublishToChat 把事件广播给某个用户在指定 Chat 下的全部在线连接。
//
// 返回值表示成功放入发送队列的连接数量。返回 0 只表示当前没有
// 可用连接，不能因此取消仍在后台执行的 Agent Run。
func (h *Hub) PublishToChat(
	userID string,
	chatID string,
	event ServerEnvelope,
) int {
	connections := h.chatConnections(userID, chatID)
	delivered := 0

	for _, connection := range connections {
		if err := connection.Send(event); err != nil {
			// Send 不会阻塞；连接已关闭或队列已满时顺便从 Hub 清理。
			h.Unregister(connection)
			h.logger.Warn(
				"websocket event dropped",
				"connection_id", connection.ID(),
				"user_id", userID,
				"chat_id", chatID,
				"event_type", event.Type,
				"error", err,
			)
			continue
		}
		delivered++
	}

	return delivered
}

// ConnectionCount 返回某个用户在指定 Chat 下的当前连接数。
// 这个方法主要用于状态检查和测试。
func (h *Hub) ConnectionCount(userID string, chatID string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()

	userChats, exists := h.connections[userID]
	if !exists {
		return 0
	}
	return len(userChats[chatID])
}

// CloseAll 在 Go 服务关闭时断开全部 WebSocket 连接。
func (h *Hub) CloseAll(reason string) {
	connections := h.allConnections()

	for _, connection := range connections {
		connection.Close(reason)
	}
}

func (h *Hub) chatConnections(
	userID string,
	chatID string,
) []*Connection {
	h.mu.RLock()
	defer h.mu.RUnlock()

	userChats, exists := h.connections[userID]
	if !exists {
		return nil
	}

	chatConnections := userChats[chatID]
	result := make([]*Connection, 0, len(chatConnections))
	for _, connection := range chatConnections {
		result = append(result, connection)
	}
	return result
}

func (h *Hub) allConnections() []*Connection {
	h.mu.Lock()
	defer h.mu.Unlock()

	result := make([]*Connection, 0)
	for _, userChats := range h.connections {
		for _, chatConnections := range userChats {
			for _, connection := range chatConnections {
				result = append(result, connection)
			}
		}
	}

	// 先从 Hub 清空映射，再在锁外逐条关闭 socket。
	h.connections = make(map[string]chatConnectionSet)
	return result
}
