package eino

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
	"github.com/cloudwego/eino/components/model"
	einotool "github.com/cloudwego/eino/components/tool"
	toolutils "github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/schema"
)

type scriptedToolModel struct {
	mu    sync.Mutex
	calls int
}

func (m *scriptedToolModel) Generate(
	context.Context,
	[]*schema.Message,
	...model.Option,
) (*schema.Message, error) {
	return nil, errors.New("Generate should not be called in streaming mode")
}

func (m *scriptedToolModel) Stream(
	_ context.Context,
	input []*schema.Message,
	_ ...model.Option,
) (*schema.StreamReader[*schema.Message], error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.calls++
	if m.calls == 1 {
		return schema.StreamReaderFromArray([]*schema.Message{{
			Role: schema.Assistant,
			ToolCalls: []schema.ToolCall{{
				ID:   "call-1",
				Type: "function",
				Function: schema.FunctionCall{
					Name:      "web_search",
					Arguments: `{"query":"Eino"}`,
				},
			}},
		}}), nil
	}

	foundToolResult := false
	for _, message := range input {
		if message.Role == schema.Tool && message.ToolCallID == "call-1" {
			foundToolResult = true
			break
		}
	}
	if !foundToolResult {
		return nil, errors.New("tool result was not returned to the model")
	}

	return schema.StreamReaderFromArray([]*schema.Message{{
		Role:    schema.Assistant,
		Content: "这是搜索后的答案：https://example.com",
	}}), nil
}

func TestRunnerBindsAndExecutesTool(t *testing.T) {
	t.Parallel()

	searchTool, err := toolutils.InferTool(
		"web_search",
		"搜索网页",
		func(_ context.Context, input *struct {
			Query string `json:"query"`
		}) (*struct {
			URL string `json:"url"`
		}, error) {
			if input.Query != "Eino" {
				t.Fatalf("unexpected tool query: %q", input.Query)
			}
			return &struct {
				URL string `json:"url"`
			}{URL: "https://example.com"}, nil
		},
	)
	if err != nil {
		t.Fatalf("create in-memory tool: %v", err)
	}

	runner, err := newRunnerWithTools(
		context.Background(),
		&scriptedToolModel{},
		Config{ID: "model-1", Model: "provider-model"},
		[]einotool.BaseTool{searchTool},
	)
	if err != nil {
		t.Fatalf("create runner: %v", err)
	}

	var eventTypes []agent.EventType
	var completedTool *agent.ToolEvent
	var finalText string
	err = runner.Run(context.Background(), agent.Input{
		RunID:   "run-1",
		ChatID:  "chat-1",
		ModelID: "model-1",
		Messages: []agent.Message{
			{Role: "user", Content: "搜索 Eino"},
		},
	}, func(event agent.Event) error {
		eventTypes = append(eventTypes, event.Type)
		if event.Type == agent.EventToolCompleted {
			completedTool = event.Tool
		}
		if event.Type == agent.EventCompleted {
			finalText = event.FullText
		}
		return nil
	})
	if err != nil {
		t.Fatalf("run agent: %v", err)
	}

	wantTypes := []agent.EventType{
		agent.EventStarted,
		agent.EventToolStarted,
		agent.EventToolCompleted,
		agent.EventDelta,
		agent.EventCompleted,
	}
	if len(eventTypes) != len(wantTypes) {
		t.Fatalf("unexpected events: %v", eventTypes)
	}
	for index := range wantTypes {
		if eventTypes[index] != wantTypes[index] {
			t.Fatalf("unexpected events: %v", eventTypes)
		}
	}
	if completedTool == nil || completedTool.CallID != "call-1" {
		t.Fatalf("tool completion was not emitted: %+v", completedTool)
	}
	if finalText != "这是搜索后的答案：https://example.com" {
		t.Fatalf("unexpected final answer: %q", finalText)
	}
}
