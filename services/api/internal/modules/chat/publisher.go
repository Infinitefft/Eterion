// 负责构造统一的 WebSocket 事件，并通过全局 Hub 发布给指定 Chat。
package chat

import (
	"time"

	"github.com/google/uuid"
)

type Publisher struct {
	hub *Hub
	now func() time.Time
}

func NewPublisher(hub *Hub) *Publisher {
	return &Publisher{
		hub: hub,
		now: func() time.Time {
			return time.Now().UTC()
		},
	}
}

func (p *Publisher) ConnectionReady(connection *Connection) error {
	event := p.event(EventConnectionReady, ConnectionReadyPayload{
		ConnectionID:      connection.ID(),
		HeartbeatInterval: pingEvery.Milliseconds(),
		Capabilities: []string{
			"chat_stream",
			"run_cancel",
		},
	})
	return connection.Send(event)
}

func (p *Publisher) ChatAccepted(
	connection *Connection,
	requestID string,
	record *SubmitRecord,
) error {
	event := p.event(EventCommandAccepted, CommandAcceptedPayload{
		Command:            CommandChatSubmit,
		UserMessageID:      record.UserMessage.ID.String(),
		AssistantMessageID: record.AssistantMessage.ID.String(),
		RunID:              record.Run.ID.String(),
		Duplicate:          record.Duplicate,
	})
	event.RequestID = stringPointer(requestID)
	event.ChatID = stringPointer(record.Run.ChatID.String())
	event.RunID = stringPointer(record.Run.ID.String())
	event.MessageID = stringPointer(record.AssistantMessage.ID.String())
	return connection.Send(event)
}

func (p *Publisher) CancelAccepted(
	connection *Connection,
	requestID string,
	chatID string,
	runID string,
	duplicate bool,
) error {
	event := p.event(EventCommandAccepted, RunCancelAcceptedPayload{
		Command:   CommandRunCancel,
		RunID:     runID,
		Duplicate: duplicate,
	})
	event.RequestID = stringPointer(requestID)
	event.ChatID = stringPointer(chatID)
	event.RunID = stringPointer(runID)
	return connection.Send(event)
}

func (p *Publisher) Rejected(
	connection *Connection,
	requestID string,
	chatID string,
	command CommandType,
	businessError *BusinessError,
) error {
	event := p.event(EventCommandRejected, CommandRejectedPayload{
		Command: command,
		Error: CommandError{
			Code:      businessError.Code,
			Message:   businessError.Message,
			Retryable: businessError.Retryable,
		},
	})
	if requestID != "" {
		event.RequestID = stringPointer(requestID)
	}
	if chatID != "" {
		event.ChatID = stringPointer(chatID)
	}
	return connection.Send(event)
}

func (p *Publisher) ConnectionError(
	connection *Connection,
	code string,
	message string,
	retryable bool,
) error {
	return connection.Send(p.event(EventError, ErrorPayload{
		Code:      code,
		Message:   message,
		Retryable: retryable,
	}))
}

func (p *Publisher) Pong(
	connection *Connection,
	requestID string,
	clientTime int64,
) error {
	now := p.now()
	event := p.eventAt(EventPong, PongPayload{
		ClientTime: clientTime,
		ServerTime: now.UnixMilli(),
	}, now)
	event.RequestID = stringPointer(requestID)
	return connection.Send(event)
}

func (p *Publisher) RunCreated(
	run *Run,
	seq int64,
) {
	event := p.runEvent(run, EventRunCreated, seq, RunCreatedPayload{
		Status: RunStatusCreated,
	})
	p.publish(run, event)
}

func (p *Publisher) RunStatusChanged(
	run *Run,
	seq int64,
	previous RunStatus,
	current RunStatus,
	reason *string,
	runError *CommandError,
) {
	event := p.runEvent(run, EventRunStatus, seq, RunStatusPayload{
		PreviousStatus: previous,
		CurrentStatus:  current,
		Reason:         reason,
		Error:          runError,
	})
	p.publish(run, event)
}

func (p *Publisher) MessageStarted(
	run *Run,
	seq int64,
	blockID string,
) {
	event := p.runEvent(run, EventMessageStarted, seq, MessageStartedPayload{
		Role: string(MessageRoleAssistant),
		Block: TextBlockRef{
			BlockID:   blockID,
			BlockType: "text",
		},
	})
	p.publish(run, event)
}

func (p *Publisher) MessageDelta(
	run *Run,
	seq int64,
	blockID string,
	delta string,
) {
	event := p.runEvent(run, EventMessageDelta, seq, MessageDeltaPayload{
		BlockID:   blockID,
		BlockType: "text",
		Delta:     delta,
	})
	p.publish(run, event)
}

func (p *Publisher) MessageCompleted(
	run *Run,
	seq int64,
	blockID string,
	fullText string,
) {
	event := p.runEvent(
		run,
		EventMessageCompleted,
		seq,
		MessageCompletedPayload{
			Blocks: []TextBlock{{
				BlockID:   blockID,
				BlockType: "text",
				Text:      fullText,
			}},
		},
	)
	p.publish(run, event)
}

func (p *Publisher) event(
	eventType EventType,
	payload any,
) ServerEnvelope {
	return p.eventAt(eventType, payload, p.now())
}

func (p *Publisher) eventAt(
	eventType EventType,
	payload any,
	now time.Time,
) ServerEnvelope {
	return ServerEnvelope{
		EventID:   uuid.NewString(),
		Type:      eventType,
		Timestamp: now.UnixMilli(),
		Payload:   payload,
	}
}

func (p *Publisher) runEvent(
	run *Run,
	eventType EventType,
	seq int64,
	payload any,
) ServerEnvelope {
	event := p.event(eventType, payload)
	event.ChatID = stringPointer(run.ChatID.String())
	event.RunID = stringPointer(run.ID.String())
	event.MessageID = stringPointer(run.OutputMessageID.String())
	event.Seq = int64Pointer(seq)
	return event
}

func (p *Publisher) publish(run *Run, event ServerEnvelope) {
	p.hub.PublishToChat(
		run.UserID.String(),
		run.ChatID.String(),
		event,
	)
}

func stringPointer(value string) *string {
	return &value
}

func int64Pointer(value int64) *int64 {
	return &value
}
