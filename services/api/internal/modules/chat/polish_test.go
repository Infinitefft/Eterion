package chat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
	"github.com/Infinitefft/Eterion/services/api/internal/agent/remote"
	"github.com/Infinitefft/Eterion/services/api/internal/modules/auth"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type polishFunc func(context.Context, string) (string, error)

func (f polishFunc) PolishPrompt(ctx context.Context, text string) (string, error) {
	return f(ctx, text)
}

func polishTestRouter(polisher agent.PromptPolisher) *gin.Engine {
	router := gin.New()
	handler := &Handler{}
	handler.RegisterPolishRoute(router.Group("/api"), func(c *gin.Context) {
		c.Set("eterion.auth.identity", &auth.Identity{UserID: uuid.New()})
	}, polisher)
	return router
}

func TestPromptPolishValidationAndFailure(t *testing.T) {
	for _, item := range []struct {
		name, content string
		fail          bool
		want          int
	}{
		{"valid", "整理我的项目介绍", false, http.StatusOK},
		{"short", "a", false, http.StatusOK},
		{"empty", "   ", false, http.StatusBadRequest},
		{"utf16 limit", strings.Repeat("😀", 4001), false, http.StatusBadRequest},
		{"model failure", "保留我的原文", true, http.StatusBadGateway},
	} {
		t.Run(item.name, func(t *testing.T) {
			calls := 0
			router := polishTestRouter(polishFunc(func(ctx context.Context, content string) (string, error) {
				calls++
				if _, ok := ctx.Deadline(); !ok {
					t.Error("missing deadline")
				}
				if item.fail {
					return "", errors.New("model failed")
				}
				return content, nil
			}))
			body, _ := json.Marshal(map[string]string{"content": item.content, "model_id": "ignored-chat-model"})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/chat/prompt/polish", strings.NewReader(string(body))))
			if response.Code != item.want {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if item.want == http.StatusBadRequest && calls != 0 {
				t.Fatal("invalid input reached model")
			}
			if item.want == http.StatusOK && !strings.Contains(response.Body.String(), `"content":`) {
				t.Fatal("missing content")
			}
		})
	}
}

// 显式指定本地 Agent 时才调用真实模型；默认测试不消耗模型额度。
func TestPromptPolishLive(t *testing.T) {
	url := os.Getenv("POLISH_LIVE_AGENT_URL")
	if url == "" {
		t.Skip("set POLISH_LIVE_AGENT_URL to validate real model")
	}
	runner, err := remote.NewRunner(context.Background(), remote.Config{BaseURL: url})
	if err != nil {
		t.Fatal(err)
	}
	defer runner.Close()
	router := polishTestRouter(runner)
	for _, content := range []string{"帮我把前端AI聊天项目写成面试自我介绍，200字以内，不编造经历", "a"} {
		body, _ := json.Marshal(map[string]string{"content": content})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/chat/prompt/polish", strings.NewReader(string(body))))
		if response.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
		var result struct {
			Data struct {
				Content string `json:"content"`
			} `json:"data"`
		}
		if json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Data.Content == "" {
			t.Fatal("empty result")
		}
		t.Logf("input=%s output=%s", content, result.Data.Content)
	}
}
