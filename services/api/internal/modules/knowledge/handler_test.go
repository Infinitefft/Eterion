package knowledge

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
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

type testRepository struct {
	created    *KnowledgeBase
	bases      []KnowledgeBase
	listedUser uuid.UUID
	err        error
}

func (r *testRepository) ListByUser(_ context.Context, userID uuid.UUID) ([]KnowledgeBase, error) {
	r.listedUser = userID
	return r.bases, r.err
}

func (r *testRepository) Create(_ context.Context, base *KnowledgeBase) error {
	r.created = base
	return r.err
}

// 使用真实认证中间件，仅替换它读取的用户与会话数据。
type testAuthRepository struct {
	auth.Repository
	user    auth.User
	session auth.AuthSession
}

func (r *testAuthRepository) FindUserByID(_ context.Context, id uuid.UUID) (*auth.User, error) {
	if id != r.user.ID {
		return nil, auth.ErrNotFound
	}
	return &r.user, nil
}

func (r *testAuthRepository) FindSessionByID(_ context.Context, id uuid.UUID) (*auth.AuthSession, error) {
	if id != r.session.ID {
		return nil, auth.ErrNotFound
	}
	return &r.session, nil
}

func TestCreateKnowledgeBase(t *testing.T) {
	gin.SetMode(gin.TestMode)
	userID := uuid.New()
	sessionID := uuid.New()
	authRepo := &testAuthRepository{
		user:    auth.User{ID: userID, Status: auth.UserStatusActive},
		session: auth.AuthSession{ID: sessionID, UserID: userID, ExpiresAt: time.Now().Add(time.Hour)},
	}
	tokens := auth.NewTokenManager(strings.Repeat("t", 32), "test", "test", time.Hour)
	authService, err := auth.NewService(authRepo, tokens, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	authHandler, err := auth.NewHandler(authService, config.Config{}, logger)
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := tokens.CreateAccessToken(userID, sessionID, time.Now())
	if err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		name                string
		bases               []KnowledgeBase
		anonymous, failRead bool
		status              int
	}{
		{name: "list bases", bases: []KnowledgeBase{{ID: uuid.New(), UserID: userID, Title: "资料", CreatedAt: time.Now(), UpdatedAt: time.Now()}}, status: 200},
		{name: "empty list", status: 200},
		{name: "list requires login", anonymous: true, status: 401},
		{name: "read failure", failRead: true, status: 500},
	} {
		t.Run(test.name, func(t *testing.T) {
			repo := &testRepository{bases: test.bases}
			if test.failRead {
				repo.err = errors.New("private database failure")
			}
			engine := gin.New()
			NewHandler(NewService(repo), logger).RegisterRoutes(engine.Group("/api"), authHandler.RequireAccessToken())
			request := httptest.NewRequest(http.MethodGet, "/api/knowledge-bases?user_id="+uuid.NewString(), nil)
			if !test.anonymous {
				request.Header.Set("Authorization", "Bearer "+token)
			}
			writer := httptest.NewRecorder()
			engine.ServeHTTP(writer, request)
			if writer.Code != test.status {
				t.Fatalf("status = %d, body = %s", writer.Code, writer.Body.String())
			}
			if test.anonymous {
				if repo.listedUser != uuid.Nil {
					t.Fatal("anonymous request reached repository")
				}
			} else if repo.listedUser != userID {
				t.Fatal("query did not use authenticated owner")
			}
			if strings.Contains(writer.Body.String(), "private database failure") {
				t.Fatal("database error leaked")
			}
			if test.status == 200 {
				var result struct {
					Data []KnowledgeBaseResponse `json:"data"`
				}
				if err := json.Unmarshal(writer.Body.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				if result.Data == nil || len(result.Data) != len(test.bases) {
					t.Fatalf("unexpected list: %s", writer.Body.String())
				}
				if len(test.bases) > 0 && (result.Data[0].ID != test.bases[0].ID.String() || result.Data[0].Title != test.bases[0].Title) {
					t.Fatal("incorrect list fields")
				}
			}
		})
	}

	for _, test := range []struct {
		name, body, title, description, code, field string
		status                                      int
		anonymous, failWrite                        bool
	}{
		{name: "create with description", body: `{"title":" 前端工程 ","description":" 技术资料 "}`, title: "前端工程", description: "技术资料", status: 201},
		{name: "optional description", body: `{"title":"前端工程"}`, title: "前端工程", status: 201},
		{name: "null description", body: `{"title":"资料","description":null}`, title: "资料", status: 201},
		{name: "owner cannot be supplied", body: `{"title":"资料","user_id":"` + uuid.NewString() + `"}`, title: "资料", status: 201},
		{name: "unicode boundary", body: `{"title":"` + strings.Repeat("中", 120) + `","description":"` + strings.Repeat("文", 2000) + `"}`, title: strings.Repeat("中", 120), description: strings.Repeat("文", 2000), status: 201},
		{name: "blank title", body: `{"title":" \n\t "}`, status: 400, code: "VALIDATION_ERROR", field: "title"},
		{name: "missing title", body: `{}`, status: 400, code: "VALIDATION_ERROR", field: "title"},
		{name: "long title", body: `{"title":"` + strings.Repeat("中", 121) + `"}`, status: 400, code: "VALIDATION_ERROR", field: "title"},
		{name: "long description", body: `{"title":"资料","description":"` + strings.Repeat("文", 2001) + `"}`, status: 400, code: "VALIDATION_ERROR", field: "description"},
		{name: "wrong type", body: `{"title":12}`, status: 400, code: "VALIDATION_ERROR", field: "body"},
		{name: "malformed JSON", body: `{"title":`, status: 400, code: "VALIDATION_ERROR", field: "body"},
		{name: "body limit", body: `{"title":"` + strings.Repeat("a", 33000) + `"}`, status: 413, code: "REQUEST_TOO_LARGE"},
		{name: "unauthenticated", body: `{"title":"资料"}`, anonymous: true, status: 401, code: "AUTH_ACCESS_MISSING"},
		{name: "write failure", body: `{"title":"资料"}`, failWrite: true, status: 500, code: "INTERNAL_ERROR"},
	} {
		t.Run(test.name, func(t *testing.T) {
			repo := &testRepository{}
			if test.failWrite {
				repo.err = errors.New("private database failure")
			}
			engine := gin.New()
			NewHandler(NewService(repo), logger).RegisterRoutes(engine.Group("/api"), authHandler.RequireAccessToken())
			request := httptest.NewRequest(http.MethodPost, "/api/knowledge-bases", strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			if !test.anonymous {
				request.Header.Set("Authorization", "Bearer "+token)
			}
			writer := httptest.NewRecorder()
			engine.ServeHTTP(writer, request)
			if writer.Code != test.status {
				t.Fatalf("status = %d, body = %s", writer.Code, writer.Body.String())
			}
			var result struct {
				Data  KnowledgeBaseResponse `json:"data"`
				Error struct {
					Code   string            `json:"code"`
					Fields map[string]string `json:"fields"`
				} `json:"error"`
			}
			if err := json.Unmarshal(writer.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if test.status == 201 {
				if repo.created == nil || repo.created.UserID != userID {
					t.Fatal("incorrect owner")
				}
				if result.Data.Title != test.title || result.Data.Description != test.description {
					t.Fatalf("unexpected response: %+v", result.Data)
				}
				if result.Data.ID != repo.created.ID.String() || repo.created.ID == uuid.Nil || result.Data.CreatedAt.IsZero() || !result.Data.CreatedAt.Equal(result.Data.UpdatedAt) {
					t.Fatal("missing or inconsistent generated fields")
				}
			} else {
				if result.Error.Code != test.code {
					t.Fatalf("error code = %q", result.Error.Code)
				}
				if test.field != "" && result.Error.Fields[test.field] == "" {
					t.Fatalf("missing field error: %s", test.field)
				}
				if !test.failWrite && repo.created != nil {
					t.Fatal("invalid request reached persistence")
				}
				if strings.Contains(writer.Body.String(), "private database failure") {
					t.Fatal("database error leaked")
				}
			}
		})
	}
}
