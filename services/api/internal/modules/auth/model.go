package auth

import (
	"time"

	"github.com/google/uuid"
)

const (
	UserStatusActive   = "active"
	UserStatusDisabled = "disabled"
	AuthProviderLocal  = "local"
)

type User struct {
	ID                 uuid.UUID `gorm:"type:uuid;primaryKey"`
	Phone              string    `gorm:"uniqueIndex"`
	Nickname           string
	NicknameNormalized string `gorm:"uniqueIndex"`
	PasswordHash       *string
	Status             string
	AuthProvider       string
	ExternalSubject    *string
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

func (User) TableName() string { return "users" }

type AuthSession struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey"`
	UserID    uuid.UUID `gorm:"type:uuid;index"`
	ExpiresAt time.Time
	RevokedAt *time.Time
	CreatedAt time.Time
	UpdatedAt time.Time
}

func (AuthSession) TableName() string { return "auth_sessions" }

type RefreshToken struct {
	ID           uuid.UUID `gorm:"type:uuid;primaryKey"`
	SessionID    uuid.UUID `gorm:"type:uuid;index"`
	TokenHash    string    `gorm:"column:token_hash;uniqueIndex"`
	ExpiresAt    time.Time
	UsedAt       *time.Time
	RevokedAt    *time.Time
	ReplacedByID *uuid.UUID `gorm:"type:uuid"`
	CreatedAt    time.Time
}

func (RefreshToken) TableName() string { return "refresh_tokens" }
