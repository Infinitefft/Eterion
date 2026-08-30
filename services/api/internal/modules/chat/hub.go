// Maintains all authenticated user-scoped WebSocket connections in this process.
package chat

import (
	"log/slog"
	"sync"
)

type connectionSet map[string]*Connection

type Hub struct {
	mu          sync.RWMutex
	connections map[string]connectionSet
	logger      *slog.Logger
}

func NewHub(logger *slog.Logger) *Hub {
	if logger == nil {
		logger = slog.Default()
	}
	return &Hub{
		connections: make(map[string]connectionSet),
		logger:      logger,
	}
}

func (h *Hub) Register(connection *Connection) {
	h.mu.Lock()
	userConnections := h.connections[connection.UserID()]
	if userConnections == nil {
		userConnections = make(connectionSet)
		h.connections[connection.UserID()] = userConnections
	}
	userConnections[connection.ID()] = connection
	h.mu.Unlock()

	h.logger.Info(
		"websocket connection registered",
		"connection_id", connection.ID(),
		"user_id", connection.UserID(),
	)
}

func (h *Hub) Unregister(connection *Connection) {
	h.mu.Lock()
	userConnections := h.connections[connection.UserID()]
	if current := userConnections[connection.ID()]; current == connection {
		delete(userConnections, connection.ID())
		if len(userConnections) == 0 {
			delete(h.connections, connection.UserID())
		}
	}
	h.mu.Unlock()
}

func (h *Hub) PublishToUser(userID string, event ThreadEvent) int {
	connections := h.userConnections(userID)
	delivered := 0
	for _, connection := range connections {
		if err := connection.Send(event); err != nil {
			h.Unregister(connection)
			h.logger.Warn(
				"websocket event dropped",
				"connection_id", connection.ID(),
				"user_id", userID,
				"event_type", event.Type,
				"error", err,
			)
			continue
		}
		delivered++
	}
	return delivered
}

func (h *Hub) ConnectionCount(userID string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.connections[userID])
}

func (h *Hub) CloseAll(reason string) {
	connections := h.allConnections()
	for _, connection := range connections {
		connection.Close(reason)
	}
}

func (h *Hub) userConnections(userID string) []*Connection {
	h.mu.RLock()
	defer h.mu.RUnlock()
	result := make([]*Connection, 0, len(h.connections[userID]))
	for _, connection := range h.connections[userID] {
		result = append(result, connection)
	}
	return result
}

func (h *Hub) allConnections() []*Connection {
	h.mu.Lock()
	defer h.mu.Unlock()
	result := make([]*Connection, 0)
	for _, userConnections := range h.connections {
		for _, connection := range userConnections {
			result = append(result, connection)
		}
	}
	h.connections = make(map[string]connectionSet)
	return result
}
