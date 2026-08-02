// Constructs protocol-compliant WebSocket events and publishes them to a user.
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
	return connection.Send(p.event(EventConnectionReady, ConnectionReadyPayload{
		ConnectionID:      connection.ID(),
		HeartbeatInterval: pingEvery.Milliseconds(),
		ResumeSupported:   false,
	}))
}

func (p *Publisher) Accepted(
	connection *Connection,
	requestID string,
	commandType CommandType,
	chatID *string,
	runID *string,
) error {
	event := p.event(EventCommandAccepted, CommandAcceptedPayload{
		CommandType: commandType,
	})
	event.RequestID = stringPointer(requestID)
	event.ChatID = chatID
	event.RunID = runID
	return connection.Send(event)
}

func (p *Publisher) Rejected(
	connection *Connection,
	requestID string,
	chatID *string,
	runID *string,
	command CommandType,
	businessError *BusinessError,
) error {
	event := p.event(EventCommandRejected, CommandRejectedPayload{
		CommandType: command,
		Error: CommandError{
			Code:      businessError.Code,
			Message:   businessError.Message,
			Retryable: businessError.Retryable,
		},
	})
	if requestID != "" {
		event.RequestID = stringPointer(requestID)
	}
	event.ChatID = chatID
	event.RunID = runID
	return connection.Send(event)
}

func (p *Publisher) ConnectionError(
	connection *Connection,
	code string,
	message string,
	retryable bool,
) error {
	return connection.Send(p.event(EventError, ErrorPayload{
		Error: CommandError{
			Code:      code,
			Message:   message,
			Retryable: retryable,
		},
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

func (p *Publisher) RunSnapshot(run Run, eventType EventType) {
	event := p.runEvent(run, eventType, run.LastSeq, RunSnapshotPayload{
		Run: wireAgentRun(run),
	})
	event.MessageID = nil
	p.publish(run.UserID.String(), event)
}

func (p *Publisher) MessageSnapshot(
	run Run,
	message Message,
	seq int64,
	eventType EventType,
	messageError *CommandError,
) {
	event := p.runEvent(run, eventType, seq, MessageSnapshotPayload{
		Message: wireChatMessage(message, messageError),
	})
	event.MessageID = stringPointer(message.ID.String())
	p.publish(run.UserID.String(), event)
}

func (p *Publisher) MessageDelta(run Run, seq int64, delta string) {
	event := p.runEvent(run, EventMessageDelta, seq, MessageDeltaPayload{
		Delta: delta,
	})
	event.MessageID = stringPointer(run.OutputMessageID.String())
	p.publish(run.UserID.String(), event)
}

// StepSnapshot is reserved for the future Agent step pipeline.
func (p *Publisher) StepSnapshot(
	run Run,
	eventType EventType,
	seq int64,
	stepID string,
	step any,
) {
	event := p.runEvent(run, eventType, seq, StepSnapshotPayload{Step: step})
	event.MessageID = nil
	event.StepID = stringPointer(stepID)
	p.publish(run.UserID.String(), event)
}

func (p *Publisher) event(eventType EventType, payload any) ServerEnvelope {
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
	run Run,
	eventType EventType,
	seq int64,
	payload any,
) ServerEnvelope {
	event := p.event(eventType, payload)
	event.ChatID = stringPointer(run.ChatID.String())
	event.RunID = stringPointer(run.ID.String())
	event.Seq = int64Pointer(seq)
	return event
}

func (p *Publisher) publish(userID string, event ServerEnvelope) {
	p.hub.PublishToUser(userID, event)
}

func stringPointer(value string) *string { return &value }
func int64Pointer(value int64) *int64    { return &value }
