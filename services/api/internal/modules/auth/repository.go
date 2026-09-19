package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"gorm.io/gorm"
)

var (
	ErrNotFound       = errors.New("not found")
	ErrPhoneExists    = errors.New("phone already exists")
	ErrNicknameExists = errors.New("nickname already exists")
)

type Repository interface {
	CreateUserAndSession(ctx context.Context, user *User, session *AuthSession, token *RefreshToken) error
	CreateSession(ctx context.Context, session *AuthSession, token *RefreshToken) error
	FindUserByPhone(ctx context.Context, phone string) (*User, error)
	FindUserByID(ctx context.Context, id uuid.UUID) (*User, error)
	FindSessionByID(ctx context.Context, id uuid.UUID) (*AuthSession, error)
	FindRefreshToken(ctx context.Context, tokenHash string) (*RefreshToken, error)
	RevokeSessionAndTokens(ctx context.Context, sessionID uuid.UUID, revokedAt time.Time) error
}

type GormRepository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) *GormRepository {
	return &GormRepository{db: db}
}

func (r *GormRepository) CreateUserAndSession(
	ctx context.Context,
	user *User,
	session *AuthSession,
	token *RefreshToken,
) error {
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(user).Error; err != nil {
			if uniqueField, ok := uniqueViolationField(err); ok {
				switch uniqueField {
				case "phone":
					return ErrPhoneExists
				case "nickname":
					return ErrNicknameExists
				}
			}
			return fmt.Errorf("create user: %w", err)
		}
		if err := tx.Create(session).Error; err != nil {
			return fmt.Errorf("create auth session: %w", err)
		}
		if err := tx.Create(token).Error; err != nil {
			return fmt.Errorf("create refresh token: %w", err)
		}
		return nil
	})
	return err
}

func (r *GormRepository) CreateSession(ctx context.Context, session *AuthSession, token *RefreshToken) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(session).Error; err != nil {
			return fmt.Errorf("create auth session: %w", err)
		}
		if err := tx.Create(token).Error; err != nil {
			return fmt.Errorf("create refresh token: %w", err)
		}
		return nil
	})
}

func (r *GormRepository) FindUserByPhone(ctx context.Context, phone string) (*User, error) {
	var user User
	if err := r.db.WithContext(ctx).Where("phone = ?", phone).First(&user).Error; err != nil {
		return nil, mapNotFound(err)
	}
	return &user, nil
}

func (r *GormRepository) FindUserByID(ctx context.Context, id uuid.UUID) (*User, error) {
	var user User
	if err := r.db.WithContext(ctx).Where("id = ?", id).First(&user).Error; err != nil {
		return nil, mapNotFound(err)
	}
	return &user, nil
}

func (r *GormRepository) FindSessionByID(ctx context.Context, id uuid.UUID) (*AuthSession, error) {
	var session AuthSession
	if err := r.db.WithContext(ctx).Where("id = ?", id).First(&session).Error; err != nil {
		return nil, mapNotFound(err)
	}
	return &session, nil
}

func (r *GormRepository) FindRefreshToken(ctx context.Context, tokenHash string) (*RefreshToken, error) {
	var token RefreshToken
	err := r.db.WithContext(ctx).
		Where("token_hash = ?", tokenHash).
		First(&token).Error
	if err != nil {
		return nil, mapNotFound(err)
	}
	return &token, nil
}
func (r *GormRepository) RevokeSessionAndTokens(
	ctx context.Context,
	sessionID uuid.UUID,
	revokedAt time.Time,
) error {
	if err := r.db.WithContext(ctx).Model(&AuthSession{}).
		Where("id = ? AND revoked_at IS NULL", sessionID).
		Updates(map[string]any{"revoked_at": revokedAt, "updated_at": revokedAt}).Error; err != nil {
		return fmt.Errorf("revoke auth session: %w", err)
	}
	if err := r.db.WithContext(ctx).Model(&RefreshToken{}).
		Where("session_id = ? AND revoked_at IS NULL", sessionID).
		Update("revoked_at", revokedAt).Error; err != nil {
		return fmt.Errorf("revoke refresh tokens: %w", err)
	}
	return nil
}

func mapNotFound(err error) error {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrNotFound
	}
	return err
}

func uniqueViolationField(err error) (string, bool) {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		return "", false
	}
	switch pgErr.ConstraintName {
	case "users_phone_unique", "users_phone_key":
		return "phone", true
	case "users_nickname_normalized_unique", "users_nickname_normalized_key":
		return "nickname", true
	default:
		return "", true
	}
}
