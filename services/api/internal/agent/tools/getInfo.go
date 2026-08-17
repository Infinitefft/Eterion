// Package tools contains the executable tools that an Eino Agent can call.
package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	einotool "github.com/cloudwego/eino/components/tool"
	toolutils "github.com/cloudwego/eino/components/tool/utils"
)

const (
	// WebSearchName is the exact function name sent to the language model.
	WebSearchName = "web_search"

	// braveSearchAPIURL is Brave Search's official web-search endpoint.
	braveSearchAPIURL = "https://api.search.brave.com/res/v1/web/search"
)

// WebSearchInput describes the JSON arguments that the model must generate.
type WebSearchInput struct {
	// Query is required, so the model cannot call this tool without a search phrase.
	Query string `json:"query" jsonschema:"required,description=需要在公开互联网中搜索的关键词或问题"`
}

// WebSearchResult is one search result returned to the model and the frontend.
type WebSearchResult struct {
	// Title is the webpage title shown in the search result.
	Title string `json:"title"`

	// URL is the public HTTP or HTTPS address of the webpage.
	URL string `json:"url"`

	// Description is Brave's short summary of the webpage.
	Description string `json:"description,omitempty"`
}

// WebSearchOutput is the complete JSON value returned by the tool.
type WebSearchOutput struct {
	// Query repeats the actual query so the model knows what these results belong to.
	Query string `json:"query"`

	// Results contains at most five public webpages.
	Results []WebSearchResult `json:"results"`
}

// braveSearchResponse contains only the fields we read from Brave's larger response.
type braveSearchResponse struct {
	Web struct {
		Results []struct {
			Title       string `json:"title"`
			URL         string `json:"url"`
			Description string `json:"description"`
		} `json:"results"`
	} `json:"web"`
}

// NewWebSearch creates a real Eino tool backed by Brave Search.
func NewWebSearch(apiKey string) (einotool.InvokableTool, error) {
	// Remove accidental spaces around the value copied from .env.
	apiKey = strings.TrimSpace(apiKey)

	// Fail during application startup instead of during a user's conversation.
	if apiKey == "" {
		return nil, errors.New("Brave Search API key is required")
	}

	// Give every outbound search request a finite timeout.
	client := &http.Client{Timeout: 15 * time.Second}

	// Build the production tool with the official endpoint.
	return newWebSearch(apiKey, braveSearchAPIURL, client)
}

// newWebSearch accepts its endpoint and client as parameters so the HTTP boundary is testable.
func newWebSearch(
	apiKey string,
	endpointURL string,
	client *http.Client,
) (einotool.InvokableTool, error) {
	// InferTool turns the Go input/output structs into the JSON schema sent to the model.
	return toolutils.InferTool(
		// This name must match the tool call name produced by the model.
		WebSearchName,

		// This description is the model's main rule for deciding whether to call the tool.
		"搜索公开互联网并返回相关网页。"+
			"当问题需要最新信息、外部网页、官方文档或来源链接时必须调用。"+
			"不要用于纯计算、翻译、改写，或总结用户已经提供的内容。",

		// Eino calls this function after the model emits a web_search tool call.
		func(ctx context.Context, input *WebSearchInput) (*WebSearchOutput, error) {
			// Defend against an invalid direct invocation.
			if input == nil {
				return nil, errors.New("search input cannot be nil")
			}

			// Normalize the query before sending it to Brave.
			query := strings.TrimSpace(input.Query)

			// An empty query cannot produce a useful search.
			if query == "" {
				return nil, errors.New("search query cannot be empty")
			}

			// Parse the endpoint before safely adding URL query parameters.
			endpoint, err := url.Parse(endpointURL)
			if err != nil {
				return nil, fmt.Errorf("parse Brave Search endpoint: %w", err)
			}

			// Read the endpoint's existing query string, if it has one.
			params := endpoint.Query()

			// q is Brave Search's required search-text parameter.
			params.Set("q", query)

			// Keep this first example small: return no more than five results.
			params.Set("count", "5")

			// Ask only for ordinary webpage results.
			params.Set("result_filter", "web")

			// Use moderate safe-search filtering for a general chat product.
			params.Set("safesearch", "moderate")

			// Plain text is easier for the model and frontend to consume than decorated HTML.
			params.Set("text_decorations", "false")

			// Encode all parameters back into the request URL.
			endpoint.RawQuery = params.Encode()

			// Attach the Agent run's context so cancellation also cancels the HTTP request.
			request, err := http.NewRequestWithContext(
				ctx,
				http.MethodGet,
				endpoint.String(),
				nil,
			)
			if err != nil {
				return nil, fmt.Errorf("create web search request: %w", err)
			}

			// Brave returns JSON when this media type is requested.
			request.Header.Set("Accept", "application/json")

			// Brave authenticates requests with this subscription-token header.
			request.Header.Set("X-Subscription-Token", apiKey)

			// Execute the real outbound request.
			response, err := client.Do(request)
			if err != nil {
				return nil, fmt.Errorf("execute web search: %w", err)
			}

			// Always release the response body after this function returns.
			defer response.Body.Close()

			// Treat authentication, rate-limit and provider errors as tool failures.
			if response.StatusCode != http.StatusOK {
				return nil, fmt.Errorf(
					"Brave Search returned HTTP %d",
					response.StatusCode,
				)
			}

			// Allocate the small subset of Brave's response that this tool needs.
			var payload braveSearchResponse

			// Decode the provider's JSON response into the Go struct above.
			if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
				return nil, fmt.Errorf("decode Brave Search response: %w", err)
			}

			// Preallocate enough space for every provider result.
			results := make([]WebSearchResult, 0, len(payload.Web.Results))

			// Convert Brave's objects into our stable application-owned output format.
			for _, item := range payload.Web.Results {
				// Normalize the URL before validating it.
				resultURL := strings.TrimSpace(item.URL)

				// Ignore results that have no usable URL.
				if resultURL == "" {
					continue
				}

				// Parse the URL so unsafe or malformed schemes can be rejected.
				parsedURL, err := url.Parse(resultURL)
				if err != nil {
					continue
				}

				// Only return links a browser can safely open as an ordinary webpage.
				if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
					continue
				}

				// Append one normalized result to the tool output.
				results = append(results, WebSearchResult{
					Title:       strings.TrimSpace(item.Title),
					URL:         resultURL,
					Description: strings.TrimSpace(item.Description),
				})
			}

			// Return structured JSON; Eino serializes this value for the model automatically.
			return &WebSearchOutput{
				Query:   query,
				Results: results,
			}, nil
		},
	)
}
