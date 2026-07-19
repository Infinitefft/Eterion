package auth

import (
	"net/http"
	"strings"

	apperrors "github.com/Infinitefft/Eterion/services/api/internal/shared/errors"
	"github.com/gin-gonic/gin"
)

const identityContextKey = "eterion.auth.identity"

func (h *Handler) RequireAccessToken() gin.HandlerFunc {
	return func(c *gin.Context) {
		rawAccessToken, err := bearerToken(c.GetHeader("Authorization"))
		if err != nil {
			h.handleError(c, err)
			return
		}

		identity, err := h.service.AuthenticateAccess(c.Request.Context(), rawAccessToken)
		if err != nil {
			h.handleError(c, err)
			return
		}

		c.Set(identityContextKey, identity)
		c.Next()
	}
}

func IdentityFromContext(c *gin.Context) (*Identity, bool) {
	value, exists := c.Get(identityContextKey)
	if !exists {
		return nil, false
	}
	identity, ok := value.(*Identity)
	return identity, ok && identity != nil
}

func bearerToken(header string) (string, error) {
	if strings.TrimSpace(header) == "" {
		return "", apperrors.New(
			http.StatusUnauthorized,
			"AUTH_ACCESS_MISSING",
			"缺少访问凭证",
			"LOGIN_REQUIRED",
		)
	}
	parts := strings.Fields(header)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
		return "", invalidAccessError()
	}
	return parts[1], nil
}
