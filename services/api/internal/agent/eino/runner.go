// Package eino adapts CloudWeGo Eino to Eterion's Agent execution contract.
package eino

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
	"github.com/cloudwego/eino-ext/components/model/openai"
	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"
)

const (
	emptyResponseCode    = "AGENT_EMPTY_RESPONSE"
	modelRequestFailCode = "MODEL_REQUEST_FAILED"
)

// Config configures the Eino model and the maximum duration of one Agent run.
type Config struct {
	ID           string
	ModelName    string
	Provider     string
	ProviderName string
	IconURL      string
	APIKey       string
	BaseURL      string
	Model        string
	SystemPrompt string
	ModelTimeout time.Duration
	RunTimeout   time.Duration
}

// Runner executes the current single-model Agent workflow through Eino.
// The model is created once and is safe to reuse across concurrent chat runs.
type Runner struct {
	model        model.BaseChatModel
	modelID      string
	systemPrompt string
	runTimeout   time.Duration
}

// NewRunner constructs an Eino Runner backed by an OpenAI-compatible model.
func NewRunner(ctx context.Context, config Config) (*Runner, error) {
	if strings.TrimSpace(config.APIKey) == "" {
		return nil, errors.New("model API key is required")
	}
	if strings.TrimSpace(config.Model) == "" {
		return nil, errors.New("model name is required")
	}

	chatModel, err := openai.NewChatModel(ctx, &openai.ChatModelConfig{
		APIKey:  config.APIKey,
		BaseURL: config.BaseURL,
		Model:   config.Model,
		Timeout: config.ModelTimeout,
	})
	if err != nil {
		return nil, fmt.Errorf("create Eino chat model: %w", err)
	}

	return newRunner(chatModel, config), nil
}

func newRunner(chatModel model.BaseChatModel, config Config) *Runner {
	modelID := strings.TrimSpace(config.ID)
	if modelID == "" {
		modelID = config.Model
	}
	return &Runner{
		model:        chatModel,
		modelID:      modelID,
		systemPrompt: config.SystemPrompt,
		runTimeout:   config.RunTimeout,
	}
}

// Run converts persisted chat history to Eino messages and streams model text
// back through the application-owned Agent event protocol.
func (r *Runner) Run(
	ctx context.Context,
	input agent.Input,
	handle func(agent.Event) error,
) error {
	if err := validateInput(input); err != nil {
		return err
	}

	runContext := ctx
	cancel := func() {}
	if r.runTimeout > 0 {
		runContext, cancel = context.WithTimeout(ctx, r.runTimeout)
	}
	defer cancel()

	if err := handle(agent.Event{
		Type:  agent.EventStarted,
		Model: r.modelID,
	}); err != nil {
		return err
	}

	stream, err := r.model.Stream(runContext, r.toEinoMessages(input.Messages))
	if err != nil {
		return r.modelFailure(runContext, "start Eino model stream", err)
	}
	defer stream.Close()

	var fullText strings.Builder
	for {
		chunk, receiveErr := stream.Recv()
		if errors.Is(receiveErr, io.EOF) {
			break
		}
		if receiveErr != nil {
			return r.modelFailure(runContext, "receive Eino model stream", receiveErr)
		}
		if chunk == nil || chunk.Content == "" {
			continue
		}

		fullText.WriteString(chunk.Content)
		if err := handle(agent.Event{
			Type:  agent.EventDelta,
			Delta: chunk.Content,
		}); err != nil {
			return err
		}
	}

	result := fullText.String()
	if strings.TrimSpace(result) == "" {
		return &agent.Failure{
			Code:      emptyResponseCode,
			Message:   "模型没有返回有效文本",
			Retryable: false,
		}
	}

	return handle(agent.Event{
		Type:     agent.EventCompleted,
		FullText: result,
	})
}

func (r *Runner) toEinoMessages(messages []agent.Message) []*schema.Message {
	result := make([]*schema.Message, 0, len(messages)+1)
	if strings.TrimSpace(r.systemPrompt) != "" {
		result = append(result, schema.SystemMessage(r.systemPrompt))
	}

	for _, message := range messages {
		switch strings.ToLower(strings.TrimSpace(message.Role)) {
		case "system":
			result = append(result, schema.SystemMessage(message.Content))
		case "user":
			result = append(result, schema.UserMessage(message.Content))
		case "assistant":
			result = append(result, schema.AssistantMessage(message.Content, nil))
		}
	}
	return result
}

func (r *Runner) modelFailure(ctx context.Context, operation string, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return &agent.Failure{
		Code:      modelRequestFailCode,
		Message:   "模型调用失败",
		Retryable: false,
		Cause:     fmt.Errorf("%s: %w", operation, err),
	}
}

// Close exists for the shared Runner lifecycle. The in-process Eino model has
// no transport connection that needs explicit shutdown.
func (r *Runner) Close() error {
	return nil
}

func validateInput(input agent.Input) error {
	if strings.TrimSpace(input.RunID) == "" {
		return errors.New("run ID is required")
	}
	if strings.TrimSpace(input.ChatID) == "" {
		return errors.New("chat ID is required")
	}
	if len(input.Messages) == 0 {
		return errors.New("messages cannot be empty")
	}

	for _, message := range input.Messages {
		switch strings.ToLower(strings.TrimSpace(message.Role)) {
		case "system", "user", "assistant":
		default:
			return fmt.Errorf("unsupported message role: %s", message.Role)
		}
	}
	lastRole := strings.ToLower(strings.TrimSpace(input.Messages[len(input.Messages)-1].Role))
	if lastRole != "user" {
		return errors.New("the last message must be a user message")
	}
	return nil
}

var _ agent.Runner = (*Runner)(nil)
