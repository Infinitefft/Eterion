package apperrors

import "net/http"

type Error struct {
	Status     int
	Code       string
	Message    string
	NextAction string
	Fields     map[string]string
}

func (e *Error) Error() string {
	return e.Code
}

func New(status int, code, message, nextAction string) *Error {
	return &Error{Status: status, Code: code, Message: message, NextAction: nextAction}
}

func Validation(fields map[string]string) *Error {
	return &Error{
		Status:     http.StatusBadRequest,
		Code:       "VALIDATION_ERROR",
		Message:    "请求参数不合法",
		NextAction: "FIX_INPUT",
		Fields:     fields,
	}
}

func Internal() *Error {
	return New(http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用", "RETRY_LATER")
}
