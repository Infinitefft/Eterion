package chat

import (
	"encoding/json"
	"testing"
)

func TestProtocolUsesFrontendFieldNames(t *testing.T) {
	data, err := json.Marshal(ThreadEvent{
		Type: EventMessageDelta, ThreadID: "thread-1", SeqID: 7,
		Timestamp: 123, RunID: "run-1", MessageID: "message-1",
		Payload: MessageDeltaPayload{Delta: "hello"},
	})
	if err != nil {
		t.Fatal(err)
	}

	var event map[string]any
	if err := json.Unmarshal(data, &event); err != nil {
		t.Fatal(err)
	}
	if event["threadId"] != "thread-1" || event["seqId"] != float64(7) {
		t.Fatalf("unexpected frontend envelope: %s", data)
	}
	for _, oldKey := range []string{"event_id", "chat_id", "seq", "cursor"} {
		if _, exists := event[oldKey]; exists {
			t.Errorf("event still contains old field %q", oldKey)
		}
	}
}
