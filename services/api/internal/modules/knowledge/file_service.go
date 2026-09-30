package knowledge

import (
	"context"
	"errors"
	"github.com/Infinitefft/Eterion/services/api/internal/agent"
	apperrors "github.com/Infinitefft/Eterion/services/api/internal/shared/errors"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"io"
	"path"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const maxFileBytes int64 = 20 * 1024 * 1024
const maxPreviewBytes int64 = 1024 * 1024

var fileMimeTypes = map[string]string{
	".txt": "text/plain", ".md": "text/markdown",
}

type FileService struct {
	repository FileRepository
	store      FileStore
	indexer    FileIndexer
}

type FileIndexer interface {
	IngestFile(context.Context, uuid.UUID, string, string, ...agent.IngestionMonitoring) error
}

func NewFileService(repository FileRepository, store FileStore, indexer FileIndexer) *FileService {
	return &FileService{repository: repository, store: store, indexer: indexer}
}
func (s *FileService) checkOwner(ctx context.Context, userID, baseID uuid.UUID) error {
	owned, err := s.repository.OwnsBase(ctx, baseID, userID)
	if err != nil {
		return err
	}
	if !owned {
		return apperrors.New(404, "KNOWLEDGE_BASE_NOT_FOUND", "知识库不存在", "FIX_INPUT")
	}
	return nil
}
func (s *FileService) Upload(ctx context.Context, userID, baseID uuid.UUID, name string, data []byte) (*KnowledgeFile, error) {
	if err := s.checkOwner(ctx, userID, baseID); err != nil {
		return nil, err
	}
	if s.store == nil {
		return nil, apperrors.New(503, "FILE_STORAGE_UNAVAILABLE", "文件存储尚未配置", "RETRY_LATER")
	}
	fields := make(map[string]string)
	if strings.TrimSpace(name) == "" || utf8.RuneCountInString(name) > 255 || strings.ContainsAny(name, "/\\") || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		fields["file"] = "文件名无效，最多 255 个字符，不能包含路径或控制字符"
	}
	mimeType, supported := fileMimeTypes[strings.ToLower(path.Ext(name))]
	if !supported {
		fields["file"] = "目前仅支持 TXT 和 Markdown 文件"
	}
	if len(data) == 0 || int64(len(data)) > maxFileBytes {
		fields["file"] = "文件不能为空，且不能超过 20 MiB"
	}
	if !utf8.Valid(data) || strings.IndexByte(string(data), 0) >= 0 {
		fields["file"] = "请上传 UTF-8 编码的文本文件"
	}
	if len(fields) > 0 {
		return nil, apperrors.Validation(fields)
	}
	fileID := uuid.New()
	key := "knowledge/" + userID.String() + "/" + baseID.String() + "/" + fileID.String() + strings.ToLower(path.Ext(name))
	if err := s.store.Put(ctx, key, mimeType, data); err != nil {
		return nil, apperrors.New(502, "FILE_STORAGE_ERROR", "上传到 OSS 失败，请稍后重试", "RETRY_LATER")
	}
	now := time.Now().UTC()
	// 数据库错误不盲目删除 OSS 对象：连接中断时提交结果可能不确定。
	file, err := s.repository.SaveFile(ctx, &KnowledgeFile{ID: fileID, KnowledgeBaseID: baseID, OriginalName: name, ObjectKey: key, MimeType: mimeType, SizeBytes: int64(len(data)), CreatedAt: now, UpdatedAt: now})
	if err != nil {
		return nil, err
	}
	// OSS 和业务记录已保存，索引失败不补偿删除，也不再次上传。
	// 监控采集：身份取自已鉴权的上传上下文，仅供独立监控归属；记录失败不影响业务执行。
	monitoring := agent.IngestionMonitoring{UserID: userID.String(), KnowledgeBaseID: baseID.String(), FileName: file.OriginalName}
	if s.indexer == nil || s.indexer.IngestFile(ctx, file.ID, strings.TrimPrefix(strings.ToLower(path.Ext(name)), "."), string(data), monitoring) != nil {
		return nil, apperrors.New(502, "FILE_INDEXING_FAILED", "文件已保存，但索引未完成，请刷新文件列表确认结果", "REFRESH_LIST")
	}
	return file, nil
}
func (s *FileService) List(ctx context.Context, userID, baseID uuid.UUID) ([]KnowledgeFile, error) {
	if err := s.checkOwner(ctx, userID, baseID); err != nil {
		return nil, err
	}
	return s.repository.ListFiles(ctx, baseID)
}

type FileContent struct {
	Content string `json:"content"`
	Format  string `json:"format"`
}

func (s *FileService) Delete(ctx context.Context, userID, baseID, fileID uuid.UUID) error {
	if err := s.checkOwner(ctx, userID, baseID); err != nil {
		return err
	}
	file, err := s.repository.FindFile(ctx, baseID, fileID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if s.store == nil {
		return apperrors.New(503, "FILE_STORAGE_UNAVAILABLE", "文件存储尚未配置", "RETRY_LATER")
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	// 先删 OSS，再删记录。OSS 失败时保留 object_key；数据库失败可再次删除重试。
	if err := s.store.Delete(ctx, file.ObjectKey); err != nil {
		return apperrors.New(502, "FILE_STORAGE_ERROR", "删除 OSS 文件失败，请稍后重试", "RETRY_LATER")
	}
	return s.repository.DeleteFile(ctx, baseID, fileID)
}

func (s *FileService) DeleteBase(ctx context.Context, userID, baseID uuid.UUID) error {
	if err := s.checkOwner(ctx, userID, baseID); err != nil {
		return err
	}
	files, err := s.repository.ListFiles(ctx, baseID)
	if err != nil {
		return err
	}
	// 复用文件删除顺序；中途失败保留知识库及尚未删除的记录，允许重试。
	for _, file := range files {
		if err := s.Delete(ctx, userID, baseID, file.ID); err != nil {
			return err
		}
	}
	return s.repository.DeleteBase(ctx, baseID, userID)
}

func (s *FileService) Content(ctx context.Context, userID, baseID, fileID uuid.UUID) (*FileContent, error) {
	return s.readContent(ctx, userID, baseID, fileID, false)
}

// Source 保留原始 BOM 和换行，供 RAG 的 UTF-16 原文偏移量定位使用。
func (s *FileService) Source(ctx context.Context, userID, baseID, fileID uuid.UUID) (*FileContent, error) {
	return s.readContent(ctx, userID, baseID, fileID, true)
}

func (s *FileService) readContent(ctx context.Context, userID, baseID, fileID uuid.UUID, source bool) (*FileContent, error) {
	if err := s.checkOwner(ctx, userID, baseID); err != nil {
		return nil, err
	}
	file, err := s.repository.FindFile(ctx, baseID, fileID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, apperrors.New(404, "KNOWLEDGE_FILE_NOT_FOUND", "文件不存在", "FIX_INPUT")
	}
	if err != nil {
		return nil, err
	}
	ext := strings.ToLower(path.Ext(file.OriginalName))
	if _, ok := fileMimeTypes[ext]; !ok {
		return nil, apperrors.New(415, "PREVIEW_UNSUPPORTED", "目前仅支持 TXT 和 Markdown 预览", "FIX_INPUT")
	}
	limit := maxPreviewBytes
	if source {
		limit = maxFileBytes
	}
	if file.SizeBytes > limit {
		return nil, apperrors.New(413, "PREVIEW_TOO_LARGE", "文件超过 1 MiB，暂不支持在线预览", "FIX_INPUT")
	}
	if s.store == nil {
		return nil, apperrors.New(503, "FILE_STORAGE_UNAVAILABLE", "文件存储尚未配置", "RETRY_LATER")
	}
	timeout := 8 * time.Second
	if source {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	body, err := s.store.Get(ctx, file.ObjectKey)
	if err != nil {
		return nil, apperrors.New(502, "FILE_STORAGE_ERROR", "读取 OSS 文件失败，请稍后重试", "RETRY_LATER")
	}
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, apperrors.New(502, "FILE_STORAGE_ERROR", "文件内容读取失败，请稍后重试", "RETRY_LATER")
	}
	if int64(len(data)) > limit {
		return nil, apperrors.New(413, "PREVIEW_TOO_LARGE", "文件超过 1 MiB，暂不支持在线预览", "FIX_INPUT")
	}
	if !utf8.Valid(data) || strings.IndexByte(string(data), 0) >= 0 {
		return nil, apperrors.New(415, "PREVIEW_ENCODING_UNSUPPORTED", "目前仅支持 UTF-8 编码的文本预览", "FIX_INPUT")
	}
	content := string(data)
	if !source {
		content = strings.TrimPrefix(content, "\uFEFF")
	}
	return &FileContent{Content: content, Format: strings.TrimPrefix(ext, ".")}, nil
}
