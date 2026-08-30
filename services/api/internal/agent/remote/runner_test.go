package remote

import (
	"strings"
	"testing"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
)

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
