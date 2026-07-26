// 负责解析和校验 WebSocket 客户端指令，并分发到对应 Chat 业务方法。
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

	"github.com/google/uuid"
)

const (
	maxRequestIDLength      = 128
	maxIdempotencyKeyLength = 128
	maxUserMessageRunes     = 32 * 1024
)

type CommandRouter struct {
	service   *Service
	runs      *RunManager
	publisher *Publisher
	logger    *slog.Logger
}

func NewCommandRouter(
	service *Service,
	runs *RunManager,
	publisher *Publisher,
	logger *slog.Logger,
) *CommandRouter {
	if logger == nil {
		logger = slog.Default()
	}
	return &CommandRouter{
		service:   service,
		runs:      runs,
		publisher: publisher,
		logger:    logger,
	}
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
		_ = r.publisher.Rejected(
			connection,
			envelope.RequestID,
			connection.ChatID(),
			envelope.Type,
			businessError,
		)
		return
	}

	switch envelope.Type {
	case CommandChatSubmit:
		r.handleSubmit(ctx, connection, envelope)
	case CommandRunCancel:
		r.handleCancel(ctx, connection, envelope)
	case CommandPing:
		r.handlePing(connection, envelope)
	default:
		_ = r.publisher.Rejected(
			connection,
			envelope.RequestID,
			connection.ChatID(),
			envelope.Type,
			newBusinessError(
				ErrorInvalidEnvelope,
				"不支持的指令类型",
				false,
				http.StatusBadRequest,
			),
		)
	}
}

func (r *CommandRouter) handleSubmit(
	ctx context.Context,
	connection *Connection,
	envelope ClientEnvelope,
) {
	chatID, businessError := validateChatCommand(
		connection,
		envelope,
	)
	if businessError != nil {
		r.reject(connection, envelope, businessError)
		return
	}
	if envelope.RunID != nil {
		r.reject(
			connection,
			envelope,
			invalidEnvelope("chat.submit 不能携带 run_id"),
		)
		return
	}

	idempotencyKey, businessError := requireIdempotencyKey(envelope)
	if businessError != nil {
		r.reject(connection, envelope, businessError)
		return
	}

	var payload ChatSubmitPayload
	if err := decodeStrictJSON(envelope.Payload, &payload); err != nil {
		r.reject(
			connection,
			envelope,
			invalidEnvelope("chat.submit payload 不合法"),
		)
		return
	}
	content := strings.TrimSpace(payload.Content.Text)
	if payload.Content.Type != "text" ||
		content == "" ||
		utf8.RuneCountInString(content) > maxUserMessageRunes {
		r.reject(
			connection,
			envelope,
			invalidEnvelope("消息文本不能为空且不能超过 32768 个字符"),
		)
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
		idempotencyKey,
		content,
	)
	if err != nil {
		r.rejectError(connection, envelope, err)
		return
	}

	// ACK 先进入同一个连接的发送队列，随后启动 Run，保证客户端先看到接管确认。
	ackError := r.publisher.ChatAccepted(
		connection,
		envelope.RequestID,
		record,
	)
	if !record.Duplicate {
		// 即使 ACK 因为浏览器刚好断线而发送失败，
		// 已经提交到数据库的 Run 也必须脱离连接继续执行。
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
	chatID, businessError := validateChatCommand(
		connection,
		envelope,
	)
	if businessError != nil {
		r.reject(connection, envelope, businessError)
		return
	}
	if _, businessError := requireIdempotencyKey(envelope); businessError != nil {
		r.reject(connection, envelope, businessError)
		return
	}
	if envelope.RunID == nil {
		r.reject(
			connection,
			envelope,
			invalidEnvelope("run.cancel 必须携带 run_id"),
		)
		return
	}
	runID, err := uuid.Parse(*envelope.RunID)
	if err != nil {
		r.reject(
			connection,
			envelope,
			invalidEnvelope("run_id 格式不合法"),
		)
		return
	}

	var payload RunCancelPayload
	if err := decodeStrictJSON(envelope.Payload, &payload); err != nil {
		r.reject(
			connection,
			envelope,
			invalidEnvelope("run.cancel payload 不合法"),
		)
		return
	}
	if payload.Reason != "" && payload.Reason != "user_requested" {
		r.reject(
			connection,
			envelope,
			invalidEnvelope("当前只支持 user_requested 取消原因"),
		)
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
	duplicate, err := r.runs.Cancel(ctx, run)
	if err != nil {
		r.rejectError(connection, envelope, err)
		return
	}

	_ = r.publisher.CancelAccepted(
		connection,
		envelope.RequestID,
		chatID.String(),
		runID.String(),
		duplicate,
	)
}

func (r *CommandRouter) handlePing(
	connection *Connection,
	envelope ClientEnvelope,
) {
	var payload PingPayload
	if err := decodeStrictJSON(envelope.Payload, &payload); err != nil {
		r.reject(
			connection,
			envelope,
			invalidEnvelope("ping payload 不合法"),
		)
		return
	}
	_ = r.publisher.Pong(
		connection,
		envelope.RequestID,
		payload.ClientTime,
	)
}

func (r *CommandRouter) reject(
	connection *Connection,
	envelope ClientEnvelope,
	businessError *BusinessError,
) {
	_ = r.publisher.Rejected(
		connection,
		envelope.RequestID,
		connection.ChatID(),
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
	r.reject(
		connection,
		envelope,
		newBusinessError(
			ErrorInternal,
			"服务暂时不可用",
			true,
			http.StatusInternalServerError,
		),
	)
}

func validateBaseEnvelope(
	envelope ClientEnvelope,
) *BusinessError {
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

func validateChatCommand(
	connection *Connection,
	envelope ClientEnvelope,
) (uuid.UUID, *BusinessError) {
	if envelope.ChatID == nil ||
		*envelope.ChatID != connection.ChatID() {
		return uuid.Nil, invalidEnvelope(
			"chat_id 必须与当前 WebSocket 路由一致",
		)
	}
	chatID, err := uuid.Parse(*envelope.ChatID)
	if err != nil {
		return uuid.Nil, invalidEnvelope("chat_id 格式不合法")
	}
	return chatID, nil
}

func requireIdempotencyKey(
	envelope ClientEnvelope,
) (string, *BusinessError) {
	if envelope.IdempotencyKey == nil {
		return "", invalidEnvelope("缺少 idempotency_key")
	}
	value := strings.TrimSpace(*envelope.IdempotencyKey)
	if value == "" || len(value) > maxIdempotencyKeyLength {
		return "", invalidEnvelope(
			"idempotency_key 不能为空且不能超过 128 字节",
		)
	}
	return value, nil
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
