package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
)

func (r *Runner) GenerateTitle(ctx context.Context, input agent.TitleInput) (string, error) {
	body, err := json.Marshal(input)
	if err != nil {
		return "", err
	}
	request, err := r.newRequest(ctx, http.MethodPost, "/title", bytes.NewReader(body))
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
		return "", errors.New("Agent title generation failed")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	if err != nil || len(raw) > 4096 {
		return "", errors.New("invalid title response size")
	}
	var result struct {
		Title string `json:"title"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return "", errors.New("invalid title response")
	}
	title := strings.TrimSpace(result.Title)
	if title == "" || utf8.RuneCountInString(title) > 32 {
		return "", errors.New("invalid generated title")
	}
	return title, nil
}
