package auth

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/config"
	"github.com/gin-gonic/gin"
)

func TestHandlerRegisterAndRefreshCookieContract(t *testing.T) {
	gin.SetMode(gin.TestMode)
	repository := newFakeRepository()
	service, err := NewService(
		repository,
		NewTokenManager("0123456789abcdef0123456789abcdef", "eterion-api", "eterion-web", 15*time.Minute),
		30*24*time.Hour,
	)
	if err != nil {
		t.Fatalf("create service: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg := config.Config{
		RefreshCookieName:   "eterion_rt",
		RefreshCookieSecure: false,
		AllowedOrigins:      []string{"http://localhost:5173"},
	}
	handler, err := NewHandler(service, cfg, logger)
	if err != nil {
		t.Fatalf("create handler: %v", err)
	}
	router := gin.New()
	handler.RegisterRoutes(router.Group("/api/v1"))

	registerBody := []byte(`{"phone":"13500135000","nickname":"网页用户","password":"correct horse battery staple"}`)
	registerRequest := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewReader(registerBody))
	registerRequest.Header.Set("Content-Type", "application/json")
	registerResponse := httptest.NewRecorder()
	router.ServeHTTP(registerResponse, registerRequest)
	if registerResponse.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", registerResponse.Code, registerResponse.Body.String())
	}
	if strings.Contains(registerResponse.Body.String(), "refresh_token") {
		t.Fatal("refresh token leaked into the JSON response")
	}
	cookies := registerResponse.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("expected one cookie, got %d", len(cookies))
	}
	refreshCookie := cookies[0]
	if refreshCookie.Name != "eterion_rt" || !refreshCookie.HttpOnly || refreshCookie.Path != "/api/v1/auth" {
		t.Fatalf("unexpected refresh cookie: %+v", refreshCookie)
	}
	if refreshCookie.SameSite != http.SameSiteLaxMode || refreshCookie.MaxAge <= 0 {
		t.Fatalf("missing refresh cookie protections: %+v", refreshCookie)
	}

	refreshRequest := httptest.NewRequest(http.MethodPost, "/api/v1/auth/refresh", nil)
	refreshRequest.Header.Set("Origin", "http://localhost:5173")
	refreshRequest.AddCookie(refreshCookie)
	refreshResponse := httptest.NewRecorder()
	router.ServeHTTP(refreshResponse, refreshRequest)
	if refreshResponse.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", refreshResponse.Code, refreshResponse.Body.String())
	}
	rotatedCookies := refreshResponse.Result().Cookies()
	if len(rotatedCookies) != 1 || rotatedCookies[0].Value == refreshCookie.Value {
		t.Fatal("refresh endpoint did not rotate the cookie")
	}

	forbiddenRequest := httptest.NewRequest(http.MethodPost, "/api/v1/auth/refresh", nil)
	forbiddenRequest.Header.Set("Origin", "https://untrusted.example")
	forbiddenRequest.AddCookie(rotatedCookies[0])
	forbiddenResponse := httptest.NewRecorder()
	router.ServeHTTP(forbiddenResponse, forbiddenRequest)
	if forbiddenResponse.Code != http.StatusForbidden {
		t.Fatalf("expected forbidden origin to return 403, got %d", forbiddenResponse.Code)
	}
}

func TestHandlerValidationResponse(t *testing.T) {
	gin.SetMode(gin.TestMode)
	service, err := NewService(
		newFakeRepository(),
		NewTokenManager("0123456789abcdef0123456789abcdef", "issuer", "audience", 15*time.Minute),
		30*24*time.Hour,
	)
	if err != nil {
		t.Fatalf("create service: %v", err)
	}
	handler, err := NewHandler(service, config.Config{RefreshCookieName: "eterion_rt"}, slog.Default())
	if err != nil {
		t.Fatalf("create handler: %v", err)
	}
	router := gin.New()
	handler.RegisterRoutes(router.Group("/api/v1"))

	body, _ := json.Marshal(RegisterRequest{Phone: "123", Nickname: "x", Password: "short"})
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	responseRecorder := httptest.NewRecorder()
	router.ServeHTTP(responseRecorder, request)
	if responseRecorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", responseRecorder.Code, responseRecorder.Body.String())
	}
	if !strings.Contains(responseRecorder.Body.String(), "VALIDATION_ERROR") {
		t.Fatalf("missing stable validation error: %s", responseRecorder.Body.String())
	}
}
