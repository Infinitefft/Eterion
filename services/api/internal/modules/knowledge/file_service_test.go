package knowledge

import (
	"context"
	"errors"
	"github.com/Infinitefft/Eterion/services/api/internal/agent"
	apperrors "github.com/Infinitefft/Eterion/services/api/internal/shared/errors"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"io"
	"strings"
	"testing"
)

type fileTestIndexer struct{}

func (fileTestIndexer) IngestFile(context.Context, uuid.UUID, string, string, ...agent.IngestionMonitoring) error {
	return nil
}

type fileTestRepository struct {
	owner, base uuid.UUID
	saved       map[string]*KnowledgeFile
	saveErr     error
}

func (r *fileTestRepository) DeleteBase(_ context.Context, baseID, userID uuid.UUID) error {
	if r.saveErr != nil {
		return r.saveErr
	}
	if len(r.saved) != 0 {
		return errors.New("files remain")
	}
	if r.base == baseID && r.owner == userID {
		r.base = uuid.Nil
	}
	return nil
}

func TestDeleteBase(t *testing.T) {
	ctx := context.Background()
	repo := &fileTestRepository{owner: uuid.New(), base: uuid.New(), saved: make(map[string]*KnowledgeFile)}
	baseID := repo.base
	file := &KnowledgeFile{ID: uuid.New(), KnowledgeBaseID: baseID, ObjectKey: "file"}
	repo.saved[file.ObjectKey] = file
	store := &fileTestStore{}
	service := NewFileService(repo, store, fileTestIndexer{})
	assertFileError(t, service.DeleteBase(ctx, uuid.New(), baseID), "KNOWLEDGE_BASE_NOT_FOUND")
	if store.calls != 0 {
		t.Fatal("unauthorized OSS deletion")
	}
	store.err = errors.New("OSS failure")
	assertFileError(t, service.DeleteBase(ctx, repo.owner, baseID), "FILE_STORAGE_ERROR")
	if repo.base != baseID || len(repo.saved) != 1 {
		t.Fatal("failure must retain records")
	}
	store.err = nil
	if err := service.DeleteBase(ctx, repo.owner, baseID); err != nil {
		t.Fatal(err)
	}
	if repo.base != uuid.Nil || len(repo.saved) != 0 {
		t.Fatal("base and files must be removed")
	}
	repo.base = uuid.New()
	if err := NewFileService(repo, nil, fileTestIndexer{}).DeleteBase(ctx, repo.owner, repo.base); err != nil {
		t.Fatal("empty base needs no OSS", err)
	}
}

func (r *fileTestRepository) OwnsBase(_ context.Context, base, user uuid.UUID) (bool, error) {
	return r.owner == user && r.base == base, nil
}
func (r *fileTestRepository) SaveFile(_ context.Context, file *KnowledgeFile) (*KnowledgeFile, error) {
	if r.saveErr != nil {
		return nil, r.saveErr
	}
	r.saved[file.ObjectKey] = file
	return file, nil
}
func (r *fileTestRepository) ListFiles(_ context.Context, _ uuid.UUID) ([]KnowledgeFile, error) {
	result := make([]KnowledgeFile, 0)
	for _, file := range r.saved {
		result = append(result, *file)
	}
	return result, nil
}

type fileTestStore struct {
	data      []byte
	key, mime string
	err       error
	calls     int
}

func (s *fileTestStore) Delete(_ context.Context, key string) error {
	s.calls++
	s.key = key
	return s.err
}
func (r *fileTestRepository) DeleteFile(_ context.Context, baseID, fileID uuid.UUID) error {
	if r.saveErr != nil {
		return r.saveErr
	}
	for key, file := range r.saved {
		if file.ID == fileID && file.KnowledgeBaseID == baseID {
			delete(r.saved, key)
		}
	}
	return nil
}

func TestDeleteFile(t *testing.T) {
	ctx := context.Background()
	repo := &fileTestRepository{owner: uuid.New(), base: uuid.New(), saved: make(map[string]*KnowledgeFile)}
	file := &KnowledgeFile{ID: uuid.New(), KnowledgeBaseID: repo.base, ObjectKey: "stored-key"}
	repo.saved[file.ObjectKey] = file
	store := &fileTestStore{}
	service := NewFileService(repo, store, fileTestIndexer{})
	assertFileError(t, service.Delete(ctx, uuid.New(), repo.base, file.ID), "KNOWLEDGE_BASE_NOT_FOUND")
	if store.calls != 0 {
		t.Fatal("unauthorized deletion")
	}
	if err := service.Delete(ctx, repo.owner, repo.base, uuid.New()); err != nil {
		t.Fatal(err)
	}
	if store.calls != 0 {
		t.Fatal("missing record should not access OSS")
	}
	store.err = errors.New("OSS failed")
	assertFileError(t, service.Delete(ctx, repo.owner, repo.base, file.ID), "FILE_STORAGE_ERROR")
	if len(repo.saved) != 1 {
		t.Fatal("OSS failure removed database record")
	}
	store.err = nil
	repo.saveErr = errors.New("DB failed")
	if err := service.Delete(ctx, repo.owner, repo.base, file.ID); !errors.Is(err, repo.saveErr) {
		t.Fatal("database failure hidden")
	}
	if len(repo.saved) != 1 {
		t.Fatal("record must remain for retry")
	}
	repo.saveErr = nil
	if err := service.Delete(ctx, repo.owner, repo.base, file.ID); err != nil {
		t.Fatal(err)
	}
	if len(repo.saved) != 0 || store.key != "stored-key" {
		t.Fatal("wrong deletion")
	}
	if err := service.Delete(ctx, repo.owner, repo.base, file.ID); err != nil {
		t.Fatal("repeat delete must succeed")
	}
}

func (r *fileTestRepository) FindFile(_ context.Context, baseID, fileID uuid.UUID) (*KnowledgeFile, error) {
	for _, file := range r.saved {
		if file.ID == fileID && file.KnowledgeBaseID == baseID {
			return file, nil
		}
	}
	return nil, gorm.ErrRecordNotFound
}
func (s *fileTestStore) Get(_ context.Context, key string) (io.ReadCloser, error) {
	s.calls++
	s.key = key
	if s.err != nil {
		return nil, s.err
	}
	return io.NopCloser(strings.NewReader(string(s.data))), nil
}

func TestFileContent(t *testing.T) {
	ctx := context.Background()
	repo := &fileTestRepository{owner: uuid.New(), base: uuid.New(), saved: make(map[string]*KnowledgeFile)}
	file := &KnowledgeFile{ID: uuid.New(), KnowledgeBaseID: repo.base, OriginalName: "note.md", ObjectKey: "stored-key", SizeBytes: 10}
	repo.saved[file.ObjectKey] = file
	store := &fileTestStore{data: []byte("\uFEFF# 标题")}
	service := NewFileService(repo, store, fileTestIndexer{})
	_, err := service.Content(ctx, uuid.New(), repo.base, file.ID)
	assertFileError(t, err, "KNOWLEDGE_BASE_NOT_FOUND")
	_, err = service.Content(ctx, repo.owner, repo.base, uuid.New())
	assertFileError(t, err, "KNOWLEDGE_FILE_NOT_FOUND")
	if store.calls != 0 {
		t.Fatal("unauthorized read reached OSS")
	}
	result, err := service.Content(ctx, repo.owner, repo.base, file.ID)
	if err != nil || result.Content != "# 标题" || result.Format != "md" || store.key != "stored-key" {
		t.Fatalf("preview: %v %v", result, err)
	}
	file.OriginalName = "old.pdf"
	_, err = service.Content(ctx, repo.owner, repo.base, file.ID)
	assertFileError(t, err, "PREVIEW_UNSUPPORTED")
	file.OriginalName = "note.txt"
	file.SizeBytes = maxPreviewBytes + 1
	_, err = service.Content(ctx, repo.owner, repo.base, file.ID)
	assertFileError(t, err, "PREVIEW_TOO_LARGE")
	file.SizeBytes = 1
	store.data = []byte(strings.Repeat("a", int(maxPreviewBytes)+1))
	_, err = service.Content(ctx, repo.owner, repo.base, file.ID)
	assertFileError(t, err, "PREVIEW_TOO_LARGE")
	store.data = []byte{0xff}
	_, err = service.Content(ctx, repo.owner, repo.base, file.ID)
	assertFileError(t, err, "PREVIEW_ENCODING_UNSUPPORTED")
	store.err = errors.New("OSS failure")
	_, err = service.Content(ctx, repo.owner, repo.base, file.ID)
	assertFileError(t, err, "FILE_STORAGE_ERROR")
}

func (s *fileTestStore) Put(_ context.Context, key, mime string, data []byte) error {
	s.calls++
	s.key = key
	s.mime = mime
	s.data = data
	return s.err
}
func assertFileError(t *testing.T, err error, code string) {
	t.Helper()
	var appErr *apperrors.Error
	if !errors.As(err, &appErr) || appErr.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}
func TestFileUploadLifecycle(t *testing.T) {
	ctx := context.Background()
	repo := &fileTestRepository{owner: uuid.New(), base: uuid.New(), saved: make(map[string]*KnowledgeFile)}
	store := &fileTestStore{}
	service := NewFileService(repo, store, fileTestIndexer{})
	_, err := service.Upload(ctx, uuid.New(), repo.base, "a.txt", []byte("hello"))
	assertFileError(t, err, "KNOWLEDGE_BASE_NOT_FOUND")
	if store.calls != 0 {
		t.Fatal("unauthorized upload reached OSS")
	}
	for _, name := range []string{"a.exe", "../a.txt", "a\\b.txt", "a\n.txt"} {
		_, err = service.Upload(ctx, repo.owner, repo.base, name, []byte("hello"))
		assertFileError(t, err, "VALIDATION_ERROR")
	}
	_, err = service.Upload(ctx, repo.owner, repo.base, "a.txt", nil)
	assertFileError(t, err, "VALIDATION_ERROR")
	store.err = errors.New("private storage details")
	_, err = service.Upload(ctx, repo.owner, repo.base, "a.txt", []byte("hello"))
	assertFileError(t, err, "FILE_STORAGE_ERROR")
	if len(repo.saved) != 0 {
		t.Fatal("failed upload persisted")
	}
	store.err = nil
	saved, err := service.Upload(ctx, repo.owner, repo.base, "笔记.txt", []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	if saved.ObjectKey != store.key || saved.SizeBytes != 5 || saved.MimeType != "text/plain" || string(store.data) != "hello" || !strings.HasPrefix(saved.ObjectKey, "knowledge/"+repo.owner.String()+"/"+repo.base.String()+"/") {
		t.Fatal("incorrect mapping")
	}
	repo.saveErr = errors.New("database failure")
	_, err = service.Upload(ctx, repo.owner, repo.base, "a.txt", []byte("hello"))
	if !errors.Is(err, repo.saveErr) {
		t.Fatal("database failure must not report success")
	}
	if len(repo.saved) != 1 {
		t.Fatal("unexpected record")
	}
	_, err = service.List(ctx, uuid.New(), repo.base)
	assertFileError(t, err, "KNOWLEDGE_BASE_NOT_FOUND")
	service.store = nil
	_, err = service.Upload(ctx, repo.owner, repo.base, "a.txt", []byte("hello"))
	assertFileError(t, err, "FILE_STORAGE_UNAVAILABLE")
}
