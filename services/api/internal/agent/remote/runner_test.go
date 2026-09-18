package remote

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
)

func TestRunPassesUserIDWithoutChangingEvents(t *testing.T) {
	requests := make(chan runRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/models" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"default_model_id":"test","models":[{"id":"test"}]}`)
			return
		}
		if r.URL.Path != "/runs" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		var request runRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		requests <- request
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: run.completed\ndata: {\"runId\":\"run-1\",\"payload\":{}}\n\n")
	}))
	defer server.Close()
	runner, err := NewRunner(context.Background(), Config{BaseURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer runner.Close()
	var events []agent.Event
	err = runner.Run(context.Background(), agent.Input{
		RunID: "run-1", UserID: "trusted-user", ThreadID: "thread-1", ModelID: "test",
		Messages: []agent.Message{{Role: "user", Content: "你好"}},
	}, func(event agent.Event) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case request := <-requests:
		if request.UserID != "trusted-user" || request.RunID != "run-1" || request.ThreadID != "thread-1" {
			t.Fatalf("unexpected identity: %+v", request)
		}
		if len(request.Messages) != 1 || request.Messages[0].Content != "你好" {
			t.Fatalf("identity must not be inserted into model messages: %+v", request.Messages)
		}
	default:
		t.Fatal("missing Agent request")
	}
	if len(events) != 1 || events[0].Type != agent.EventRunCompleted || events[0].RunID != "run-1" {
		t.Fatalf("unexpected events: %+v", events)
	}
}

func TestConsumeSSEDecodesAgentEvent(t *testing.T) {
	stream := strings.NewReader(
		": keepalive\n\n" +
			"event: content.delta\n" +
			"data: {\"runId\":\"run-1\",\"payload\":{\"delta\":\"hello\"}}\n\n",
	)

	var received agent.Event
	err := consumeSSE(stream, func(eventName string, data []byte) error {
		var envelope streamEnvelope
		if err := decodePayload(data, &envelope); err != nil {
			return err
		}
		event, terminal, err := decodeEvent(agent.EventType(eventName), envelope)
		if err != nil {
			return err
		}
		if terminal {
			t.Fatal("content.delta must not be terminal")
		}
		received = event
		return nil
	})
	if err != nil {
		t.Fatalf("consume SSE: %v", err)
	}
	if received.Type != agent.EventContentDelta || received.RunID != "run-1" || received.Delta != "hello" {
		t.Fatalf("unexpected event: %+v", received)
	}
}
