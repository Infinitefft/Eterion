package eino

import (
	"context"
	"errors"
	"testing"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"
)

type fakeChatModel struct {
	input     []*schema.Message
	chunks    []*schema.Message
	streamErr error
}

func (m *fakeChatModel) Generate(
	context.Context,
	[]*schema.Message,
	...model.Option,
) (*schema.Message, error) {
	return nil, errors.New("Generate is not used by the streaming runner")
}

func (m *fakeChatModel) Stream(
	_ context.Context,
	input []*schema.Message,
	_ ...model.Option,
) (*schema.StreamReader[*schema.Message], error) {
	m.input = input
	if m.streamErr != nil {
		return nil, m.streamErr
	}
	return schema.StreamReaderFromArray(m.chunks), nil
}

func TestRunnerStreamsEinoModelEvents(t *testing.T) {
	chatModel := &fakeChatModel{chunks: []*schema.Message{
		{Role: schema.Assistant, Content: "你"},
		{Role: schema.Assistant, Content: "好"},
	}}
	runner := newRunner(chatModel, Config{
		Model:        "fake-model",
		SystemPrompt: "system prompt",
	})

	received := make([]agent.Event, 0, 4)
	err := runner.Run(context.Background(), validInput(), func(event agent.Event) error {
		received = append(received, event)
		return nil
	})
	if err != nil {
		t.Fatalf("run Eino stream: %v", err)
	}
	if len(received) != 4 {
		t.Fatalf("unexpected event count: %d", len(received))
	}
	if received[0].Type != agent.EventStarted || received[0].Model != "fake-model" {
		t.Fatalf("unexpected started event: %#v", received[0])
	}
	if received[1].Delta != "你" || received[2].Delta != "好" {
		t.Fatalf("unexpected delta events: %#v", received)
	}
	if received[3].Type != agent.EventCompleted || received[3].FullText != "你好" {
		t.Fatalf("unexpected completed event: %#v", received[3])
	}

	if len(chatModel.input) != 3 {
		t.Fatalf("unexpected model input count: %d", len(chatModel.input))
	}
	if chatModel.input[0].Role != schema.System || chatModel.input[0].Content != "system prompt" {
		t.Fatalf("unexpected system message: %#v", chatModel.input[0])
	}
	if chatModel.input[1].Role != schema.Assistant || chatModel.input[2].Role != schema.User {
		t.Fatalf("unexpected converted roles: %#v", chatModel.input)
	}
}

func TestRunnerRejectsInvalidInputBeforeStarting(t *testing.T) {
	chatModel := &fakeChatModel{}
	runner := newRunner(chatModel, Config{Model: "fake-model"})
	input := validInput()
	input.Messages[len(input.Messages)-1].Role = "tool"

	handled := false
	err := runner.Run(context.Background(), input, func(agent.Event) error {
		handled = true
		return nil
	})
	if err == nil || handled {
		t.Fatalf("expected validation failure before events, got error=%v handled=%v", err, handled)
	}
}

func TestRunnerReturnsStructuredEmptyResponse(t *testing.T) {
	runner := newRunner(&fakeChatModel{chunks: []*schema.Message{{
		Role: schema.Assistant, Content: "  ",
	}}}, Config{Model: "fake-model"})

	err := runner.Run(context.Background(), validInput(), func(agent.Event) error { return nil })
	var failure *agent.Failure
	if !errors.As(err, &failure) || failure.Code != emptyResponseCode {
		t.Fatalf("expected empty response failure, got %v", err)
	}
}

func TestRunnerSanitizesModelFailure(t *testing.T) {
	providerError := errors.New("provider included sensitive request details")
	runner := newRunner(&fakeChatModel{streamErr: providerError}, Config{Model: "fake-model"})

	err := runner.Run(context.Background(), validInput(), func(agent.Event) error { return nil })
	var failure *agent.Failure
	if !errors.As(err, &failure) {
		t.Fatalf("expected structured failure, got %v", err)
	}
	if failure.Code != modelRequestFailCode || failure.Message != "模型调用失败" {
		t.Fatalf("unexpected client-safe failure: %#v", failure)
	}
	if !errors.Is(err, providerError) {
		t.Fatalf("provider error was not retained for diagnostics: %v", err)
	}
}

func validInput() agent.Input {
	return agent.Input{
		RunID:  "run-1",
		ChatID: "chat-1",
		Messages: []agent.Message{
			{Role: "assistant", Content: "previous"},
			{Role: "user", Content: "你好"},
		},
	}
}

var _ model.BaseChatModel = (*fakeChatModel)(nil)
