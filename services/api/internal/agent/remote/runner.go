// Package remote adapts the Python Agent service to Eterion's Agent contract.
package remote

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
)

const (
	agentProtocolErrorCode    = "AGENT_PROTOCOL_ERROR"
	agentServiceErrorCode     = "AGENT_SERVICE_ERROR"
	agentServiceUnavailable   = "AGENT_SERVICE_UNAVAILABLE"
	emptyResponseCode         = "AGENT_EMPTY_RESPONSE"
	modelNotAvailableCode     = "MODEL_NOT_AVAILABLE"
	maximumSSEEventSize       = 4 << 20
	maximumErrorResponseBytes = 64 << 10
)

// Config describes the private HTTP boundary between the Go API and Python Agent.
type Config struct {
	BaseURL        string
	ConnectTimeout time.Duration
	RunTimeout     time.Duration
}

// Runner streams Agent events from the Python service and owns its model catalog.
type Runner struct {
	baseURL        *url.URL
	client         *http.Client
	runTimeout     time.Duration
	defaultModelID string
	models         []agent.ModelInfo
	modelIDs       map[string]struct{}
}

type modelCatalogResponse struct {
	DefaultModelID string            `json:"default_model_id"`
	Models         []agent.ModelInfo `json:"models"`
}

type runRequest struct {
	RunID    string          `json:"run_id"`
	ChatID   string          `json:"chat_id"`
	ModelID  string          `json:"model_id"`
	Messages []agent.Message `json:"messages"`
}

type streamPayload struct {
	Model    string         `json:"model"`
	Delta    string         `json:"delta"`
	FullText string         `json:"full_text"`
	Tool     *streamTool    `json:"tool"`
	Error    *streamFailure `json:"error"`
}

type streamTool struct {
	CallID string         `json:"call_id"`
	ID     string         `json:"id"`
	Name   string         `json:"name"`
	Input  any            `json:"input"`
	Output any            `json:"output"`
	Error  *streamFailure `json:"error"`
}

type streamFailure struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// NewRunner verifies the Python service and takes a startup snapshot of its models.
func NewRunner(ctx context.Context, config Config) (*Runner, error) {
	baseURL, err := parseBaseURL(config.BaseURL)
	if err != nil {
		return nil, err
	}

	connectTimeout := config.ConnectTimeout
	if connectTimeout <= 0 {
		connectTimeout = 5 * time.Second
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	runner := &Runner{
		baseURL:    baseURL,
		client:     &http.Client{Transport: transport},
		runTimeout: config.RunTimeout,
	}

	catalogContext, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	if err := runner.loadCatalog(catalogContext); err != nil {
		transport.CloseIdleConnections()
		return nil, fmt.Errorf("load Python Agent model catalog: %w", err)
	}
	return runner, nil
}

func parseBaseURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("Agent service URL is required")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("parse Agent service URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("Agent service URL must use http or https")
	}
	if parsed.Host == "" {
		return nil, errors.New("Agent service URL must include a host")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("Agent service URL cannot include credentials, query, or fragment")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return parsed, nil
}

func (r *Runner) loadCatalog(ctx context.Context) error {
	request, err := r.newRequest(ctx, http.MethodGet, "/models", nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")

	response, err := r.client.Do(request)
	if err != nil {
		return serviceFailure("request model catalog", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return responseStatusError(response)
	}

	var catalog modelCatalogResponse
	decoder := json.NewDecoder(io.LimitReader(response.Body, maximumSSEEventSize))
	if err := decoder.Decode(&catalog); err != nil {
		return fmt.Errorf("decode model catalog: %w", err)
	}
	if len(catalog.Models) == 0 {
		return errors.New("Python Agent returned an empty model catalog")
	}

	modelIDs := make(map[string]struct{}, len(catalog.Models))
	for index := range catalog.Models {
		catalog.Models[index].ID = strings.TrimSpace(catalog.Models[index].ID)
		if catalog.Models[index].ID == "" {
			return errors.New("Python Agent returned a model without an ID")
		}
		if _, exists := modelIDs[catalog.Models[index].ID]; exists {
			return fmt.Errorf("Python Agent returned duplicate model ID %q", catalog.Models[index].ID)
		}
		modelIDs[catalog.Models[index].ID] = struct{}{}
	}
	catalog.DefaultModelID = strings.TrimSpace(catalog.DefaultModelID)
	if _, exists := modelIDs[catalog.DefaultModelID]; !exists {
		return fmt.Errorf("Python Agent returned unknown default model %q", catalog.DefaultModelID)
	}

	sort.SliceStable(catalog.Models, func(left, right int) bool {
		return catalog.Models[left].ID < catalog.Models[right].ID
	})
	r.defaultModelID = catalog.DefaultModelID
	r.models = catalog.Models
	r.modelIDs = modelIDs
	return nil
}

// Run posts persisted history and converts the SSE stream into application events.
func (r *Runner) Run(
	ctx context.Context,
	input agent.Input,
	handle func(agent.Event) error,
) error {
	modelID, ok := r.ResolveModelID(input.ModelID)
	if !ok {
		return &agent.Failure{
			Code:      modelNotAvailableCode,
			Message:   "所选模型不可用",
			Retryable: false,
		}
	}
	input.ModelID = modelID

	runContext := ctx
	cancel := func() {}
	if r.runTimeout > 0 {
		runContext, cancel = context.WithTimeout(ctx, r.runTimeout)
	}
	defer cancel()

	body, err := json.Marshal(runRequest{
		RunID: input.RunID, ChatID: input.ChatID, ModelID: input.ModelID, Messages: input.Messages,
	})
	if err != nil {
		return fmt.Errorf("encode Agent run request: %w", err)
	}
	request, err := r.newRequest(runContext, http.MethodPost, "/runs", bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("Content-Type", "application/json")

	response, err := r.client.Do(request)
	if err != nil {
		if runContext.Err() != nil {
			return runContextFailure(ctx, runContext)
		}
		return serviceFailure("start Agent run", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return responseStatusError(response)
	}
	if !strings.HasPrefix(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		return protocolFailure("Python Agent did not return an SSE stream", nil)
	}

	completed := false
	fullText := ""
	err = consumeSSE(response.Body, func(eventName string, data []byte) error {
		var payload streamPayload
		if err := json.Unmarshal(data, &payload); err != nil {
			return protocolFailure("Python Agent returned invalid event JSON", err)
		}

		switch eventName {
		case "started":
			return handle(agent.Event{Type: agent.EventStarted, Model: payload.Model})
		case "content_delta":
			if payload.Delta == "" {
				return nil
			}
			fullText += payload.Delta
			return handle(agent.Event{Type: agent.EventDelta, Delta: payload.Delta})
		case "tool_started":
			tool, err := decodeTool(payload.Tool, false)
			if err != nil {
				return err
			}
			return handle(agent.Event{Type: agent.EventToolStarted, Tool: tool})
		case "tool_completed":
			tool, err := decodeTool(payload.Tool, false)
			if err != nil {
				return err
			}
			return handle(agent.Event{Type: agent.EventToolCompleted, Tool: tool})
		case "tool_failed":
			tool, err := decodeTool(payload.Tool, true)
			if err != nil {
				return err
			}
			return handle(agent.Event{Type: agent.EventToolFailed, Tool: tool})
		case "completed":
			if strings.TrimSpace(payload.FullText) == "" {
				return &agent.Failure{Code: emptyResponseCode, Message: "模型没有返回有效文本"}
			}
			completed = true
			fullText = payload.FullText
			return handle(agent.Event{Type: agent.EventCompleted, FullText: payload.FullText})
		case "error":
			if payload.Error == nil || payload.Error.Code == "" {
				return protocolFailure("Python Agent returned an invalid error event", nil)
			}
			return &agent.Failure{
				Code: payload.Error.Code, Message: payload.Error.Message, Retryable: payload.Error.Retryable,
			}
		default:
			return protocolFailure(fmt.Sprintf("unsupported Python Agent event %q", eventName), nil)
		}
	})
	if err != nil {
		if runContext.Err() != nil {
			return runContextFailure(ctx, runContext)
		}
		return err
	}
	if !completed {
		return protocolFailure("Python Agent stream ended before completion", nil)
	}
	if strings.TrimSpace(fullText) == "" {
		return &agent.Failure{Code: emptyResponseCode, Message: "模型没有返回有效文本"}
	}
	return nil
}

func decodeTool(value *streamTool, requireFailure bool) (*agent.ToolEvent, error) {
	if value == nil || strings.TrimSpace(value.CallID) == "" || strings.TrimSpace(value.ID) == "" {
		return nil, protocolFailure("Python Agent returned an invalid tool event", nil)
	}
	tool := &agent.ToolEvent{
		CallID: value.CallID,
		ID:     value.ID,
		Name:   value.Name,
		Input:  value.Input,
		Output: value.Output,
	}
	if tool.Name == "" {
		tool.Name = tool.ID
	}
	if value.Error != nil {
		tool.Error = &agent.Failure{
			Code: value.Error.Code, Message: value.Error.Message, Retryable: value.Error.Retryable,
		}
	}
	if requireFailure && (tool.Error == nil || tool.Error.Code == "") {
		return nil, protocolFailure("Python Agent tool failure omitted its error", nil)
	}
	return tool, nil
}

func consumeSSE(reader io.Reader, handle func(string, []byte) error) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64<<10), maximumSSEEventSize)
	eventName := ""
	dataLines := make([]string, 0, 1)
	dispatch := func() error {
		if len(dataLines) == 0 {
			eventName = ""
			return nil
		}
		if eventName == "" {
			return protocolFailure("Python Agent SSE event omitted its type", nil)
		}
		data := []byte(strings.Join(dataLines, "\n"))
		dataLines = dataLines[:0]
		name := eventName
		eventName = ""
		return handle(name, data)
	}

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if err := dispatch(); err != nil {
				return err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if found && strings.HasPrefix(value, " ") {
			value = value[1:]
		}
		switch field {
		case "event":
			eventName = value
		case "data":
			dataLines = append(dataLines, value)
		}
	}
	if err := scanner.Err(); err != nil {
		return serviceFailure("read Agent stream", err)
	}
	return dispatch()
}

func (r *Runner) newRequest(
	ctx context.Context,
	method string,
	path string,
	body io.Reader,
) (*http.Request, error) {
	endpoint := *r.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + path
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return nil, fmt.Errorf("create Python Agent request: %w", err)
	}
	return request, nil
}

func responseStatusError(response *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(response.Body, maximumErrorResponseBytes))
	message := strings.TrimSpace(string(body))
	if message == "" {
		message = http.StatusText(response.StatusCode)
	}
	code := agentServiceErrorCode
	retryable := response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500
	if response.StatusCode == http.StatusServiceUnavailable || response.StatusCode == http.StatusBadGateway {
		code = agentServiceUnavailable
	}
	return &agent.Failure{
		Code:      code,
		Message:   "Python Agent 服务请求失败",
		Retryable: retryable,
		Cause:     fmt.Errorf("HTTP %d: %s", response.StatusCode, message),
	}
}

func serviceFailure(operation string, err error) error {
	return &agent.Failure{
		Code:      agentServiceUnavailable,
		Message:   "Python Agent 服务暂时不可用",
		Retryable: true,
		Cause:     fmt.Errorf("%s: %w", operation, err),
	}
}

func runContextFailure(parent context.Context, runContext context.Context) error {
	if parent.Err() != nil {
		return parent.Err()
	}
	return &agent.Failure{
		Code:      "MODEL_REQUEST_FAILED",
		Message:   "模型调用超时",
		Retryable: true,
		Cause:     runContext.Err(),
	}
}

func protocolFailure(message string, cause error) error {
	return &agent.Failure{
		Code:      agentProtocolErrorCode,
		Message:   "Python Agent 返回了无法识别的数据",
		Retryable: false,
		Cause:     errors.Join(errors.New(message), cause),
	}
}

func (r *Runner) DefaultModelID() string {
	return r.defaultModelID
}

func (r *Runner) ResolveModelID(modelID string) (string, bool) {
	modelID = strings.TrimSpace(modelID)
	if modelID == "" {
		modelID = r.defaultModelID
	}
	_, exists := r.modelIDs[modelID]
	return modelID, exists
}

func (r *Runner) Models() []agent.ModelInfo {
	result := make([]agent.ModelInfo, len(r.models))
	copy(result, r.models)
	return result
}

func (r *Runner) Close() error {
	if transport, ok := r.client.Transport.(*http.Transport); ok {
		transport.CloseIdleConnections()
	}
	return nil
}

var _ agent.Runner = (*Runner)(nil)
var _ agent.ModelCatalog = (*Runner)(nil)
