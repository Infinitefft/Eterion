package auth

import (
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Infinitefft/Eterion/services/api/internal/config"
	apperrors "github.com/Infinitefft/Eterion/services/api/internal/shared/errors"
	"github.com/Infinitefft/Eterion/services/api/internal/shared/response"
	"github.com/gin-gonic/gin"
	"github.com/go-playground/validator/v10"
)

const maxCredentialsBodyBytes = 64 << 10

var phonePattern = regexp.MustCompile(`^1[3-9][0-9]{9}$`)

type Handler struct {
	service   *Service
	config    config.Config
	logger    *slog.Logger
	validator *validator.Validate
	now       func() time.Time
}

func NewHandler(service *Service, cfg config.Config, logger *slog.Logger) (*Handler, error) {
	validate := validator.New()
	if err := validate.RegisterValidation("phone", func(field validator.FieldLevel) bool {
		return phonePattern.MatchString(strings.TrimSpace(field.Field().String()))
	}); err != nil {
		return nil, err
	}
	if err := validate.RegisterValidation("nickname", func(field validator.FieldLevel) bool {
		nickname := displayNickname(field.Field().String())
		length := utf8.RuneCountInString(nickname)
		if length < 2 || length > 32 {
			return false
		}
		for _, character := range nickname {
			if unicode.IsControl(character) {
				return false
			}
		}
		return true
	}); err != nil {
		return nil, err
	}
	if err := validate.RegisterValidation("password", func(field validator.FieldLevel) bool {
		length := len([]byte(field.Field().String()))
		return length >= 8 && length <= 72
	}); err != nil {
		return nil, err
	}
	return &Handler{
		service:   service,
		config:    cfg,
		logger:    logger,
		validator: validate,
		now:       func() time.Time { return time.Now().UTC() },
	}, nil
}

func (h *Handler) RegisterRoutes(group *gin.RouterGroup) {
	authGroup := group.Group("/auth")
	authGroup.POST("/register", h.Register)
	authGroup.POST("/login", h.Login)
	authGroup.POST("/refresh", h.Refresh)
}

func (h *Handler) Register(c *gin.Context) {
	var request RegisterRequest
	if !h.bindRequest(c, &request) {
		return
	}
	result, err := h.service.Register(c.Request.Context(), request)
	if err != nil {
		h.handleError(c, err)
		return
	}
	h.setRefreshCookie(c, result.RefreshToken, result.RefreshExpiresAt)
	response.JSON(c, http.StatusCreated, result.Response)
}

func (h *Handler) Login(c *gin.Context) {
	var request LoginRequest
	if !h.bindRequest(c, &request) {
		return
	}
	result, err := h.service.Login(c.Request.Context(), request)
	if err != nil {
		h.handleError(c, err)
		return
	}
	h.setRefreshCookie(c, result.RefreshToken, result.RefreshExpiresAt)
	response.JSON(c, http.StatusOK, result.Response)
}

func (h *Handler) Refresh(c *gin.Context) {
	if origin := c.GetHeader("Origin"); origin != "" && !h.config.IsAllowedOrigin(origin) {
		response.Error(c, apperrors.New(
			http.StatusForbidden,
			"AUTH_ORIGIN_FORBIDDEN",
			"请求来源不受信任",
			"USE_ALLOWED_ORIGIN",
		))
		return
	}

	rawRefreshToken, err := c.Cookie(h.config.RefreshCookieName)
	if err != nil && !errors.Is(err, http.ErrNoCookie) {
		h.handleError(c, err)
		return
	}
	result, err := h.service.Refresh(c.Request.Context(), rawRefreshToken)
	if err != nil {
		var appErr *apperrors.Error
		if errors.As(err, &appErr) && appErr.Status >= 400 && appErr.Status < 500 {
			h.clearRefreshCookie(c)
		}
		h.handleError(c, err)
		return
	}
	h.setRefreshCookie(c, result.RefreshToken, result.RefreshExpiresAt)
	response.JSON(c, http.StatusOK, result.Response)
}

func (h *Handler) bindRequest(c *gin.Context, request any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxCredentialsBodyBytes)
	if err := c.ShouldBindJSON(request); err != nil {
		response.Error(c, apperrors.Validation(map[string]string{
			"_request": "请求体必须是合法的 JSON 对象",
		}))
		return false
	}
	if err := h.validator.Struct(request); err != nil {
		response.Error(c, apperrors.Validation(validationFields(err)))
		return false
	}
	return true
}

func validationFields(err error) map[string]string {
	fields := make(map[string]string)
	var validationErrors validator.ValidationErrors
	if !errors.As(err, &validationErrors) {
		fields["_request"] = "请求参数不合法"
		return fields
	}
	for _, fieldError := range validationErrors {
		switch fieldError.Field() {
		case "Phone":
			fields["phone"] = "手机号须为有效的中国大陆 11 位手机号码"
		case "Nickname":
			fields["nickname"] = "昵称须为 2-32 个字符且不能包含控制字符"
		case "Password":
			fields["password"] = "密码长度须为 8-72 字节"
		}
	}
	return fields
}

func (h *Handler) setRefreshCookie(c *gin.Context, value string, expiresAt time.Time) {
	maxAge := int(expiresAt.Sub(h.now()).Seconds())
	if maxAge < 0 {
		maxAge = 0
	}
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     h.config.RefreshCookieName,
		Value:    value,
		Path:     "/api/auth",
		Expires:  expiresAt,
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   h.config.RefreshCookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (h *Handler) clearRefreshCookie(c *gin.Context) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     h.config.RefreshCookieName,
		Value:    "",
		Path:     "/api/auth",
		Expires:  time.Unix(1, 0),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   h.config.RefreshCookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (h *Handler) handleError(c *gin.Context, err error) {
	var appErr *apperrors.Error
	if errors.As(err, &appErr) {
		response.Error(c, appErr)
		return
	}
	h.logger.Error("request failed", "error", err)
	response.Error(c, apperrors.Internal())
}
