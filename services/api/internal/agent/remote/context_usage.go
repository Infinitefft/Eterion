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

func (r *Runner) ReadContextUsage(ctx context.Context, input agent.CompactInput) (*agent.ContextUsage, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	body, err := json.Marshal(input)
	if err != nil || len(body) > maximumSSEEventSize {
		return nil, errors.New("invalid context usage input")
	}
	request, err := r.newRequest(ctx, http.MethodPost, "/context/usage", bytes.NewReader(body))
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
		return nil, errors.New("Agent context usage unavailable")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	if err != nil || len(raw) > 4096 {
		return nil, errors.New("invalid context usage response size")
	}
	var result agent.ContextUsage
	if json.Unmarshal(raw, &result) != nil || result.ModelID != input.ModelID ||
		result.ContextWindow <= 0 || result.UsedTokens < 0 ||
		result.AutoCompactTokenLimit <= 0 || result.AutoCompactTokenLimit >= result.ContextWindow ||
		result.RemainingTokens != max(0, result.ContextWindow-result.UsedTokens) {
		return nil, errors.New("invalid context usage response")
	}
	return &result, nil
}
