// Package remote adapts the Node.js HTTP/SSE Agent service to the Go contract.
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
	modelNotAvailableCode     = "MODEL_NOT_AVAILABLE"
	maximumSSEEventSize       = 4 << 20
	maximumErrorResponseBytes = 64 << 10
)

type Config struct {
	BaseURL        string
	ConnectTimeout time.Duration
	RunTimeout     time.Duration
}

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
	ThreadID string          `json:"thread_id"`
	ModelID  string          `json:"model_id"`
	Messages []agent.Message `json:"messages"`
}

type streamEnvelope struct {
	RunID   string          `json:"runId"`
	Payload json.RawMessage `json:"payload"`
}

type errorPayload struct {
	Error *streamFailure `json:"error"`
}

type streamFailure struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type toolPayload struct {
	ToolCallID string         `json:"toolCallId"`
	Name       string         `json:"name"`
	Display    *string        `json:"displayName"`
	Args       any            `json:"args"`
	Summary    *string        `json:"summary"`
	Result     any            `json:"result"`
	Error      *streamFailure `json:"error"`
}

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
		baseURL: baseURL, client: &http.Client{Transport: transport}, runTimeout: config.RunTimeout,
	}
	catalogContext, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	if err := runner.loadCatalog(catalogContext); err != nil {
		transport.CloseIdleConnections()
		return nil, fmt.Errorf("load Node Agent model catalog: %w", err)
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
	if parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("Agent service URL must contain only scheme, host, and path")
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
		return errors.New("Node Agent returned an empty model catalog")
	}
	modelIDs := make(map[string]struct{}, len(catalog.Models))
	for index := range catalog.Models {
		catalog.Models[index].ID = strings.TrimSpace(catalog.Models[index].ID)
		if catalog.Models[index].ID == "" {
			return errors.New("Node Agent returned a model without an ID")
		}
		if _, exists := modelIDs[catalog.Models[index].ID]; exists {
			return fmt.Errorf("Node Agent returned duplicate model ID %q", catalog.Models[index].ID)
		}
		modelIDs[catalog.Models[index].ID] = struct{}{}
	}
	catalog.DefaultModelID = strings.TrimSpace(catalog.DefaultModelID)
	if _, exists := modelIDs[catalog.DefaultModelID]; !exists {
		return fmt.Errorf("Node Agent returned unknown default model %q", catalog.DefaultModelID)
	}
	sort.SliceStable(catalog.Models, func(left, right int) bool {
		return catalog.Models[left].ID < catalog.Models[right].ID
	})
	r.defaultModelID = catalog.DefaultModelID
	r.models = catalog.Models
	r.modelIDs = modelIDs
	return nil
}

func (r *Runner) Run(ctx context.Context, input agent.Input, handle func(agent.Event) error) error {
	modelID, ok := r.ResolveModelID(input.ModelID)
	if !ok {
		return &agent.Failure{Code: modelNotAvailableCode, Message: "所选模型不可用"}
	}
	input.ModelID = modelID
	runContext := ctx
	cancel := func() {}
	if r.runTimeout > 0 {
		runContext, cancel = context.WithTimeout(ctx, r.runTimeout)
	}
	defer cancel()
	body, err := json.Marshal(runRequest{
		RunID: input.RunID, ThreadID: input.ThreadID, ModelID: input.ModelID, Messages: input.Messages,
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
		return protocolFailure("Node Agent did not return an SSE stream", nil)
	}

	terminal := false
	err = consumeSSE(response.Body, func(eventName string, data []byte) error {
		var envelope streamEnvelope
		if err := json.Unmarshal(data, &envelope); err != nil {
			return protocolFailure("Node Agent returned invalid event JSON", err)
		}
		if envelope.RunID != input.RunID {
			return protocolFailure("Node Agent event runId does not match the request", nil)
		}
		event, isTerminal, err := decodeEvent(agent.EventType(eventName), envelope)
		if err != nil {
			return err
		}
		if terminal {
			return protocolFailure("Node Agent emitted data after a terminal run event", nil)
		}
		if err := handle(event); err != nil {
			return err
		}
		terminal = isTerminal
		return nil
	})
	if err != nil {
		if runContext.Err() != nil {
			return runContextFailure(ctx, runContext)
		}
		return err
	}
	if !terminal {
		return protocolFailure("Node Agent stream ended before a terminal run event", nil)
	}
	return nil
}

func decodeEvent(eventType agent.EventType, envelope streamEnvelope) (agent.Event, bool, error) {
	event := agent.Event{Type: eventType, RunID: envelope.RunID}
	switch eventType {
	case agent.EventRunStarted:
		var payload struct {
			ModelID string `json:"modelId"`
		}
		if err := decodePayload(envelope.Payload, &payload); err != nil || strings.TrimSpace(payload.ModelID) == "" {
			return event, false, protocolFailure("invalid run.started payload", err)
		}
		event.ModelID = payload.ModelID
	case agent.EventRunCompleted:
		return event, true, nil
	case agent.EventRunFailed:
		var payload errorPayload
		if err := decodePayload(envelope.Payload, &payload); err != nil || payload.Error == nil || payload.Error.Code == "" {
			return event, false, protocolFailure("invalid run.failed payload", err)
		}
		event.Error = failure(payload.Error)
		return event, true, nil
	case agent.EventThinkingDelta, agent.EventContentDelta:
		var payload struct {
			Delta string `json:"delta"`
		}
		if err := decodePayload(envelope.Payload, &payload); err != nil {
			return event, false, protocolFailure("invalid delta payload", err)
		}
		event.Delta = payload.Delta
	case agent.EventThinkingCompleted:
		var payload struct {
			Content string `json:"content"`
		}
		if err := decodePayload(envelope.Payload, &payload); err != nil {
			return event, false, protocolFailure("invalid thinking.completed payload", err)
		}
		event.Content = payload.Content
	case agent.EventContentStarted:
		var payload struct {
			Format string `json:"format"`
		}
		if err := decodePayload(envelope.Payload, &payload); err != nil || !validFormat(payload.Format) {
			return event, false, protocolFailure("invalid content.started payload", err)
		}
		event.Format = payload.Format
	case agent.EventContentCompleted:
		var payload struct {
			Content string         `json:"content"`
			Format  string         `json:"format"`
			Status  string         `json:"status"`
			Error   *streamFailure `json:"error"`
		}
		if err := decodePayload(envelope.Payload, &payload); err != nil || !validFormat(payload.Format) || !validMessageStatus(payload.Status) {
			return event, false, protocolFailure("invalid content.completed payload", err)
		}
		if payload.Status == "failed" && (payload.Error == nil || payload.Error.Code == "") {
			return event, false, protocolFailure("failed content omitted its error", nil)
		}
		event.Content, event.Format, event.Status = payload.Content, payload.Format, payload.Status
		event.Error = failure(payload.Error)
	case agent.EventToolStarted, agent.EventToolCompleted, agent.EventToolFailed:
		var payload toolPayload
		if err := decodePayload(envelope.Payload, &payload); err != nil || payload.ToolCallID == "" {
			return event, false, protocolFailure("invalid tool event payload", err)
		}
		if eventType == agent.EventToolStarted && payload.Name == "" {
			return event, false, protocolFailure("tool.started omitted its name", nil)
		}
		if eventType == agent.EventToolFailed && (payload.Error == nil || payload.Error.Code == "") {
			return event, false, protocolFailure("tool.failed omitted its error", nil)
		}
		event.Tool = &agent.ToolEvent{
			CallID: payload.ToolCallID, Name: payload.Name, DisplayName: payload.Display,
			Args: payload.Args, Summary: payload.Summary, Result: payload.Result, Error: failure(payload.Error),
		}
	default:
		return event, false, protocolFailure(fmt.Sprintf("unsupported Node Agent event %q", eventType), nil)
	}
	return event, false, nil
}

func decodePayload(raw json.RawMessage, target any) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = json.RawMessage("{}")
	}
	return json.Unmarshal(raw, target)
}

func failure(value *streamFailure) *agent.Failure {
	if value == nil {
		return nil
	}
	return &agent.Failure{Code: value.Code, Message: value.Message, Retryable: value.Retryable}
}

func validFormat(value string) bool { return value == "plain_text" || value == "markdown" }
func validMessageStatus(value string) bool {
	return value == "completed" || value == "failed" || value == "cancelled"
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
			return protocolFailure("Node Agent SSE event omitted its type", nil)
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

func (r *Runner) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	endpoint := *r.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + path
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return nil, fmt.Errorf("create Node Agent request: %w", err)
	}
	return request, nil
}

func responseStatusError(response *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(response.Body, maximumErrorResponseBytes))
	code := agentServiceErrorCode
	retryable := response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500
	if response.StatusCode == http.StatusServiceUnavailable || response.StatusCode == http.StatusBadGateway {
		code = agentServiceUnavailable
	}
	return &agent.Failure{
		Code: code, Message: "Node Agent 服务请求失败", Retryable: retryable,
		Cause: fmt.Errorf("HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body))),
	}
}

func serviceFailure(operation string, err error) error {
	return &agent.Failure{
		Code: agentServiceUnavailable, Message: "Node Agent 服务暂时不可用", Retryable: true,
		Cause: fmt.Errorf("%s: %w", operation, err),
	}
}

func runContextFailure(parent context.Context, runContext context.Context) error {
	if parent.Err() != nil {
		return parent.Err()
	}
	return &agent.Failure{Code: "MODEL_REQUEST_FAILED", Message: "模型调用超时", Retryable: true, Cause: runContext.Err()}
}

func protocolFailure(message string, cause error) error {
	return &agent.Failure{
		Code: agentProtocolErrorCode, Message: "Node Agent 返回了无法识别的数据",
		Cause: errors.Join(errors.New(message), cause),
	}
}

func (r *Runner) DefaultModelID() string { return r.defaultModelID }

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
