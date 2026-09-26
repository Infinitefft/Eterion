package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
)

// Compact 只访问可信 Agent 服务，不把上下文返回给浏览器。
func (r *Runner) Compact(ctx context.Context, input agent.CompactInput) (*agent.CompactResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	body, err := json.Marshal(input)
	if err != nil {
		return nil, errors.New("cannot encode compaction input")
	}
	if len(body) > maximumSSEEventSize {
		return nil, errors.New("compaction input exceeds transport limit")
	}
	request, err := r.newRequest(ctx, http.MethodPost, "/context/compact", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := r.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("Agent context compaction failed")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maximumSSEEventSize+1))
	if err != nil || len(raw) > maximumSSEEventSize {
		return nil, errors.New("invalid compaction response size")
	}
	var result agent.CompactResult
	if json.Unmarshal(raw, &result) != nil {
		return nil, errors.New("invalid compaction response")
	}
	contextJSON := bytes.TrimSpace(result.AgentContext)
	if len(contextJSON) == 0 || contextJSON[0] != '[' {
		return nil, errors.New("invalid compacted context")
	}
	return &result, nil
}
