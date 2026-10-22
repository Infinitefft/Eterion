package chat

import (
	"context"
	"net/http"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
	"github.com/Infinitefft/Eterion/services/api/internal/shared/response"
	"github.com/gin-gonic/gin"
)

func (h *Handler) RegisterPolishRoute(api *gin.RouterGroup, auth gin.HandlerFunc, polisher agent.PromptPolisher) {
	api.POST("/chat/prompt/polish", auth, func(c *gin.Context) {
		if _, ok := h.identity(c); !ok {
			return
		}
		var input struct {
			Content string `json:"content"`
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		if err := c.ShouldBindJSON(&input); err != nil {
			h.writeError(c, invalidEnvelope("请求体必须包含提示词 content"))
			return
		}
		content := strings.TrimSpace(input.Content)
		// 与浏览器和 Agent 的字符串长度保持一致（UTF-16）。
		if content == "" || len(utf16.Encode([]rune(content))) > 8000 {
			h.writeError(c, invalidEnvelope("请输入 1 至 8000 字符的提示词"))
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 32*time.Second)
		defer cancel()
		polished, err := polisher.PolishPrompt(ctx, content)
		if err != nil {
			h.writeError(c, newBusinessError("PROMPT_POLISH_FAILED", "润色未完成，请稍后重试", true, http.StatusBadGateway))
			return
		}
		response.JSON(c, http.StatusOK, gin.H{"content": polished})
	})
}
