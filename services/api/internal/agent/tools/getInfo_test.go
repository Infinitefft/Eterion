package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWebSearchCallsBraveAndReturnsURLs(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		if request.Method != http.MethodGet {
			t.Fatalf("unexpected method: %s", request.Method)
		}
		if request.Header.Get("X-Subscription-Token") != "search-key" {
			t.Fatalf("unexpected search key")
		}
		if request.URL.Query().Get("q") != "Eino framework" {
			t.Fatalf("unexpected query: %s", request.URL.Query().Get("q"))
		}

		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{
			"web": {
				"results": [
					{
						"title": "Eino",
						"url": "https://www.cloudwego.io/docs/eino/",
						"description": "Eino documentation"
					},
					{
						"title": "Unsafe",
						"url": "javascript:alert(1)",
						"description": "must be filtered"
					}
				]
			}
		}`))
	}))
	defer server.Close()

	searchTool, err := newWebSearch("search-key", server.URL, server.Client())
	if err != nil {
		t.Fatalf("create web search tool: %v", err)
	}

	rawOutput, err := searchTool.InvokableRun(
		context.Background(),
		`{"query":"Eino framework"}`,
	)
	if err != nil {
		t.Fatalf("invoke web search tool: %v", err)
	}

	var output WebSearchOutput
	if err := json.Unmarshal([]byte(rawOutput), &output); err != nil {
		t.Fatalf("decode tool output: %v", err)
	}
	if output.Query != "Eino framework" {
		t.Fatalf("unexpected output query: %q", output.Query)
	}
	if len(output.Results) != 1 {
		t.Fatalf("unexpected result count: %d", len(output.Results))
	}
	if output.Results[0].URL != "https://www.cloudwego.io/docs/eino/" {
		t.Fatalf("unexpected result URL: %q", output.Results[0].URL)
	}
}
