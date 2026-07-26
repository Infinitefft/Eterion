// 负责定义 Chat HTTP 接口和 WebSocket 指令共同使用的业务错误。
package chat

import "fmt"

const (
	ErrorInvalidEnvelope = "INVALID_ENVELOPE"
	ErrorForbidden       = "FORBIDDEN"
	ErrorChatNotFound    = "CHAT_NOT_FOUND"
	ErrorRunNotFound     = "RUN_NOT_FOUND"
	ErrorRunActive       = "RUN_ACTIVE"
	ErrorInvalidRunState = "INVALID_RUN_STATE"
	ErrorPayloadTooLarge = "PAYLOAD_TOO_LARGE"
	ErrorInternal        = "INTERNAL_ERROR"
)

// BusinessError 使用稳定的 Code 供前端判断，Message 只用于用户展示。
type BusinessError struct {
	Code       string
	Message    string
	Retryable  bool
	HTTPStatus int
	Cause      error
}

func (e *BusinessError) Error() string {
	if e.Cause == nil {
		return e.Code
	}
	return fmt.Sprintf("%s: %v", e.Code, e.Cause)
}

// Unwrap 让 errors.Is 和 errors.As 可以继续检查底层错误。
func (e *BusinessError) Unwrap() error {
	return e.Cause
}

func newBusinessError(
	code string,
	message string,
	retryable bool,
	httpStatus int,
) *BusinessError {
	return &BusinessError{
		Code:       code,
		Message:    message,
		Retryable:  retryable,
		HTTPStatus: httpStatus,
	}
}
