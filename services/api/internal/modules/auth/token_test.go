package auth

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

func TestPasswordHashAndCheck(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	if hash == "correct horse battery staple" {
		t.Fatal("password was stored in plaintext")
	}
	if !CheckPassword(hash, "correct horse battery staple") {
		t.Fatal("expected password to match")
	}
	if CheckPassword(hash, "wrong password") {
		t.Fatal("unexpected password match")
	}
}

func TestRefreshTokenGenerationAndHashing(t *testing.T) {
	first, err := GenerateRefreshToken()
	if err != nil {
		t.Fatalf("generate first refresh token: %v", err)
	}
	second, err := GenerateRefreshToken()
	if err != nil {
		t.Fatalf("generate second refresh token: %v", err)
	}
	if first == second {
		t.Fatal("refresh tokens must be unique")
	}
	if err := ValidateRefreshToken(first); err != nil {
		t.Fatalf("generated token is invalid: %v", err)
	}
	if len(HashRefreshToken(first)) != 64 {
		t.Fatal("refresh token hash must be a SHA-256 hex string")
	}
	if err := ValidateRefreshToken("not-a-token"); err == nil {
		t.Fatal("expected malformed token to be rejected")
	}
}

func TestAccessTokenClaims(t *testing.T) {
	secret := "0123456789abcdef0123456789abcdef"
	manager := NewTokenManager(secret, "eterion-api", "eterion-web", 15*time.Minute)
	now := time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC)
	userID := uuid.New()
	sessionID := uuid.New()

	raw, expiresAt, err := manager.CreateAccessToken(userID, sessionID, now)
	if err != nil {
		t.Fatalf("create access token: %v", err)
	}
	claims := &AccessClaims{}
	parsed, err := jwt.ParseWithClaims(raw, claims, func(token *jwt.Token) (any, error) {
		return []byte(secret), nil
	}, jwt.WithAudience("eterion-web"), jwt.WithIssuer("eterion-api"), jwt.WithTimeFunc(func() time.Time {
		return now.Add(time.Minute)
	}))
	if err != nil || !parsed.Valid {
		t.Fatalf("parse access token: %v", err)
	}
	if claims.Subject != userID.String() || claims.SessionID != sessionID.String() || claims.Type != "access" {
		t.Fatalf("unexpected access claims: %+v", claims)
	}
	if !expiresAt.Equal(now.Add(15 * time.Minute)) {
		t.Fatalf("unexpected expiry: %v", expiresAt)
	}
}
