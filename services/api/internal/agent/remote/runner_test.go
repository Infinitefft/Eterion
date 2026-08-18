package remote

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
)

func TestRunnerStreamsPythonAgentEvents(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/models":
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{
				"default_model_id":"model-b",
				"models":[
					{"id":"model-b","modelName":"Model B","provider":"test","providerName":"Test","icon_url":""},
					{"id":"model-a","modelName":"Model A","provider":"test","providerName":"Test","icon_url":""}
				]
			}`))
		case "/runs":
			var input runRequest
			if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
				t.Fatalf("decode run request: %v", err)
			}
			if input.ModelID != "model-b" || len(input.Messages) != 1 || input.Messages[0].Role != "user" {
				t.Fatalf("unexpected run input: %+v", input)
			}
			writer.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
			_, _ = writer.Write([]byte(
				"event: started\ndata: {\"model\":\"model-b\"}\n\n" +
					"event: content_delta\ndata: {\"delta\":\"你\"}\n\n" +
					"event: content_delta\ndata: {\"delta\":\"好\"}\n\n" +
					"event: completed\ndata: {\"full_text\":\"你好\"}\n\n",
			))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	runner, err := NewRunner(context.Background(), Config{
		BaseURL: server.URL, ConnectTimeout: time.Second,
	})
	if err != nil {
		t.Fatalf("create runner: %v", err)
	}
	defer runner.Close()

	if runner.DefaultModelID() != "model-b" {
		t.Fatalf("unexpected default model: %s", runner.DefaultModelID())
	}
	models := runner.Models()
	if models[0].ID != "model-a" || models[1].ID != "model-b" {
		t.Fatalf("models were not sorted: %+v", models)
	}

	var events []agent.Event
	err = runner.Run(context.Background(), agent.Input{
		RunID: "run-1", ChatID: "chat-1", Messages: []agent.Message{{Role: "user", Content: "你好"}},
	}, func(event agent.Event) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("run Agent: %v", err)
	}
	if len(events) != 4 {
		t.Fatalf("unexpected event count: %d", len(events))
	}
	if events[1].Delta+events[2].Delta != "你好" || events[3].FullText != "你好" {
		t.Fatalf("unexpected text events: %+v", events)
	}
}

func TestRunnerRejectsStreamWithoutCompletedEvent(t *testing.T) {
	t.Parallel()

	server := testAgentServer(t, func(writer http.ResponseWriter) {
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = writer.Write([]byte("event: started\ndata: {\"model\":\"model-a\"}\n\n"))
	})
	defer server.Close()

	runner, err := NewRunner(context.Background(), Config{BaseURL: server.URL})
	if err != nil {
		t.Fatalf("create runner: %v", err)
	}
	defer runner.Close()

	err = runner.Run(context.Background(), validInput(), func(agent.Event) error { return nil })
	var failure *agent.Failure
	if !errors.As(err, &failure) || failure.Code != agentProtocolErrorCode {
		t.Fatalf("expected protocol failure, got %v", err)
	}
}

func TestRunnerRejectsUnknownModelBeforeRunRequest(t *testing.T) {
	t.Parallel()

	runRequests := 0
	server := testAgentServer(t, func(writer http.ResponseWriter) {
		runRequests++
		http.Error(writer, "unexpected", http.StatusInternalServerError)
	})
	defer server.Close()

	runner, err := NewRunner(context.Background(), Config{BaseURL: server.URL})
	if err != nil {
		t.Fatalf("create runner: %v", err)
	}
	defer runner.Close()

	input := validInput()
	input.ModelID = "missing"
	err = runner.Run(context.Background(), input, func(agent.Event) error { return nil })
	var failure *agent.Failure
	if !errors.As(err, &failure) || failure.Code != modelNotAvailableCode {
		t.Fatalf("expected model failure, got %v", err)
	}
	if runRequests != 0 {
		t.Fatalf("unexpected Python run requests: %d", runRequests)
	}
}

func testAgentServer(t *testing.T, runHandler func(http.ResponseWriter)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/models":
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{
				"default_model_id":"model-a",
				"models":[{"id":"model-a","modelName":"Model A","provider":"test","providerName":"Test","icon_url":""}]
			}`))
		case "/runs":
			runHandler(writer)
		default:
			http.NotFound(writer, request)
		}
	}))
}

func validInput() agent.Input {
	return agent.Input{
		RunID: "run-1", ChatID: "chat-1", ModelID: "model-a",
		Messages: []agent.Message{{Role: "user", Content: "hello"}},
	}
}
