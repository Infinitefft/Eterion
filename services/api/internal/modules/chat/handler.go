// 负责提供 Chat REST 接口、WebSocket Ticket 接口和连接升级入口。
package chat

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
	"github.com/Infinitefft/Eterion/services/api/internal/config"
	"github.com/Infinitefft/Eterion/services/api/internal/modules/auth"
	apperrors "github.com/Infinitefft/Eterion/services/api/internal/shared/errors"
	"github.com/Infinitefft/Eterion/services/api/internal/shared/response"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const maxCreateChatBodyBytes = 16 * 1024

type TicketResponse struct {
	Ticket    string `json:"ticket"`
	ExpiresAt int64  `json:"expires_at"`
}

type Handler struct {
	service   *Service
	tickets   *TicketService
	hub       *Hub
	publisher *Publisher
	commands  *CommandRouter
	models    agent.ModelCatalog
	config    config.Config
	logger    *slog.Logger
	upgrader  websocket.Upgrader
}

func NewHandler(
	service *Service,
	tickets *TicketService,
	hub *Hub,
	publisher *Publisher,
	commands *CommandRouter,
	cfg config.Config,
	logger *slog.Logger,
	modelCatalog ...agent.ModelCatalog,
) *Handler {
	if logger == nil {
		logger = slog.Default()
	}

	handler := &Handler{
		service:   service,
		tickets:   tickets,
		hub:       hub,
		publisher: publisher,
		commands:  commands,
		config:    cfg,
		logger:    logger,
	}
	if len(modelCatalog) > 0 {
		handler.models = modelCatalog[0]
	}
	handler.upgrader = websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin:     handler.isAllowedOrigin,
	}
	return handler
}

func (h *Handler) RegisterRoutes(
	api *gin.RouterGroup,
	requireAccessToken gin.HandlerFunc,
) {
	group := api.Group("/chat")

	group.POST("", requireAccessToken, h.CreateChat)
	group.GET("", requireAccessToken, h.ListChats)
	group.PATCH("/:id", requireAccessToken, h.UpdateChat)
	group.DELETE("/:id", requireAccessToken, h.DeleteChat)
	group.GET("/models", requireAccessToken, h.ListModels)
	group.GET(
		"/:id/snapshot",
		requireAccessToken,
		h.Snapshot,
	)
	group.POST(
		"/ticket",
		requireAccessToken,
		h.CreateTicket,
	)

	// 原生 WebSocket 无法方便地设置 Authorization Header，
	// 因此连接入口使用前一步申请的一次性 Ticket。
	group.GET("/ws", h.Connect)
}

// ListModels 返回当前服务端已经配置完成、可以用于文本对话的模型。
func (h *Handler) ListModels(c *gin.Context) {
	if _, ok := h.identity(c); !ok {
		return
	}
	if h.models == nil {
		response.JSON(c, http.StatusOK, gin.H{
			"default_model_id": "",
			"models":           []agent.ModelInfo{},
		})
		return
	}
	response.JSON(c, http.StatusOK, gin.H{
		"default_model_id": h.models.DefaultModelID(),
		"models":           h.models.Models(),
	})
}

func (h *Handler) CreateChat(c *gin.Context) {
	identity, ok := h.identity(c)
	if !ok {
		return
	}

	var request CreateChatRequest
	c.Request.Body = http.MaxBytesReader(
		c.Writer,
		c.Request.Body,
		maxCreateChatBodyBytes,
	)
	if err := c.ShouldBindJSON(&request); err != nil {
		h.writeError(c, invalidEnvelope("请求体必须是合法的 JSON 对象"))
		return
	}

	result, err := h.service.CreateChat(
		c.Request.Context(),
		identity.UserID,
		request,
	)
	if err != nil {
		h.writeError(c, err)
		return
	}
	response.JSON(c, http.StatusCreated, result)
}

func (h *Handler) ListChats(c *gin.Context) {
	identity, ok := h.identity(c)
	if !ok {
		return
	}

	result, err := h.service.ListChats(
		c.Request.Context(),
		identity.UserID,
	)
	if err != nil {
		h.writeError(c, err)
		return
	}
	response.JSON(c, http.StatusOK, result)
}

func (h *Handler) UpdateChat(c *gin.Context) {
	identity, chatID, ok := h.identityAndChatID(c)
	if !ok {
		return
	}

	var request UpdateChatRequest
	c.Request.Body = http.MaxBytesReader(
		c.Writer,
		c.Request.Body,
		maxCreateChatBodyBytes,
	)
	if err := c.ShouldBindJSON(&request); err != nil {
		h.writeError(c, invalidEnvelope("请求体必须是合法的 JSON 对象"))
		return
	}

	result, seq, err := h.service.UpdateChat(
		c.Request.Context(),
		identity.UserID,
		chatID,
		request,
	)
	if err != nil {
		h.writeError(c, err)
		return
	}
	h.publisher.ThreadUpdated(identity.UserID.String(), Chat{
		ID: chatID, UserID: identity.UserID, Title: result.Title,
		LastSeq: seq, CreatedAt: result.CreatedAt, UpdatedAt: result.UpdatedAt,
	}, seq)
	response.JSON(c, http.StatusOK, result)
}

func (h *Handler) DeleteChat(c *gin.Context) {
	identity, chatID, ok := h.identityAndChatID(c)
	if !ok {
		return
	}

	if err := h.service.DeleteChat(
		c.Request.Context(),
		identity.UserID,
		chatID,
	); err != nil {
		h.writeError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *Handler) Snapshot(c *gin.Context) {
	identity, chatID, ok := h.identityAndChatID(c)
	if !ok {
		return
	}

	result, err := h.service.Snapshot(
		c.Request.Context(),
		identity.UserID,
		chatID,
	)
	if err != nil {
		h.writeError(c, err)
		return
	}
	response.JSON(c, http.StatusOK, result)
}

func (h *Handler) CreateTicket(c *gin.Context) {
	identity, ok := h.identity(c)
	if !ok {
		return
	}

	ticket, err := h.tickets.Issue(identity.UserID)
	if err != nil {
		h.writeError(c, err)
		return
	}
	response.JSON(c, http.StatusCreated, TicketResponse{
		Ticket:    ticket.Value,
		ExpiresAt: ticket.ExpiresAt.UnixMilli(),
	})
}

func (h *Handler) Connect(c *gin.Context) {
	if !h.isAllowedOrigin(c.Request) {
		h.writeError(c, newBusinessError(
			ErrorForbidden,
			"WebSocket 请求来源不受信任",
			false,
			http.StatusForbidden,
		))
		return
	}

	rawTicket := strings.TrimSpace(c.Query("ticket"))
	userID, err := h.tickets.Consume(rawTicket)
	if err != nil {
		response.Error(c, apperrors.New(
			http.StatusUnauthorized,
			"UNAUTHENTICATED",
			"WebSocket Ticket 无效或已过期",
			"REQUEST_NEW_TICKET",
		))
		return
	}

	socket, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		h.logger.Warn("websocket upgrade failed", "error", err)
		return
	}

	connection := NewConnection(
		uuid.NewString(),
		userID.String(),
		socket,
		h.logger,
	)
	h.hub.Register(connection)
	defer h.hub.Unregister(connection)

	if err := connection.Serve(
		c.Request.Context(),
		h.commands.HandleFrame,
	); err != nil &&
		!errors.Is(err, io.EOF) &&
		!websocket.IsUnexpectedCloseError(
			err,
			websocket.CloseNormalClosure,
			websocket.CloseGoingAway,
		) {
		h.logger.Warn(
			"websocket connection ended unexpectedly",
			"connection_id", connection.ID(),
			"user_id", connection.UserID(),
			"error", err,
		)
	}
}

func (h *Handler) identity(
	c *gin.Context,
) (*auth.Identity, bool) {
	identity, ok := auth.IdentityFromContext(c)
	if !ok {
		h.writeError(c, errors.New(
			"authenticated identity is missing from context",
		))
		return nil, false
	}
	return identity, true
}

func (h *Handler) identityAndChatID(
	c *gin.Context,
) (*auth.Identity, uuid.UUID, bool) {
	identity, ok := h.identity(c)
	if !ok {
		return nil, uuid.Nil, false
	}
	chatID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		h.writeError(c, invalidEnvelope("Chat ID 格式不合法"))
		return nil, uuid.Nil, false
	}
	return identity, chatID, true
}

func (h *Handler) isAllowedOrigin(request *http.Request) bool {
	origin := strings.TrimSpace(request.Header.Get("Origin"))
	return origin != "" && h.config.IsAllowedOrigin(origin)
}

func (h *Handler) writeError(c *gin.Context, err error) {
	var businessError *BusinessError
	if errors.As(err, &businessError) {
		response.Error(c, apperrors.New(
			businessError.HTTPStatus,
			businessError.Code,
			businessError.Message,
			"CHECK_CHAT_REQUEST",
		))
		return
	}

	h.logger.Error("chat request failed", "error", err)
	response.Error(c, apperrors.Internal())
}
