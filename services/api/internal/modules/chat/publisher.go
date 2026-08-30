// Constructs frontend protocol frames and publishes Thread events to every
// active connection owned by the authenticated user.
package chat

import "time"

type Publisher struct {
	hub *Hub
	now func() time.Time
}

func NewPublisher(hub *Hub) *Publisher {
	return &Publisher{hub: hub, now: func() time.Time { return time.Now().UTC() }}
}

func (p *Publisher) Accepted(connection *Connection, command ClientCommand, record SubmitRecord) error {
	return connection.Send(AckFrame{
		Type: "ack", OK: true, RequestID: command.RequestID, Timestamp: p.now().UnixMilli(),
		CommandType: command.Type, ThreadID: record.Run.ChatID.String(),
		InputMessageID:  record.Run.InputMessageID.String(),
		OutputMessageID: record.Run.OutputMessageID.String(), RunID: record.Run.ID.String(),
	})
}

func (p *Publisher) AcceptedRun(connection *Connection, command ClientCommand, run Run) error {
	return connection.Send(AckFrame{
		Type: "ack", OK: true, RequestID: command.RequestID, Timestamp: p.now().UnixMilli(),
		CommandType: command.Type, ThreadID: run.ChatID.String(), RunID: run.ID.String(),
	})
}

func (p *Publisher) Rejected(connection *Connection, command ClientCommand, businessError *BusinessError) error {
	return connection.Send(AckFrame{
		Type: "ack", OK: false, RequestID: command.RequestID, Timestamp: p.now().UnixMilli(),
		CommandType: command.Type, ThreadID: command.ThreadID,
		Error: &ProtocolError{Code: businessError.Code, Message: businessError.Message},
	})
}

func (p *Publisher) ThreadUpdated(userID string, thread Chat, seq int64) {
	p.publish(userID, ThreadEvent{
		Type: EventThreadUpdated, ThreadID: thread.ID.String(), SeqID: seq,
		Timestamp: p.now().UnixMilli(), Payload: ThreadUpdatedPayload{
			Title: thread.Title, CreatedAt: thread.CreatedAt.UnixMilli(), UpdatedAt: thread.UpdatedAt.UnixMilli(),
		},
	})
}

func (p *Publisher) RunStatus(run Run, seq int64) {
	p.publish(run.UserID.String(), ThreadEvent{
		Type: EventRunStatus, ThreadID: run.ChatID.String(), SeqID: seq,
		Timestamp: p.now().UnixMilli(), RunID: run.ID.String(), Payload: runStatusPayload(run),
	})
}

func (p *Publisher) MessageStarted(run Run, message Message, seq int64) {
	p.publish(run.UserID.String(), ThreadEvent{
		Type: EventMessageStarted, ThreadID: run.ChatID.String(), SeqID: seq,
		Timestamp: p.now().UnixMilli(), RunID: run.ID.String(), MessageID: message.ID.String(),
		Payload: MessageStartedPayload{
			Role: MessageRoleAssistant, Format: message.ContentFormat, CreatedAt: message.CreatedAt.UnixMilli(),
		},
	})
}

func (p *Publisher) MessageDelta(run Run, seq int64, delta string) {
	p.publish(run.UserID.String(), ThreadEvent{
		Type: EventMessageDelta, ThreadID: run.ChatID.String(), SeqID: seq,
		Timestamp: p.now().UnixMilli(), RunID: run.ID.String(), MessageID: run.OutputMessageID.String(),
		Payload: MessageDeltaPayload{Delta: delta},
	})
}

func (p *Publisher) MessageCompleted(run Run, message Message, seq int64, eventError *ProtocolError) {
	completedAt := message.UpdatedAt
	if message.CompletedAt != nil {
		completedAt = *message.CompletedAt
	}
	p.publish(run.UserID.String(), ThreadEvent{
		Type: EventMessageCompleted, ThreadID: run.ChatID.String(), SeqID: seq,
		Timestamp: p.now().UnixMilli(), RunID: run.ID.String(), MessageID: message.ID.String(),
		Payload: MessageCompletedPayload{
			Role: message.Role, Content: message.Content, Format: message.ContentFormat,
			Status: message.Status, CreatedAt: message.CreatedAt.UnixMilli(),
			CompletedAt: completedAt.UnixMilli(), Error: eventError,
		},
	})
}

func (p *Publisher) ThinkingDelta(run Run, thinkingID string, seq int64, delta string) {
	p.publish(run.UserID.String(), ThreadEvent{
		Type: EventThinkingDelta, ThreadID: run.ChatID.String(), SeqID: seq,
		Timestamp: p.now().UnixMilli(), RunID: run.ID.String(), ThinkingID: thinkingID,
		Payload: ThinkingDeltaPayload{Delta: delta},
	})
}

func (p *Publisher) ThinkingCompleted(run Run, thinkingID string, seq int64, content string) {
	p.publish(run.UserID.String(), ThreadEvent{
		Type: EventThinkingCompleted, ThreadID: run.ChatID.String(), SeqID: seq,
		Timestamp: p.now().UnixMilli(), RunID: run.ID.String(), ThinkingID: thinkingID,
		Payload: ThinkingCompletedPayload{Content: content},
	})
}

func (p *Publisher) ToolStarted(run Run, toolCallID string, seq int64, payload ToolStartedPayload) {
	p.publish(run.UserID.String(), ThreadEvent{
		Type: EventToolStarted, ThreadID: run.ChatID.String(), SeqID: seq,
		Timestamp: p.now().UnixMilli(), RunID: run.ID.String(), ToolCallID: toolCallID, Payload: payload,
	})
}

func (p *Publisher) ToolCompleted(run Run, toolCallID string, seq int64, payload ToolCompletedPayload) {
	p.publish(run.UserID.String(), ThreadEvent{
		Type: EventToolCompleted, ThreadID: run.ChatID.String(), SeqID: seq,
		Timestamp: p.now().UnixMilli(), RunID: run.ID.String(), ToolCallID: toolCallID, Payload: payload,
	})
}

func (p *Publisher) ToolFailed(run Run, toolCallID string, seq int64, eventError ProtocolError) {
	p.publish(run.UserID.String(), ThreadEvent{
		Type: EventToolFailed, ThreadID: run.ChatID.String(), SeqID: seq,
		Timestamp: p.now().UnixMilli(), RunID: run.ID.String(), ToolCallID: toolCallID,
		Payload: ToolFailedPayload{Error: eventError},
	})
}

func (p *Publisher) publish(userID string, event ThreadEvent) {
	p.hub.PublishToUser(userID, event)
}
