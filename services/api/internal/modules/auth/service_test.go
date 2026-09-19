package auth

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/config"
	apperrors "github.com/Infinitefft/Eterion/services/api/internal/shared/errors"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type authTestRepository struct {
	tokens    map[string]*RefreshToken
	session   *AuthSession
	user      *User
	findErr   error
	revokeErr error
	revokes   int
}

func (r *authTestRepository) CreateUserAndSession(context.Context, *User, *AuthSession, *RefreshToken) error {
	panic("unexpected session creation")
}

func (r *authTestRepository) CreateSession(context.Context, *AuthSession, *RefreshToken) error {
	panic("unexpected session creation")
}

func (r *authTestRepository) FindUserByPhone(context.Context, string) (*User, error) {
	panic("unexpected phone lookup")
}

func (r *authTestRepository) FindUserByID(_ context.Context, id uuid.UUID) (*User, error) {
	if r.user == nil || r.user.ID != id {
		return nil, ErrNotFound
	}
	return r.user, nil
}

func (r *authTestRepository) FindSessionByID(_ context.Context, id uuid.UUID) (*AuthSession, error) {
	if r.session == nil || r.session.ID != id {
		return nil, ErrNotFound
	}
	return r.session, nil
}

func (r *authTestRepository) FindRefreshToken(_ context.Context, tokenHash string) (*RefreshToken, error) {
	if r.findErr != nil {
		return nil, r.findErr
	}
	token, ok := r.tokens[tokenHash]
	if !ok {
		return nil, ErrNotFound
	}
	return token, nil
}

func (r *authTestRepository) RevokeSessionAndTokens(_ context.Context, sessionID uuid.UUID, revokedAt time.Time) error {
	if r.revokeErr != nil {
		return r.revokeErr
	}
	r.revokes++
	r.session.RevokedAt = &revokedAt
	for _, token := range r.tokens {
		if token.SessionID == sessionID {
			token.RevokedAt = &revokedAt
		}
	}
	return nil
}

func newAuthTestService(t *testing.T) (*Service, *authTestRepository, string, time.Time) {
	t.Helper()
	now := time.Date(2026, time.September, 19, 12, 0, 0, 0, time.UTC)
	rawToken, err := GenerateRefreshToken()
	if err != nil {
		t.Fatal(err)
	}
	userID := uuid.New()
	sessionID := uuid.New()
	repository := &authTestRepository{
		tokens: map[string]*RefreshToken{
			HashRefreshToken(rawToken): {
				ID:        uuid.New(),
				SessionID: sessionID,
				TokenHash: HashRefreshToken(rawToken),
				ExpiresAt: now.Add(24 * time.Hour),
			},
		},
		session: &AuthSession{ID: sessionID, UserID: userID, ExpiresAt: now.Add(24 * time.Hour)},
		user:    &User{ID: userID, Phone: "13800138000", Nickname: "Tester", Status: UserStatusActive},
	}
	service, err := NewService(repository, NewTokenManager("test-secret-with-at-least-thirty-two-characters", "test", "web", 15*time.Minute), 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	service.now = func() time.Time { return now }
	return service, repository, rawToken, now
}

func TestRefreshReusesCurrentTokenConcurrently(t *testing.T) {
	service, repository, rawToken, _ := newAuthTestService(t)
	var results [2]*AuthResult
	var errs [2]error
	var wait sync.WaitGroup
	for i := range results {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			results[index], errs[index] = service.Refresh(context.Background(), rawToken)
		}(i)
	}
	wait.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("refresh %d failed: %v", i, err)
		}
		if results[i].Response.AccessToken == "" || results[i].RefreshToken != rawToken {
			t.Fatalf("refresh %d did not preserve the current refresh token", i)
		}
	}
	if len(repository.tokens) != 1 || repository.tokens[HashRefreshToken(rawToken)].UsedAt != nil || repository.revokes != 0 {
		t.Fatal("refresh changed the refresh token or revoked the session")
	}
}

func TestHistoricalUsedTokenCannotRefreshOrLogoutCurrentSession(t *testing.T) {
	service, repository, oldToken, now := newAuthTestService(t)
	usedAt := now.Add(-time.Minute)
	repository.tokens[HashRefreshToken(oldToken)].UsedAt = &usedAt
	currentToken, err := GenerateRefreshToken()
	if err != nil {
		t.Fatal(err)
	}
	repository.tokens[HashRefreshToken(currentToken)] = &RefreshToken{
		ID: uuid.New(), SessionID: repository.session.ID,
		TokenHash: HashRefreshToken(currentToken), ExpiresAt: repository.session.ExpiresAt,
	}

	_, err = service.Refresh(context.Background(), oldToken)
	var appErr *apperrors.Error
	if !errors.As(err, &appErr) || appErr.Code != "AUTH_REFRESH_REUSED" {
		t.Fatalf("used token should be rejected as reused, got %v", err)
	}
	if err := service.Logout(context.Background(), oldToken); err != nil {
		t.Fatal(err)
	}
	if repository.revokes != 0 {
		t.Fatal("historical used token revoked the current session")
	}
	if _, err := service.Refresh(context.Background(), currentToken); err != nil {
		t.Fatalf("current token stopped working: %v", err)
	}
	if err := service.Logout(context.Background(), currentToken); err != nil {
		t.Fatal(err)
	}
	if err := service.Logout(context.Background(), currentToken); err != nil {
		t.Fatal(err)
	}
	if repository.revokes != 1 {
		t.Fatalf("logout should revoke once, got %d", repository.revokes)
	}
}

func TestRefreshRejectsRevokedExpiredOrDisabledSession(t *testing.T) {
	tests := []struct {
		name   string
		change func(*authTestRepository, string, time.Time)
		code   string
	}{
		{
			name: "revoked token",
			change: func(repository *authTestRepository, rawToken string, now time.Time) {
				repository.tokens[HashRefreshToken(rawToken)].RevokedAt = &now
			},
			code: "AUTH_REFRESH_INVALID",
		},
		{
			name: "expired token",
			change: func(repository *authTestRepository, rawToken string, now time.Time) {
				repository.tokens[HashRefreshToken(rawToken)].ExpiresAt = now
			},
			code: "AUTH_REFRESH_EXPIRED",
		},
		{
			name: "revoked session",
			change: func(repository *authTestRepository, _ string, now time.Time) {
				repository.session.RevokedAt = &now
			},
			code: "AUTH_REFRESH_INVALID",
		},
		{
			name: "expired session",
			change: func(repository *authTestRepository, _ string, now time.Time) {
				repository.session.ExpiresAt = now
			},
			code: "AUTH_REFRESH_EXPIRED",
		},
		{
			name: "disabled user",
			change: func(repository *authTestRepository, _ string, _ time.Time) {
				repository.user.Status = UserStatusDisabled
			},
			code: "AUTH_ACCOUNT_DISABLED",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service, repository, rawToken, now := newAuthTestService(t)
			test.change(repository, rawToken, now)
			_, err := service.Refresh(context.Background(), rawToken)
			var appErr *apperrors.Error
			if !errors.As(err, &appErr) || appErr.Code != test.code {
				t.Fatalf("want %s, got %v", test.code, err)
			}
			if repository.revokes != 0 {
				t.Fatal("refresh should not change session state")
			}
		})
	}
}

func TestRefreshAndLogoutHTTP(t *testing.T) {
	service, repository, rawToken, _ := newAuthTestService(t)
	handler, err := NewHandler(service, config.Config{
		RefreshCookieName: "eterion_rt",
		AllowedOrigins:    []string{"http://localhost:5173"},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.RegisterRoutes(router.Group("/api"))
	cookie := &http.Cookie{Name: "eterion_rt", Value: rawToken}

	request := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	request.Header.Set("Origin", "http://localhost:5173")
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Set-Cookie") != "" {
		t.Fatalf("refresh should return 200 without Set-Cookie, got %d / %q", response.Code, response.Header().Get("Set-Cookie"))
	}

	request = httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || response.Header().Get("Set-Cookie") != "" {
		t.Fatalf("failed refresh should not change the cookie, got %d / %q", response.Code, response.Header().Get("Set-Cookie"))
	}

	request = httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	request.Header.Set("Origin", "http://untrusted.example")
	request.AddCookie(cookie)
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || repository.revokes != 0 {
		t.Fatalf("untrusted origin should not log out, got %d / %d revocations", response.Code, repository.revokes)
	}

	repository.findErr = errors.New("database unavailable")
	request = httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	request.Header.Set("Origin", "http://localhost:5173")
	request.AddCookie(cookie)
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError || response.Header().Get("Set-Cookie") != "" {
		t.Fatalf("database failure should remain retryable, got %d / %q", response.Code, response.Header().Get("Set-Cookie"))
	}
	repository.findErr = nil

	request = httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	request.Header.Set("Origin", "http://localhost:5173")
	request.AddCookie(cookie)
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || repository.revokes != 1 || response.Header().Get("Set-Cookie") == "" {
		t.Fatalf("cookie-only logout should revoke and clear cookie, got %d / %d / %q", response.Code, repository.revokes, response.Header().Get("Set-Cookie"))
	}

	request = httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || response.Header().Get("Set-Cookie") == "" {
		t.Fatalf("missing-cookie logout should be idempotent, got %d / %q", response.Code, response.Header().Get("Set-Cookie"))
	}
}
