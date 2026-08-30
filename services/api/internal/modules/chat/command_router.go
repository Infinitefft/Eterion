// Strictly validates frontend IM commands and dispatches them to chat services.
package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
	"github.com/google/uuid"
)

const (
	maxRequestIDLength  = 128
	maxModelIDLength    = 64
	maxUserMessageRunes = 32 * 1024
)

type CommandRouter struct {
	service   *Service
	runs      *RunManager
	publisher *Publisher
	models    agent.ModelCatalog
	logger    *slog.Logger
}

func NewCommandRouter(
	service *Service,
	runs *RunManager,
	publisher *Publisher,
	logger *slog.Logger,
	modelCatalog ...agent.ModelCatalog,
) *CommandRouter {
	if logger == nil {
		logger = slog.Default()
	}
	router := &CommandRouter{service: service, runs: runs, publisher: publisher, logger: logger}
	if len(modelCatalog) > 0 {
		router.models = modelCatalog[0]
	}
	return router
}

func (r *CommandRouter) HandleFrame(ctx context.Context, connection *Connection, frame []byte) {
	var command ClientCommand
	if err := decodeStrictJSON(frame, &command); err != nil {
		// Best-effort decoding preserves requestId/type when an otherwise invalid
		// frame must be rejected.
		_ = json.Unmarshal(frame, &command)
		r.reject(connection, command, invalidEnvelope("消息格式不符合 IM 协议"))
		return
	}
	if businessError := validateBaseCommand(command); businessError != nil {
		r.reject(connection, command, businessError)
		return
	}

	switch command.Type {
	case CommandThreadStart:
		r.handleStart(ctx, connection, command)
	case CommandMessageSend:
		r.handleSend(ctx, connection, command)
	case CommandRunCancel:
		r.handleCancel(ctx, connection, command)
	case CommandInteractionRespond:
		r.handleInteractionRespond(connection, command)
	default:
		r.reject(connection, command, invalidEnvelope("不支持的指令类型"))
	}
}

func (r *CommandRouter) handleStart(ctx context.Context, connection *Connection, command ClientCommand) {
	if command.RunID != "" || command.InteractionID != "" {
		r.reject(connection, command, invalidEnvelope("thread.start 不能携带 runId 或 interactionId"))
		return
	}
	payload, messageID, modelID, businessError := r.validateMessageCommand(command)
	if businessError != nil {
		r.reject(connection, command, businessError)
		return
	}
	userID, err := uuid.Parse(connection.UserID())
	if err != nil {
		r.rejectInternal(connection, command, err)
		return
	}
	threadID, _ := uuid.Parse(command.ThreadID)
	record, err := r.service.StartChat(
		ctx, userID, threadID, messageID, messageID.String(), modelID, nil,
		strings.TrimSpace(payload.Content), TextFormatPlainText,
	)
	if err != nil {
		r.rejectError(connection, command, err)
		return
	}
	r.acceptAndStart(ctx, connection, command, record)
}

func (r *CommandRouter) handleSend(ctx context.Context, connection *Connection, command ClientCommand) {
	if command.RunID != "" || command.InteractionID != "" {
		r.reject(connection, command, invalidEnvelope("message.send 不能携带 runId 或 interactionId"))
		return
	}
	payload, messageID, modelID, businessError := r.validateMessageCommand(command)
	if businessError != nil {
		r.reject(connection, command, businessError)
		return
	}
	userID, err := uuid.Parse(connection.UserID())
	if err != nil {
		r.rejectInternal(connection, command, err)
		return
	}
	threadID, _ := uuid.Parse(command.ThreadID)
	record, err := r.service.Submit(
		ctx, userID, threadID, messageID, messageID.String(), modelID,
		strings.TrimSpace(payload.Content), TextFormatPlainText,
	)
	if err != nil {
		r.rejectError(connection, command, err)
		return
	}
	r.acceptAndStart(ctx, connection, command, record)
}

func (r *CommandRouter) validateMessageCommand(
	command ClientCommand,
) (MessageCommandPayload, uuid.UUID, string, *BusinessError) {
	if command.MessageID == "" {
		return MessageCommandPayload{}, uuid.Nil, "", invalidEnvelope("缺少 messageId")
	}
	messageID, err := uuid.Parse(command.MessageID)
	if err != nil {
		return MessageCommandPayload{}, uuid.Nil, "", invalidEnvelope("messageId 格式不合法")
	}
	var payload MessageCommandPayload
	if err := decodeStrictJSON(command.Payload, &payload); err != nil {
		return payload, uuid.Nil, "", invalidEnvelope("消息 payload 不合法")
	}
	payload.Content = strings.TrimSpace(payload.Content)
	if payload.Content == "" || utf8.RuneCountInString(payload.Content) > maxUserMessageRunes {
		return payload, uuid.Nil, "", invalidEnvelope("消息不能为空且不能超过 32768 个字符")
	}
	modelID, businessError := r.resolveModelID(payload.ModelID)
	return payload, messageID, modelID, businessError
}

func (r *CommandRouter) resolveModelID(rawModelID *string) (string, *BusinessError) {
	modelID := ""
	if rawModelID != nil {
		modelID = strings.TrimSpace(*rawModelID)
	}
	if len(modelID) > maxModelIDLength {
		return "", invalidEnvelope("modelId 不能超过 64 字节")
	}
	if r.models == nil {
		return modelID, nil
	}
	resolved, ok := r.models.ResolveModelID(modelID)
	if !ok {
		return "", newBusinessError(ErrorModelNotAvailable, "所选模型不可用", false, http.StatusBadRequest)
	}
	return resolved, nil
}

func (r *CommandRouter) acceptAndStart(
	ctx context.Context,
	connection *Connection,
	command ClientCommand,
	record *SubmitRecord,
) {
	if record.Duplicate {
		_ = r.publisher.Accepted(connection, command, *record)
		return
	}
	sequences, err := r.runs.ReservePending(ctx, *record)
	if err != nil {
		r.rejectInternal(connection, command, err)
		return
	}
	// ACK 只属于当前 WebSocket 连接。即使客户端刚好在这里断线，
	// 已经持久化的 Run 仍然要继续执行，用户重连后可通过 Snapshot 恢复。
	_ = r.publisher.Accepted(connection, command, *record)
	r.runs.PublishPending(*record, sequences)
	r.runs.Start(record.Run)
}

func (r *CommandRouter) handleCancel(ctx context.Context, connection *Connection, command ClientCommand) {
	if command.MessageID != "" || command.InteractionID != "" || len(bytes.TrimSpace(command.Payload)) != 0 {
		r.reject(connection, command, invalidEnvelope("run.cancel 包含不允许的字段"))
		return
	}
	runID, err := uuid.Parse(command.RunID)
	if err != nil {
		r.reject(connection, command, invalidEnvelope("runId 格式不合法"))
		return
	}
	userID, err := uuid.Parse(connection.UserID())
	if err != nil {
		r.rejectInternal(connection, command, err)
		return
	}
	threadID, _ := uuid.Parse(command.ThreadID)
	run, err := r.service.FindRun(ctx, userID, threadID, runID)
	if err != nil {
		r.rejectError(connection, command, err)
		return
	}
	if _, err := r.runs.Cancel(ctx, run); err != nil {
		r.rejectError(connection, command, err)
		return
	}
	_ = r.publisher.AcceptedRun(connection, command, *run)
}

func (r *CommandRouter) handleInteractionRespond(connection *Connection, command ClientCommand) {
	var payload InteractionRespondPayload
	if command.MessageID != "" || command.RunID == "" || command.InteractionID == "" ||
		decodeStrictJSON(command.Payload, &payload) != nil {
		r.reject(connection, command, invalidEnvelope("interaction.respond payload 不合法"))
		return
	}
	// The current Node runtime has no resumable HITL endpoint. Recognizing and
	// explicitly rejecting the command keeps the wire contract stable without
	// pretending that a run was resumed.
	r.reject(connection, command, newBusinessError(
		ErrorInteractionUnavailable, "当前 Agent Run 没有可回答的交互", false, http.StatusConflict,
	))
}

func (r *CommandRouter) reject(connection *Connection, command ClientCommand, businessError *BusinessError) {
	_ = r.publisher.Rejected(connection, command, businessError)
}

func (r *CommandRouter) rejectError(connection *Connection, command ClientCommand, err error) {
	var businessError *BusinessError
	if errors.As(err, &businessError) {
		r.reject(connection, command, businessError)
		return
	}
	r.rejectInternal(connection, command, err)
}

func (r *CommandRouter) rejectInternal(connection *Connection, command ClientCommand, err error) {
	r.logger.Error(
		"websocket command failed", "connection_id", connection.ID(),
		"command_type", command.Type, "request_id", command.RequestID, "error", err,
	)
	r.reject(connection, command, newBusinessError(ErrorInternal, "服务暂时不可用", true, http.StatusInternalServerError))
}

func validateBaseCommand(command ClientCommand) *BusinessError {
	requestID := strings.TrimSpace(command.RequestID)
	if requestID == "" || len(requestID) > maxRequestIDLength {
		return invalidEnvelope("requestId 不能为空且不能超过 128 字节")
	}
	if command.Type == "" {
		return invalidEnvelope("type 不能为空")
	}
	if _, err := uuid.Parse(command.ThreadID); err != nil {
		return invalidEnvelope("threadId 格式不合法")
	}
	return nil
}

func invalidEnvelope(message string) *BusinessError {
	return newBusinessError(ErrorInvalidEnvelope, message, false, http.StatusBadRequest)
}

func decodeStrictJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("JSON 后包含多余内容")
	}
	return nil
}
