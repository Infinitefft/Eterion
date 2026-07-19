package middleware

import (
	"log/slog"
	"net/http"
	"runtime/debug"

	"github.com/gin-gonic/gin"
)

func Recovery(logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if recovered := recover(); recovered != nil {
				logger.Error("panic recovered",
					"request_id", RequestID(c),
					"error", recovered,
					"stack", string(debug.Stack()),
				)
				c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{
					"error": gin.H{
						"code":        "INTERNAL_ERROR",
						"message":     "服务暂时不可用",
						"next_action": "RETRY_LATER",
					},
					"request_id": RequestID(c),
				})
			}
		}()
		c.Next()
	}
}
