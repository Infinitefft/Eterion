package chat

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestServerEnvelopeMatchesFrontendShape(t *testing.T) {
	chatID := uuid.NewString()
	runID := uuid.NewString()
	messageID := uuid.NewString()
	seq := int64(4)
	event := ServerEnvelope{
		EventID:   uuid.NewString(),
		Type:      EventMessageDelta,
		ChatID:    &chatID,
		RunID:     &runID,
		MessageID: &messageID,
		Seq:       &seq,
		Timestamp: 1234,
		Payload:   MessageDeltaPayload{Delta: "你好"},
	}

	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	var value map[string]any
	if err := json.Unmarshal(encoded, &value); err != nil {
		t.Fatalf("decode event: %v", err)
	}
	for _, field := range []string{
		"request_id", "chat_id", "run_id", "message_id", "step_id", "seq", "cursor",
	} {
		if _, ok := value[field]; !ok {
			t.Fatalf("missing envelope field %q: %s", field, encoded)
		}
	}
	payload := value["payload"].(map[string]any)
	if payload["delta"] != "你好" || len(payload) != 1 {
		t.Fatalf("unexpected delta payload: %#v", payload)
	}
}

func TestWireSnapshotsUseMillisecondsAndStructuredContent(t *testing.T) {
	now := time.Date(2026, 8, 2, 12, 0, 0, 123000000, time.UTC)
	chatID := uuid.New()
	runID := uuid.New()
	message := Message{
		ID:            uuid.New(),
		ChatID:        chatID,
		RunID:         &runID,
		Role:          MessageRoleAssistant,
		Status:        MessageStatusCompleted,
		Content:       "**done**",
		ContentFormat: TextFormatMarkdown,
		CreatedAt:     now,
		UpdatedAt:     now,
		CompletedAt:   &now,
	}

	wire := wireChatMessage(message, nil)
	if wire.CreatedAt != now.UnixMilli() || wire.CompletedAt == nil || *wire.CompletedAt != now.UnixMilli() {
		t.Fatalf("timestamps are not Unix milliseconds: %#v", wire)
	}
	if wire.Content.Type != "text" || wire.Content.Format != TextFormatMarkdown || wire.Content.Content != "**done**" {
		t.Fatalf("unexpected text content: %#v", wire.Content)
	}
}
