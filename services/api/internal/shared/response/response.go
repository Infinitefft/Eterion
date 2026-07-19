package response

import (
	"github.com/Infinitefft/Eterion/services/api/internal/middleware"
	apperrors "github.com/Infinitefft/Eterion/services/api/internal/shared/errors"
	"github.com/gin-gonic/gin"
)

type successEnvelope struct {
	Data      any    `json:"data"`
	RequestID string `json:"request_id,omitempty"`
}

type errorBody struct {
	Code       string            `json:"code"`
	Message    string            `json:"message"`
	NextAction string            `json:"next_action"`
	Fields     map[string]string `json:"fields,omitempty"`
}

type errorEnvelope struct {
	Error     errorBody `json:"error"`
	RequestID string    `json:"request_id,omitempty"`
}

func JSON(c *gin.Context, status int, data any) {
	c.JSON(status, successEnvelope{Data: data, RequestID: middleware.RequestID(c)})
}

func Error(c *gin.Context, appErr *apperrors.Error) {
	c.AbortWithStatusJSON(appErr.Status, errorEnvelope{
		Error: errorBody{
			Code:       appErr.Code,
			Message:    appErr.Message,
			NextAction: appErr.NextAction,
			Fields:     appErr.Fields,
		},
		RequestID: middleware.RequestID(c),
	})
}
