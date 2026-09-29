package knowledge

import (
	"errors"
	"github.com/Infinitefft/Eterion/services/api/internal/modules/auth"
	apperrors "github.com/Infinitefft/Eterion/services/api/internal/shared/errors"
	"github.com/Infinitefft/Eterion/services/api/internal/shared/response"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"io"
	"log/slog"
	"net/http"
	"time"
)

type FileHandler struct {
	service *FileService
	logger  *slog.Logger
}

func NewFileHandler(service *FileService, logger *slog.Logger) *FileHandler {
	return &FileHandler{service: service, logger: logger}
}
func (h *FileHandler) RegisterRoutes(api *gin.RouterGroup, requireAccessToken gin.HandlerFunc) {
	group := api.Group("/knowledge-bases/:baseID", requireAccessToken)
	group.POST("/files", h.Upload)
	group.GET("/files", h.List)
	group.GET("/files/:fileID/content", h.Content)
	group.DELETE("/files/:fileID", h.Delete)
	group.DELETE("", h.DeleteBase)
}

func (h *FileHandler) DeleteBase(c *gin.Context) {
	userID, baseID, ok := fileRequestIDs(c)
	if !ok {
		return
	}
	controller := http.NewResponseController(c.Writer)
	_ = controller.SetWriteDeadline(time.Now().Add(3 * time.Minute))
	if err := h.service.DeleteBase(c.Request.Context(), userID, baseID); err != nil {
		h.writeError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *FileHandler) Delete(c *gin.Context) {
	userID, baseID, ok := fileRequestIDs(c)
	if !ok {
		return
	}
	fileID, err := uuid.Parse(c.Param("fileID"))
	if err != nil {
		response.Error(c, apperrors.Validation(map[string]string{"file_id": "文件 ID 必须是 UUID"}))
		return
	}
	if err := h.service.Delete(c.Request.Context(), userID, baseID, fileID); err != nil {
		h.writeError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *FileHandler) Content(c *gin.Context) {
	userID, baseID, ok := fileRequestIDs(c)
	if !ok {
		return
	}
	fileID, err := uuid.Parse(c.Param("fileID"))
	if err != nil {
		response.Error(c, apperrors.Validation(map[string]string{"file_id": "文件 ID 必须是 UUID"}))
		return
	}
	result, err := h.service.Content(c.Request.Context(), userID, baseID, fileID)
	if err != nil {
		h.writeError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	response.JSON(c, http.StatusOK, result)
}
func fileRequestIDs(c *gin.Context) (uuid.UUID, uuid.UUID, bool) {
	identity, ok := auth.IdentityFromContext(c)
	if !ok {
		response.Error(c, apperrors.Internal())
		return uuid.Nil, uuid.Nil, false
	}
	baseID, err := uuid.Parse(c.Param("baseID"))
	if err != nil {
		response.Error(c, apperrors.Validation(map[string]string{"base_id": "知识库 ID 必须是 UUID"}))
		return uuid.Nil, uuid.Nil, false
	}
	return identity.UserID, baseID, true
}
func (h *FileHandler) writeError(c *gin.Context, err error) {
	var appErr *apperrors.Error
	if errors.As(err, &appErr) {
		response.Error(c, appErr)
		return
	}
	h.logger.Error("knowledge file operation failed", "error", err)
	response.Error(c, apperrors.Internal())
}
func (h *FileHandler) Upload(c *gin.Context) {
	userID, baseID, ok := fileRequestIDs(c)
	if !ok {
		return
	}
	if err := h.service.checkOwner(c.Request.Context(), userID, baseID); err != nil {
		h.writeError(c, err)
		return
	}
	// 只延长上传路由期限，避免 20 MiB 上传被普通请求的短超时中断。
	controller := http.NewResponseController(c.Writer)
	_ = controller.SetReadDeadline(time.Now().Add(2 * time.Minute))
	_ = controller.SetWriteDeadline(time.Now().Add(13 * time.Minute))
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxFileBytes+64*1024)
	reader, err := c.Request.MultipartReader()
	if err != nil {
		response.Error(c, apperrors.Validation(map[string]string{"file": "请使用 multipart/form-data 上传文件"}))
		return
	}
	part, err := reader.NextPart()
	if err != nil {
		h.multipartError(c, err)
		return
	}
	defer part.Close()
	if part.FormName() != "file" || part.FileName() == "" {
		response.Error(c, apperrors.Validation(map[string]string{"file": "请提供一个名为 file 的文件字段"}))
		return
	}
	// 手工读取有界内存，避免 ParseMultipartForm/FormFile 自动落盘。
	data, err := io.ReadAll(io.LimitReader(part, maxFileBytes+1))
	if int64(len(data)) > maxFileBytes {
		response.Error(c, apperrors.New(413, "REQUEST_TOO_LARGE", "文件不能超过 20 MiB", "FIX_INPUT"))
		return
	}
	if err != nil {
		h.multipartError(c, err)
		return
	}
	if _, err = reader.NextPart(); err != io.EOF {
		if err == nil {
			response.Error(c, apperrors.Validation(map[string]string{"file": "每次请求仅上传一个文件"}))
		} else {
			h.multipartError(c, err)
		}
		return
	}
	result, err := h.service.Upload(c.Request.Context(), userID, baseID, part.FileName(), data)
	if err != nil {
		h.writeError(c, err)
		return
	}
	response.JSON(c, http.StatusCreated, result)
}
func (h *FileHandler) multipartError(c *gin.Context, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		response.Error(c, apperrors.New(413, "REQUEST_TOO_LARGE", "上传请求过大", "FIX_INPUT"))
		return
	}
	response.Error(c, apperrors.Validation(map[string]string{"file": "文件缺失或上传内容不完整"}))
}
func (h *FileHandler) List(c *gin.Context) {
	userID, baseID, ok := fileRequestIDs(c)
	if !ok {
		return
	}
	result, err := h.service.List(c.Request.Context(), userID, baseID)
	if err != nil {
		h.writeError(c, err)
		return
	}
	response.JSON(c, http.StatusOK, result)
}
