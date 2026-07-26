// 负责锁定 WebSocket 协议使用 chat_id 且不包含版本字段的约定。
package chat

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestServerEnvelopeUsesChatNamingWithoutVersion(t *testing.T) {
	chatID := "chat-1"
	encoded, err := json.Marshal(ServerEnvelope{
		EventID:   "event-1",
		Type:      EventMessageDelta,
		ChatID:    &chatID,
		Timestamp: 1,
		Payload: MessageDeltaPayload{
			BlockID:   "block-1",
			BlockType: "text",
			Delta:     "你好",
		},
	})
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}

	value := string(encoded)
	if !strings.Contains(value, `"chat_id":"chat-1"`) {
		t.Fatalf("chat_id is missing: %s", value)
	}
	if strings.Contains(value, `"conversation_id"`) {
		t.Fatalf("legacy conversation_id found: %s", value)
	}
	if strings.Contains(value, `"version"`) {
		t.Fatalf("version field found: %s", value)
	}
}
