package knowledge

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/config"
	"github.com/Infinitefft/Eterion/services/api/internal/modules/auth"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func TestFileHTTPFlow(t *testing.T) {
	gin.SetMode(gin.TestMode)
	userID, baseID, sessionID := uuid.New(), uuid.New(), uuid.New()
	authRepo := &testAuthRepository{
		user:    auth.User{ID: userID, Status: auth.UserStatusActive},
		session: auth.AuthSession{ID: sessionID, UserID: userID, ExpiresAt: time.Now().Add(time.Hour)},
	}
	cfg := config.Config{JWTAccessSecret: strings.Repeat("s", 32), JWTIssuer: "test"}
	tokens := auth.NewTokenManager(cfg.JWTAccessSecret, cfg.JWTIssuer, "test", time.Hour)
	authService, err := auth.NewService(authRepo, tokens, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	authHandler, err := auth.NewHandler(authService, config.Config{}, logger)
	if err != nil {
		t.Fatal(err)
	}
	accessToken, _, err := tokens.CreateAccessToken(userID, sessionID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	repo := &fileTestRepository{owner: userID, base: baseID, saved: make(map[string]*KnowledgeFile)}
	store := &fileTestStore{}
	engine := gin.New()
	NewFileHandler(NewFileService(repo, store), logger).RegisterRoutes(engine.Group("/api"), authHandler.RequireAccessToken())
	baseURL := "/api/knowledge-bases/" + baseID.String() + "/files"
	call := func(method, url, token string, names []string, size int) *httptest.ResponseRecorder {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		for _, name := range names {
			part, err := writer.CreateFormFile("file", name)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = part.Write(bytes.Repeat([]byte("x"), size)); err != nil {
				t.Fatal(err)
			}
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(method, url, &body)
		request.Header.Set("Content-Type", writer.FormDataContentType())
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		result := httptest.NewRecorder()
		engine.ServeHTTP(result, request)
		return result
	}
	for _, test := range []struct {
		name, url, token string
		names            []string
		size, status     int
	}{
		{"anonymous", baseURL, "", []string{"a.txt"}, 5, 401},
		{"invalid ID", "/api/knowledge-bases/bad/files", accessToken, []string{"a.txt"}, 5, 400},
		{"foreign base", "/api/knowledge-bases/" + uuid.NewString() + "/files", accessToken, []string{"a.txt"}, 5, 404},
		{"missing file", baseURL, accessToken, nil, 0, 400},
		{"multiple files", baseURL, accessToken, []string{"a.txt", "b.txt"}, 5, 400},
		{"empty file", baseURL, accessToken, []string{"a.txt"}, 0, 400},
		{"unsupported file", baseURL, accessToken, []string{"a.exe"}, 5, 400},
		{"too large", baseURL, accessToken, []string{"a.txt"}, int(maxFileBytes) + 1, 413},
		{"success", baseURL, accessToken, []string{"笔记.txt"}, 5, 201},
	} {
		t.Run(test.name, func(t *testing.T) {
			result := call(http.MethodPost, test.url, test.token, test.names, test.size)
			if result.Code != test.status {
				t.Fatalf("status=%d body=%s", result.Code, result.Body.String())
			}
		})
	}
	result := call(http.MethodGet, baseURL, accessToken, nil, 0)
	var list struct{ Data []KnowledgeFile }
	if err := json.Unmarshal(result.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if result.Code != 200 || len(list.Data) != 1 || list.Data[0].SizeBytes != 5 || store.calls != 1 {
		t.Fatalf("unexpected list: %s", result.Body.String())
	}
	contentURL := baseURL + "/" + list.Data[0].ID.String() + "/content"
	result = call(http.MethodGet, contentURL, "", nil, 0)
	if result.Code != 401 {
		t.Fatal("content must require login")
	}
	result = call(http.MethodGet, contentURL, accessToken, nil, 0)
	var content struct{ Data FileContent }
	if err := json.Unmarshal(result.Body.Bytes(), &content); err != nil {
		t.Fatal(err)
	}
	if result.Code != 200 || content.Data.Content != "xxxxx" || content.Data.Format != "txt" || result.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("content: %s", result.Body.String())
	}
	deleteURL := baseURL + "/" + list.Data[0].ID.String()
	if result := call(http.MethodDelete, deleteURL, "", nil, 0); result.Code != 401 {
		t.Fatal("delete must require auth")
	}
	if result := call(http.MethodDelete, baseURL+"/invalid", accessToken, nil, 0); result.Code != 400 {
		t.Fatal("invalid id accepted")
	}
	for attempt := 0; attempt < 2; attempt++ {
		if result := call(http.MethodDelete, deleteURL, accessToken, nil, 0); result.Code != 204 {
			t.Fatalf("delete: %s", result.Body.String())
		}
	}
	if len(repo.saved) != 0 {
		t.Fatal("deleted file remains")
	}
	baseDeleteURL := "/api/knowledge-bases/" + repo.base.String()
	if result := call(http.MethodDelete, baseDeleteURL, "", nil, 0); result.Code != 401 {
		t.Fatal("base delete must require auth")
	}
	if result := call(http.MethodDelete, "/api/knowledge-bases/invalid", accessToken, nil, 0); result.Code != 400 {
		t.Fatal("invalid base id accepted")
	}
	if result := call(http.MethodDelete, baseDeleteURL, accessToken, nil, 0); result.Code != 204 {
		t.Fatalf("base delete: %d %s", result.Code, result.Body.String())
	}
}
