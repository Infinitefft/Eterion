// Strictly validates WebSocket commands and dispatches them to chat services.
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
	maxRequestIDLength      = 128
	maxIdempotencyKeyLength = 128
	maxModelIDLength        = 64
	maxUserMessageRunes     = 32 * 1024
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
	router := &CommandRouter{
		service: service, runs: runs, publisher: publisher, logger: logger,
	}
	if len(modelCatalog) > 0 {
		router.models = modelCatalog[0]
	}
	return router
}

func (r *CommandRouter) HandleFrame(
	ctx context.Context,
	connection *Connection,
	frame []byte,
) {
	var envelope ClientEnvelope
	if err := decodeStrictJSON(frame, &envelope); err != nil {
		_ = r.publisher.ConnectionError(
			connection,
			ErrorInvalidEnvelope,
			"消息格式不符合 IM 协议",
			false,
		)
		return
	}
	if businessError := validateBaseEnvelope(envelope); businessError != nil {
		r.reject(connection, envelope, businessError)
		return
	}

	switch envelope.Type {
	case CommandChatStart:
		r.handleStart(ctx, connection, envelope)
	case CommandChatSubmit:
		r.handleSubmit(ctx, connection, envelope)
	case CommandRunCancel:
		r.handleCancel(ctx, connection, envelope)
	case CommandPing:
		r.handlePing(connection, envelope)
	default:
		r.reject(connection, envelope, invalidEnvelope("不支持的指令类型"))
	}
}

func (r *CommandRouter) handleStart(
	ctx context.Context,
	connection *Connection,
	envelope ClientEnvelope,
) {
	chatID, key, businessError := validateSubmitEnvelope(envelope)
	if businessError != nil {
		r.reject(connection, envelope, businessError)
		return
	}
	var payload ChatStartPayload
	if err := decodeStrictJSON(envelope.Payload, &payload); err != nil {
		r.reject(connection, envelope, invalidEnvelope("chat.start payload 不合法"))
		return
	}
	modelID, businessError := r.resolveModelID(payload.ModelID)
	if businessError != nil {
		r.reject(connection, envelope, businessError)
		return
	}
	messageID, businessError := validateMessagePayload(payload.MessageID, payload.Content)
	if businessError != nil {
		r.reject(connection, envelope, businessError)
		return
	}
	if payload.Title != nil && utf8.RuneCountInString(strings.TrimSpace(*payload.Title)) > maxChatTitleRunes {
		r.reject(connection, envelope, invalidEnvelope("Chat 标题不能超过 120 个字符"))
		return
	}
	userID, err := uuid.Parse(connection.UserID())
	if err != nil {
		r.rejectInternal(connection, envelope, err)
		return
	}
	record, err := r.service.StartChat(
		ctx,
		userID,
		chatID,
		messageID,
		key,
		modelID,
		payload.Title,
		strings.TrimSpace(payload.Content.Content),
		payload.Content.Format,
	)
	if err != nil {
		r.rejectError(connection, envelope, err)
		return
	}
	r.acceptAndStart(connection, envelope, record)
}

func (r *CommandRouter) handleSubmit(
	ctx context.Context,
	connection *Connection,
	envelope ClientEnvelope,
) {
	chatID, key, businessError := validateSubmitEnvelope(envelope)
	if businessError != nil {
		r.reject(connection, envelope, businessError)
		return
	}
	var payload ChatSubmitPayload
	if err := decodeStrictJSON(envelope.Payload, &payload); err != nil {
		r.reject(connection, envelope, invalidEnvelope("chat.submit payload 不合法"))
		return
	}
	modelID, businessError := r.resolveModelID(payload.ModelID)
	if businessError != nil {
		r.reject(connection, envelope, businessError)
		return
	}
	messageID, businessError := validateMessagePayload(payload.MessageID, payload.Content)
	if businessError != nil {
		r.reject(connection, envelope, businessError)
		return
	}
	userID, err := uuid.Parse(connection.UserID())
	if err != nil {
		r.rejectInternal(connection, envelope, err)
		return
	}
	record, err := r.service.Submit(
		ctx,
		userID,
		chatID,
		messageID,
		key,
		modelID,
		strings.TrimSpace(payload.Content.Content),
		payload.Content.Format,
	)
	if err != nil {
		r.rejectError(connection, envelope, err)
		return
	}
	r.acceptAndStart(connection, envelope, record)
}

func (r *CommandRouter) resolveModelID(rawModelID *string) (string, *BusinessError) {
	modelID := ""
	if rawModelID != nil {
		modelID = strings.TrimSpace(*rawModelID)
	}
	if len(modelID) > maxModelIDLength {
		return "", invalidEnvelope("model_id 不能超过 64 字节")
	}
	if r.models == nil {
		return modelID, nil
	}
	resolved, ok := r.models.ResolveModelID(modelID)
	if !ok {
		return "", newBusinessError(
			ErrorModelNotAvailable,
			"所选模型不可用",
			false,
			http.StatusBadRequest,
		)
	}
	return resolved, nil
}

func (r *CommandRouter) acceptAndStart(
	connection *Connection,
	envelope ClientEnvelope,
	record *SubmitRecord,
) {
	chatID := record.Run.ChatID.String()
	runID := record.Run.ID.String()
	ackError := r.publisher.Accepted(
		connection,
		envelope.RequestID,
		envelope.Type,
		&chatID,
		&runID,
	)
	if !record.Duplicate {
		r.runs.Start(record.Run)
	}
	if ackError != nil {
		return
	}
}

func (r *CommandRouter) handleCancel(
	ctx context.Context,
	connection *Connection,
	envelope ClientEnvelope,
) {
	chatID, businessError := requireChatID(envelope)
	if businessError != nil {
		r.reject(connection, envelope, businessError)
		return
	}
	if _, businessError := requireIdempotencyKey(envelope); businessError != nil {
		r.reject(connection, envelope, businessError)
		return
	}
	if envelope.RunID == nil {
		r.reject(connection, envelope, invalidEnvelope("run.cancel 必须携带 run_id"))
		return
	}
	runID, err := uuid.Parse(*envelope.RunID)
	if err != nil {
		r.reject(connection, envelope, invalidEnvelope("run_id 格式不合法"))
		return
	}
	var payload RunCancelPayload
	if err := decodeStrictJSON(envelope.Payload, &payload); err != nil || payload.Reason != "user_requested" {
		r.reject(connection, envelope, invalidEnvelope("run.cancel 只支持 user_requested"))
		return
	}
	userID, err := uuid.Parse(connection.UserID())
	if err != nil {
		r.rejectInternal(connection, envelope, err)
		return
	}
	run, err := r.service.FindRun(ctx, userID, chatID, runID)
	if err != nil {
		r.rejectError(connection, envelope, err)
		return
	}
	if _, err := r.runs.Cancel(ctx, run); err != nil {
		r.rejectError(connection, envelope, err)
		return
	}
	chatIDString := chatID.String()
	runIDString := runID.String()
	_ = r.publisher.Accepted(
		connection,
		envelope.RequestID,
		CommandRunCancel,
		&chatIDString,
		&runIDString,
	)
}

func (r *CommandRouter) handlePing(connection *Connection, envelope ClientEnvelope) {
	if envelope.IdempotencyKey != nil || envelope.ChatID != nil || envelope.RunID != nil {
		r.reject(connection, envelope, invalidEnvelope("ping 不能携带业务 ID"))
		return
	}
	var payload PingPayload
	if err := decodeStrictJSON(envelope.Payload, &payload); err != nil || payload.ClientTime <= 0 {
		r.reject(connection, envelope, invalidEnvelope("ping payload 不合法"))
		return
	}
	_ = r.publisher.Pong(connection, envelope.RequestID, payload.ClientTime)
}

func (r *CommandRouter) reject(
	connection *Connection,
	envelope ClientEnvelope,
	businessError *BusinessError,
) {
	_ = r.publisher.Rejected(
		connection,
		envelope.RequestID,
		envelope.ChatID,
		envelope.RunID,
		envelope.Type,
		businessError,
	)
}

func (r *CommandRouter) rejectError(
	connection *Connection,
	envelope ClientEnvelope,
	err error,
) {
	var businessError *BusinessError
	if errors.As(err, &businessError) {
		r.reject(connection, envelope, businessError)
		return
	}
	r.rejectInternal(connection, envelope, err)
}

func (r *CommandRouter) rejectInternal(
	connection *Connection,
	envelope ClientEnvelope,
	err error,
) {
	r.logger.Error(
		"websocket command failed",
		"connection_id", connection.ID(),
		"command_type", envelope.Type,
		"request_id", envelope.RequestID,
		"error", err,
	)
	r.reject(connection, envelope, newBusinessError(
		ErrorInternal,
		"服务暂时不可用",
		true,
		http.StatusInternalServerError,
	))
}

func validateBaseEnvelope(envelope ClientEnvelope) *BusinessError {
	requestID := strings.TrimSpace(envelope.RequestID)
	if requestID == "" || len(requestID) > maxRequestIDLength {
		return invalidEnvelope("request_id 不能为空且不能超过 128 字节")
	}
	if envelope.Type == "" {
		return invalidEnvelope("type 不能为空")
	}
	if envelope.Timestamp <= 0 {
		return invalidEnvelope("timestamp 必须是有效的 Unix 毫秒时间")
	}
	payload := bytes.TrimSpace(envelope.Payload)
	if len(payload) == 0 || payload[0] != '{' {
		return invalidEnvelope("payload 必须是 JSON 对象")
	}
	return nil
}

func validateSubmitEnvelope(
	envelope ClientEnvelope,
) (uuid.UUID, string, *BusinessError) {
	chatID, businessError := requireChatID(envelope)
	if businessError != nil {
		return uuid.Nil, "", businessError
	}
	if envelope.RunID != nil {
		return uuid.Nil, "", invalidEnvelope("Chat 指令不能携带 run_id")
	}
	key, businessError := requireIdempotencyKey(envelope)
	return chatID, key, businessError
}

func requireChatID(envelope ClientEnvelope) (uuid.UUID, *BusinessError) {
	if envelope.ChatID == nil {
		return uuid.Nil, invalidEnvelope("缺少 chat_id")
	}
	chatID, err := uuid.Parse(*envelope.ChatID)
	if err != nil {
		return uuid.Nil, invalidEnvelope("chat_id 格式不合法")
	}
	return chatID, nil
}

func requireIdempotencyKey(envelope ClientEnvelope) (string, *BusinessError) {
	if envelope.IdempotencyKey == nil {
		return "", invalidEnvelope("缺少 idempotency_key")
	}
	value := strings.TrimSpace(*envelope.IdempotencyKey)
	if value == "" || len(value) > maxIdempotencyKeyLength {
		return "", invalidEnvelope("idempotency_key 不能为空且不能超过 128 字节")
	}
	return value, nil
}

func validateMessagePayload(
	rawMessageID string,
	content TextContent,
) (uuid.UUID, *BusinessError) {
	messageID, err := uuid.Parse(rawMessageID)
	if err != nil {
		return uuid.Nil, invalidEnvelope("message_id 格式不合法")
	}
	text := strings.TrimSpace(content.Content)
	if content.Type != "text" ||
		(content.Format != TextFormatPlainText && content.Format != TextFormatMarkdown) ||
		text == "" || utf8.RuneCountInString(text) > maxUserMessageRunes {
		return uuid.Nil, invalidEnvelope("消息必须是有效文本且不能超过 32768 个字符")
	}
	return messageID, nil
}

func invalidEnvelope(message string) *BusinessError {
	return newBusinessError(
		ErrorInvalidEnvelope,
		message,
		false,
		http.StatusBadRequest,
	)
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
