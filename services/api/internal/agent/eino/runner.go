// Package eino adapts CloudWeGo Eino to Eterion's Agent execution contract.
package eino

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
	agenttools "github.com/Infinitefft/Eterion/services/api/internal/agent/tools"
	"github.com/cloudwego/eino-ext/components/model/openai"
	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/components/model"
	einotool "github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/schema"
)

const (
	emptyResponseCode    = "AGENT_EMPTY_RESPONSE"
	modelRequestFailCode = "MODEL_REQUEST_FAILED"
	toolRequestFailCode  = "TOOL_REQUEST_FAILED"
)

// Config configures the Eino model, its tools and one Agent run's duration.
type Config struct {
	ID                string
	ModelName         string
	Provider          string
	ProviderName      string
	IconURL           string
	APIKey            string
	BaseURL           string
	Model             string
	SystemPrompt      string
	BraveSearchAPIKey string
	ModelTimeout      time.Duration
	RunTimeout        time.Duration
}

// Runner executes a model-plus-tools workflow through Eino ADK.
type Runner struct {
	// agentRunner owns the complete loop: model -> tool -> model.
	agentRunner *adk.Runner

	// modelID is the public model identifier included in run events.
	modelID string

	// runTimeout limits the whole loop, including outbound tool requests.
	runTimeout time.Duration
}

// NewRunner constructs an Eino Runner backed by an OpenAI-compatible model.
func NewRunner(ctx context.Context, config Config) (*Runner, error) {
	// A provider API key is needed before Eino can create the chat model.
	if strings.TrimSpace(config.APIKey) == "" {
		return nil, errors.New("model API key is required")
	}

	// The provider-side model name is also required.
	if strings.TrimSpace(config.Model) == "" {
		return nil, errors.New("model name is required")
	}

	// Create the existing OpenAI-compatible Eino model adapter.
	chatModel, err := openai.NewChatModel(ctx, &openai.ChatModelConfig{
		APIKey:  config.APIKey,
		BaseURL: config.BaseURL,
		Model:   config.Model,
		Timeout: config.ModelTimeout,
	})
	if err != nil {
		return nil, fmt.Errorf("create Eino chat model: %w", err)
	}

	// Start with an empty tool list so search remains optional in local development.
	registeredTools := make([]einotool.BaseTool, 0, 1)

	// Register web_search only when its server-side credential is configured.
	if strings.TrimSpace(config.BraveSearchAPIKey) != "" {
		// Construct the executable search tool.
		webSearch, err := agenttools.NewWebSearch(config.BraveSearchAPIKey)
		if err != nil {
			return nil, fmt.Errorf("create web search tool: %w", err)
		}

		// Add it to the exact list that Eino will bind to the model.
		registeredTools = append(registeredTools, webSearch)
	}

	// Bind the model and all configured tools into an ADK Agent.
	return newRunnerWithTools(ctx, chatModel, config, registeredTools)
}

// newRunnerWithTools is separated from NewRunner so the Agent loop can be tested
// with an in-memory tool while production still uses the real Brave Search tool.
func newRunnerWithTools(
	ctx context.Context,
	chatModel model.BaseChatModel,
	config Config,
	registeredTools []einotool.BaseTool,
) (*Runner, error) {
	// ChatModelAgent performs Eino's standard ReAct loop automatically.
	chatAgent, err := adk.NewChatModelAgent(ctx, &adk.ChatModelAgentConfig{
		// Name identifies this Agent inside Eino traces.
		Name: "eterion_chat_agent",

		// Description documents the Agent's responsibility.
		Description: "Eterion 的通用对话助手，可以在需要时调用工具。",

		// Instruction becomes the system message sent before conversation history.
		Instruction: config.SystemPrompt,

		// Model is the OpenAI-compatible model created above.
		Model: chatModel,

		// ToolsNodeConfig is the actual point where tools are bound to the model.
		ToolsConfig: adk.ToolsConfig{
			ToolsNodeConfig: compose.ToolsNodeConfig{
				Tools: registeredTools,
			},
		},

		// Stop accidental endless model/tool loops after five model generations.
		MaxIterations: 5,
	})
	if err != nil {
		return nil, fmt.Errorf("create Eino chat agent: %w", err)
	}

	// EnableStreaming asks Eino to expose each model/tool turn as it happens.
	adkRunner := adk.NewRunner(ctx, adk.RunnerConfig{
		Agent:           chatAgent,
		EnableStreaming: true,
	})

	// Prefer the stable public ID; fall back to the provider model name.
	modelID := strings.TrimSpace(config.ID)
	if modelID == "" {
		modelID = config.Model
	}

	// Return the reusable, concurrency-safe Agent runner.
	return &Runner{
		agentRunner: adkRunner,
		modelID:     modelID,
		runTimeout:  config.RunTimeout,
	}, nil
}

// Run converts persisted chat history to Eino messages and forwards model and
// tool events through the application's provider-independent event protocol.
func (r *Runner) Run(
	ctx context.Context,
	input agent.Input,
	handle func(agent.Event) error,
) error {
	// Reject malformed run input before contacting a model provider.
	if err := validateInput(input); err != nil {
		return err
	}

	// Reuse the caller context when no custom run timeout was configured.
	runContext := ctx

	// Default cancellation is a no-op for the no-timeout path.
	cancel := func() {}

	// Apply one deadline to both model generations and every tool call.
	if r.runTimeout > 0 {
		runContext, cancel = context.WithTimeout(ctx, r.runTimeout)
	}

	// Release the timer as soon as this run finishes.
	defer cancel()

	// Tell the chat module that Agent execution has begun.
	if err := handle(agent.Event{
		Type:  agent.EventStarted,
		Model: r.modelID,
	}); err != nil {
		return err
	}

	// Convert application messages once and start Eino's model/tool loop.
	events := r.agentRunner.Run(runContext, r.toEinoMessages(input.Messages))

	// Keep the model's final user-facing answer separate from tool-call messages.
	var fullText strings.Builder

	// Remember unfinished calls so a later tool result can complete the same UI step.
	pendingTools := make(map[string]agent.ToolEvent)

	// Consume Agent events until Eino finishes the complete ReAct loop.
	for {
		// Next returns false after the Agent has no more events.
		adkEvent, ok := events.Next()
		if !ok {
			break
		}

		// A nil event has no information for the application.
		if adkEvent == nil {
			continue
		}

		// Eino reports model and tool execution errors on the Agent event.
		if adkEvent.Err != nil {
			failure := r.toolOrModelFailure(runContext, adkEvent.Err, len(pendingTools) > 0)

			// Mark every still-running frontend step as failed.
			for _, pending := range pendingTools {
				failed := pending
				failed.Error = failure
				if err := handle(agent.Event{
					Type: agent.EventToolFailed,
					Tool: &failed,
				}); err != nil {
					return err
				}
			}

			return failure
		}

		// Events without a message output are control events we do not expose yet.
		if adkEvent.Output == nil || adkEvent.Output.MessageOutput == nil {
			continue
		}

		// GetMessage also joins Eino's streamed chunks into one complete turn.
		message, err := adkEvent.Output.MessageOutput.GetMessage()
		if err != nil {
			return r.modelFailure(runContext, "read Eino Agent event", err)
		}

		// Ignore empty messages defensively.
		if message == nil {
			continue
		}

		// Assistant messages either request tools or contain the final answer.
		if adkEvent.Output.MessageOutput.Role == schema.Assistant {
			// A ToolCalls array means Eino will execute these functions next.
			if len(message.ToolCalls) > 0 {
				for _, call := range message.ToolCalls {
					// Decode the model-generated JSON so the frontend receives an object.
					toolInput := decodeJSONValue(call.Function.Arguments)

					// Store the machine ID, readable label and original arguments together.
					toolEvent := agent.ToolEvent{
						CallID: call.ID,
						ID:     call.Function.Name,
						Name:   toolDisplayName(call.Function.Name),
						Input:  toolInput,
					}

					// Save it before notifying consumers, ready for the result event.
					pendingTools[call.ID] = toolEvent

					// Emit a running tool step for immediate frontend rendering.
					started := toolEvent
					if err := handle(agent.Event{
						Type: agent.EventToolStarted,
						Tool: &started,
					}); err != nil {
						return err
					}
				}

				// Tool-call assistant content is not part of the final user answer.
				continue
			}

			// Skip empty assistant turns.
			if message.Content == "" {
				continue
			}

			// Accumulate the final assistant answer returned after all tools finish.
			fullText.WriteString(message.Content)

			// Forward this completed model turn through the existing delta protocol.
			if err := handle(agent.Event{
				Type:  agent.EventDelta,
				Delta: message.Content,
			}); err != nil {
				return err
			}

			continue
		}

		// Tool messages contain the JSON/string result produced by an invoked tool.
		if adkEvent.Output.MessageOutput.Role == schema.Tool {
			// Find the matching request using Eino's ToolCallID.
			toolEvent, exists := pendingTools[message.ToolCallID]
			if !exists {
				// Unknown internal tool messages cannot update an existing frontend step.
				continue
			}

			// Convert JSON tool output into an object or array for the frontend.
			toolEvent.Output = decodeJSONValue(message.Content)

			// Emit the completed form of the same tool step.
			completed := toolEvent
			if err := handle(agent.Event{
				Type: agent.EventToolCompleted,
				Tool: &completed,
			}); err != nil {
				return err
			}

			// This call no longer needs failure tracking.
			delete(pendingTools, message.ToolCallID)
		}
	}

	// A successful Agent run must include a visible final assistant answer.
	result := fullText.String()
	if strings.TrimSpace(result) == "" {
		return &agent.Failure{
			Code:      emptyResponseCode,
			Message:   "模型没有返回有效文本",
			Retryable: false,
		}
	}

	// Finish the application-level run with the complete answer.
	return handle(agent.Event{
		Type:     agent.EventCompleted,
		FullText: result,
	})
}

// toEinoMessages converts application-owned roles to Eino's schema.
func (r *Runner) toEinoMessages(messages []agent.Message) []*schema.Message {
	// The system prompt is added by ChatModelAgent.Instruction, so only history goes here.
	result := make([]*schema.Message, 0, len(messages))

	// Preserve every supported conversation message in order.
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

// decodeJSONValue turns JSON strings into normal objects for WebSocket transport.
func decodeJSONValue(raw string) any {
	// Keep a generic value because each future tool can define a different schema.
	var value any

	// Use decoded JSON whenever possible.
	if err := json.Unmarshal([]byte(raw), &value); err == nil {
		return value
	}

	// Preserve non-JSON tool output as text instead of losing it.
	return raw
}

// toolDisplayName maps stable tool IDs to labels suitable for the current Chinese UI.
func toolDisplayName(toolID string) string {
	// Give the first real tool a concise readable label.
	if toolID == agenttools.WebSearchName {
		return "网页搜索"
	}

	// Unknown future tools still render with their registered ID.
	return toolID
}

// toolOrModelFailure creates a safe public error while preserving the original cause.
func (r *Runner) toolOrModelFailure(
	ctx context.Context,
	err error,
	duringTool bool,
) *agent.Failure {
	// Context cancellation has its own handling in RunManager.
	if ctx.Err() != nil {
		return &agent.Failure{
			Code:      modelRequestFailCode,
			Message:   "模型调用已中断",
			Retryable: true,
			Cause:     ctx.Err(),
		}
	}

	// A pending call means the current failure came from the model/tool loop.
	if duringTool {
		return &agent.Failure{
			Code:      toolRequestFailCode,
			Message:   "工具调用失败",
			Retryable: true,
			Cause:     err,
		}
	}

	// Otherwise report the existing model-provider failure category.
	return &agent.Failure{
		Code:      modelRequestFailCode,
		Message:   "模型调用失败",
		Retryable: false,
		Cause:     fmt.Errorf("run Eino Agent: %w", err),
	}
}

// modelFailure converts provider errors into the application's safe failure type.
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

// Close exists for the shared Runner lifecycle. Eino owns no connection here.
func (r *Runner) Close() error {
	return nil
}

// validateInput checks the application contract before an Agent run starts.
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
