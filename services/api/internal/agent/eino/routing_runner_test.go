package eino

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
)

func TestRoutingRunnerSelectsConfiguredTextModel(t *testing.T) {
	t.Parallel()

	type capturedRequest struct {
		authorization string
		model         string
		path          string
	}
	captured := make(chan capturedRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			http.Error(writer, err.Error(), http.StatusBadRequest)
			return
		}
		captured <- capturedRequest{
			authorization: request.Header.Get("Authorization"),
			model:         body.Model,
			path:          request.URL.Path,
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(writer, "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"provider-model\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好\"}}]}\n\n")
		_, _ = io.WriteString(writer, "data: [DONE]\n\n")
	}))
	defer server.Close()

	runner, err := NewRoutingRunner(context.Background(), []Config{
		{
			ID:           "doubao-seed-2-1-pro",
			ModelName:    "Doubao-Seed-2.1-pro",
			Provider:     "doubao",
			ProviderName: "豆包",
			IconURL:      "https://www.doubao.com/favicon.ico",
			APIKey:       "doubao-key",
			BaseURL:      server.URL + "/v1",
			Model:        "doubao-model",
			SystemPrompt: "system",
		},
		{
			ID:           "deepseek-v4-pro",
			ModelName:    "DeepSeek-V4-Pro",
			Provider:     "deepseek",
			ProviderName: "DeepSeek",
			IconURL:      "https://www.deepseek.com/favicon.ico",
			APIKey:       "deepseek-key",
			BaseURL:      server.URL + "/v1",
			Model:        "deepseek-model",
			SystemPrompt: "system",
		},
	}, "doubao-seed-2-1-pro")
	if err != nil {
		t.Fatalf("create routing runner: %v", err)
	}
	models := runner.Models()
	if len(models) != 2 {
		t.Fatalf("unexpected model count: %d", len(models))
	}
	var deepseekInfo *agent.ModelInfo
	for index := range models {
		if models[index].ID == "deepseek-v4-pro" {
			deepseekInfo = &models[index]
			break
		}
	}
	if deepseekInfo == nil {
		t.Fatal("deepseek model info is missing")
	}
	if deepseekInfo.ModelName != "DeepSeek-V4-Pro" ||
		deepseekInfo.ProviderName != "DeepSeek" ||
		deepseekInfo.IconURL != "https://www.deepseek.com/favicon.ico" {
		t.Fatalf("unexpected public model info: %+v", *deepseekInfo)
	}

	var text strings.Builder
	err = runner.Run(context.Background(), agent.Input{
		RunID:   "run-1",
		ChatID:  "chat-1",
		ModelID: "deepseek-v4-pro",
		Messages: []agent.Message{
			{Role: "user", Content: "你好"},
		},
	}, func(event agent.Event) error {
		if event.Type == agent.EventDelta {
			text.WriteString(event.Delta)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("run selected model: %v", err)
	}
	if text.String() != "你好" {
		t.Fatalf("unexpected streamed text: %q", text.String())
	}

	request := <-captured
	if request.authorization != "Bearer deepseek-key" {
		t.Fatalf("unexpected authorization: %q", request.authorization)
	}
	if request.model != "deepseek-model" {
		t.Fatalf("unexpected provider model: %q", request.model)
	}
	if request.path != "/v1/chat/completions" {
		t.Fatalf("unexpected request path: %q", request.path)
	}
}
