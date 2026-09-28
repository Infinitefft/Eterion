package knowledge

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/Infinitefft/Eterion/services/api/internal/modules/auth"
	apperrors "github.com/Infinitefft/Eterion/services/api/internal/shared/errors"
	"github.com/Infinitefft/Eterion/services/api/internal/shared/response"
	"github.com/gin-gonic/gin"
)

type Handler struct {
	service *Service
	logger  *slog.Logger
}

func NewHandler(service *Service, logger *slog.Logger) *Handler {
	return &Handler{service: service, logger: logger}
}

func (h *Handler) RegisterRoutes(api *gin.RouterGroup, requireAccessToken gin.HandlerFunc) {
	api.POST("/knowledge-bases", requireAccessToken, h.Create)
	api.GET("/knowledge-bases", requireAccessToken, h.List)
}

func (h *Handler) List(c *gin.Context) {
	identity, ok := auth.IdentityFromContext(c)
	if !ok {
		h.logger.Error("knowledge request missing authenticated identity")
		response.Error(c, apperrors.Internal())
		return
	}
	result, err := h.service.List(c.Request.Context(), identity.UserID)
	if err != nil {
		h.logger.Error("list knowledge bases failed", "error", err)
		response.Error(c, apperrors.Internal())
		return
	}
	response.JSON(c, http.StatusOK, result)
}

func (h *Handler) Create(c *gin.Context) {
	identity, ok := auth.IdentityFromContext(c)
	if !ok {
		h.logger.Error("knowledge request missing authenticated identity")
		response.Error(c, apperrors.Internal())
		return
	}

	var request CreateRequest
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32*1024)
	if err := c.ShouldBindJSON(&request); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			response.Error(c, apperrors.New(http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", "请求体过大", "FIX_INPUT"))
		} else {
			response.Error(c, apperrors.Validation(map[string]string{"body": "请求体必须是合法的 JSON 对象，标题和描述必须为字符串"}))
		}
		return
	}

	result, err := h.service.Create(c.Request.Context(), identity.UserID, request)
	if err != nil {
		var appErr *apperrors.Error
		if errors.As(err, &appErr) {
			response.Error(c, appErr)
		} else {
			h.logger.Error("create knowledge base failed", "error", err)
			response.Error(c, apperrors.Internal())
		}
		return
	}
	response.JSON(c, http.StatusCreated, result)
}
