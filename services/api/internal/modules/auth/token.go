package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const refreshTokenBytes = 32

type AccessClaims struct {
	SessionID string `json:"sid"`
	Type      string `json:"typ"`
	jwt.RegisteredClaims
}

type TokenManager struct {
	secret   []byte
	issuer   string
	audience string
	ttl      time.Duration
}

func NewTokenManager(secret, issuer, audience string, ttl time.Duration) *TokenManager {
	return &TokenManager{secret: []byte(secret), issuer: issuer, audience: audience, ttl: ttl}
}

func (m *TokenManager) CreateAccessToken(userID, sessionID uuid.UUID, now time.Time) (string, time.Time, error) {
	expiresAt := now.Add(m.ttl)
	claims := AccessClaims{
		SessionID: sessionID.String(),
		Type:      "access",
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    m.issuer,
			Subject:   userID.String(),
			Audience:  jwt.ClaimStrings{m.audience},
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			NotBefore: jwt.NewNumericDate(now),
			IssuedAt:  jwt.NewNumericDate(now),
			ID:        uuid.NewString(),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(m.secret)
	if err != nil {
		return "", time.Time{}, err
	}
	return signed, expiresAt, nil
}

func GenerateRefreshToken() (string, error) {
	buffer := make([]byte, refreshTokenBytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func ValidateRefreshToken(raw string) error {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(decoded) != refreshTokenBytes {
		return errors.New("invalid refresh token")
	}
	return nil
}

func HashRefreshToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}
