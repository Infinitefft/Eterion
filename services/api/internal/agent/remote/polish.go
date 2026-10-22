package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

func (r *Runner) PolishPrompt(ctx context.Context, content string) (string, error) {
	body, err := json.Marshal(map[string]string{"content": content})
	if err != nil {
		return "", err
	}
	request, err := r.newRequest(ctx, http.MethodPost, "/prompt/polish", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := r.client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", errors.New("Agent prompt polish failed")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (128<<10)+1))
	if err != nil || len(raw) > 128<<10 {
		return "", errors.New("invalid polish response size")
	}
	var result struct {
		Content string `json:"content"`
	}
	if json.Unmarshal(raw, &result) != nil || strings.TrimSpace(result.Content) == "" {
		return "", errors.New("invalid polished prompt")
	}
	return result.Content, nil
}
