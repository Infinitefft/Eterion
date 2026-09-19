package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	apperrors "github.com/Infinitefft/Eterion/services/api/internal/shared/errors"
	"github.com/google/uuid"
	"golang.org/x/text/unicode/norm"
)

type AuthResult struct {
	Response         AuthResponse
	RefreshToken     string
	RefreshExpiresAt time.Time
}

type Identity struct {
	UserID    uuid.UUID
	SessionID uuid.UUID
	User      UserResponse
}

type Service struct {
	repository Repository
	tokens     *TokenManager
	refreshTTL time.Duration
	dummyHash  string
	now        func() time.Time
}

func NewService(repository Repository, tokens *TokenManager, refreshTTL time.Duration) (*Service, error) {
	dummyHash, err := HashPassword("eterion-dummy-password")
	if err != nil {
		return nil, err
	}
	return &Service{
		repository: repository,
		tokens:     tokens,
		refreshTTL: refreshTTL,
		dummyHash:  dummyHash,
		now:        func() time.Time { return time.Now().UTC() },
	}, nil
}

func (s *Service) Register(ctx context.Context, request RegisterRequest) (*AuthResult, error) {
	now := s.now()
	phone := normalizePhone(request.Phone)
	nickname := displayNickname(request.Nickname)
	passwordHash, err := HashPassword(request.Password)
	if err != nil {
		return nil, err
	}

	user := &User{
		ID:                 uuid.New(),
		Phone:              phone,
		Nickname:           nickname,
		NicknameNormalized: normalizeNickname(nickname),
		PasswordHash:       &passwordHash,
		Status:             UserStatusActive,
		AuthProvider:       AuthProviderLocal,
		CreatedAt:          now,
		UpdatedAt:          now,
	}
	result, session, refreshRecord, err := s.newSession(user, now)
	if err != nil {
		return nil, err
	}
	if err := s.repository.CreateUserAndSession(ctx, user, session, refreshRecord); err != nil {
		if errors.Is(err, ErrPhoneExists) {
			return nil, apperrors.New(
				http.StatusConflict,
				"AUTH_PHONE_EXISTS",
				"该手机号已被注册",
				"LOGIN_OR_USE_ANOTHER_PHONE",
			)
		}
		if errors.Is(err, ErrNicknameExists) {
			return nil, apperrors.New(
				http.StatusConflict,
				"AUTH_NICKNAME_EXISTS",
				"该昵称已被使用",
				"CHOOSE_ANOTHER_NICKNAME",
			)
		}
		return nil, err
	}
	return result, nil
}

func (s *Service) Login(ctx context.Context, request LoginRequest) (*AuthResult, error) {
	user, err := s.repository.FindUserByPhone(ctx, normalizePhone(request.Phone))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			_ = CheckPassword(s.dummyHash, request.Password)
			return nil, invalidCredentialsError()
		}
		return nil, err
	}
	if user.PasswordHash == nil || !CheckPassword(*user.PasswordHash, request.Password) {
		return nil, invalidCredentialsError()
	}
	if user.Status != UserStatusActive {
		return nil, invalidCredentialsError()
	}

	now := s.now()
	result, session, refreshRecord, err := s.newSession(user, now)
	if err != nil {
		return nil, err
	}
	if err := s.repository.CreateSession(ctx, session, refreshRecord); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Service) Refresh(ctx context.Context, rawRefreshToken string) (*AuthResult, error) {
	if rawRefreshToken == "" {
		return nil, apperrors.New(
			http.StatusUnauthorized,
			"AUTH_REFRESH_MISSING",
			"缺少刷新凭证，请重新登录",
			"LOGIN_AGAIN",
		)
	}
	if err := ValidateRefreshToken(rawRefreshToken); err != nil {
		return nil, invalidRefreshError()
	}

	now := s.now()
	tokenHash := HashRefreshToken(rawRefreshToken)
	current, err := s.repository.FindRefreshToken(ctx, tokenHash)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, invalidRefreshError()
		}
		return nil, err
	}
	if current.UsedAt != nil {
		return nil, apperrors.New(
			http.StatusUnauthorized,
			"AUTH_REFRESH_REUSED",
			"刷新凭证已被重复使用，请重新登录",
			"LOGIN_AGAIN",
		)
	}
	if current.RevokedAt != nil {
		return nil, invalidRefreshError()
	}
	if !now.Before(current.ExpiresAt) {
		return nil, apperrors.New(
			http.StatusUnauthorized,
			"AUTH_REFRESH_EXPIRED",
			"登录状态已过期，请重新登录",
			"LOGIN_AGAIN",
		)
	}

	session, err := s.repository.FindSessionByID(ctx, current.SessionID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, invalidRefreshError()
		}
		return nil, err
	}
	if session.RevokedAt != nil {
		return nil, invalidRefreshError()
	}
	if !now.Before(session.ExpiresAt) {
		return nil, apperrors.New(
			http.StatusUnauthorized,
			"AUTH_REFRESH_EXPIRED",
			"登录状态已过期，请重新登录",
			"LOGIN_AGAIN",
		)
	}

	user, err := s.repository.FindUserByID(ctx, session.UserID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, invalidRefreshError()
		}
		return nil, err
	}
	if user.Status != UserStatusActive {
		return nil, accountDisabledError()
	}

	accessToken, accessExpiresAt, err := s.tokens.CreateAccessToken(user.ID, session.ID, now)
	if err != nil {
		return nil, err
	}
	return makeAuthResult(user, accessToken, accessExpiresAt, rawRefreshToken, session.ExpiresAt, now), nil
}

func (s *Service) AuthenticateAccess(ctx context.Context, rawAccessToken string) (*Identity, error) {
	now := s.now()
	claims, err := s.tokens.ParseAccessToken(rawAccessToken, now)
	if err != nil {
		if errors.Is(err, ErrAccessTokenExpired) {
			return nil, accessExpiredError()
		}
		return nil, invalidAccessError()
	}

	userID, err := uuid.Parse(claims.Subject)
	if err != nil {
		return nil, invalidAccessError()
	}
	sessionID, err := uuid.Parse(claims.SessionID)
	if err != nil {
		return nil, invalidAccessError()
	}

	session, err := s.repository.FindSessionByID(ctx, sessionID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, invalidSessionError()
		}
		return nil, err
	}
	if session.UserID != userID || session.RevokedAt != nil || !now.Before(session.ExpiresAt) {
		return nil, invalidSessionError()
	}

	user, err := s.repository.FindUserByID(ctx, userID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, invalidSessionError()
		}
		return nil, err
	}
	if user.Status != UserStatusActive {
		return nil, accountDisabledError()
	}

	return &Identity{
		UserID:    user.ID,
		SessionID: session.ID,
		User: UserResponse{
			ID:       user.ID.String(),
			Phone:    user.Phone,
			Nickname: user.Nickname,
		},
	}, nil
}

func (s *Service) Logout(ctx context.Context, rawRefreshToken string) error {
	if rawRefreshToken == "" || ValidateRefreshToken(rawRefreshToken) != nil {
		return nil
	}

	current, err := s.repository.FindRefreshToken(ctx, HashRefreshToken(rawRefreshToken))
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if current.UsedAt != nil || current.RevokedAt != nil || !s.now().Before(current.ExpiresAt) {
		return nil
	}
	return s.repository.RevokeSessionAndTokens(ctx, current.SessionID, s.now())
}

func (s *Service) newSession(user *User, now time.Time) (*AuthResult, *AuthSession, *RefreshToken, error) {
	session := &AuthSession{
		ID:        uuid.New(),
		UserID:    user.ID,
		ExpiresAt: now.Add(s.refreshTTL),
		CreatedAt: now,
		UpdatedAt: now,
	}
	rawRefreshToken, err := GenerateRefreshToken()
	if err != nil {
		return nil, nil, nil, err
	}
	refreshRecord := &RefreshToken{
		ID:        uuid.New(),
		SessionID: session.ID,
		TokenHash: HashRefreshToken(rawRefreshToken),
		ExpiresAt: session.ExpiresAt,
		CreatedAt: now,
	}
	accessToken, accessExpiresAt, err := s.tokens.CreateAccessToken(user.ID, session.ID, now)
	if err != nil {
		return nil, nil, nil, err
	}
	return makeAuthResult(
		user,
		accessToken,
		accessExpiresAt,
		rawRefreshToken,
		session.ExpiresAt,
		now,
	), session, refreshRecord, nil
}

func makeAuthResult(
	user *User,
	accessToken string,
	accessExpiresAt time.Time,
	refreshToken string,
	refreshExpiresAt time.Time,
	now time.Time,
) *AuthResult {
	return &AuthResult{
		Response: AuthResponse{
			AccessToken: accessToken,
			TokenType:   "Bearer",
			ExpiresIn:   int64(accessExpiresAt.Sub(now).Seconds()),
			User: UserResponse{
				ID:       user.ID.String(),
				Phone:    user.Phone,
				Nickname: user.Nickname,
			},
		},
		RefreshToken:     refreshToken,
		RefreshExpiresAt: refreshExpiresAt,
	}
}

func normalizePhone(phone string) string {
	return strings.TrimSpace(phone)
}

func displayNickname(nickname string) string {
	return strings.TrimSpace(norm.NFKC.String(nickname))
}

func normalizeNickname(nickname string) string {
	return strings.ToLower(displayNickname(nickname))
}

func invalidCredentialsError() *apperrors.Error {
	return apperrors.New(
		http.StatusUnauthorized,
		"AUTH_INVALID_CREDENTIALS",
		"账号或密码错误",
		"CHECK_CREDENTIALS",
	)
}

func invalidRefreshError() *apperrors.Error {
	return apperrors.New(
		http.StatusUnauthorized,
		"AUTH_REFRESH_INVALID",
		"刷新凭证无效，请重新登录",
		"LOGIN_AGAIN",
	)
}

func accessExpiredError() *apperrors.Error {
	return apperrors.New(
		http.StatusUnauthorized,
		"AUTH_ACCESS_EXPIRED",
		"访问凭证已过期",
		"REFRESH_ACCESS_TOKEN",
	)
}

func invalidAccessError() *apperrors.Error {
	return apperrors.New(
		http.StatusUnauthorized,
		"AUTH_ACCESS_INVALID",
		"访问凭证无效",
		"LOGIN_AGAIN",
	)
}

func invalidSessionError() *apperrors.Error {
	return apperrors.New(
		http.StatusUnauthorized,
		"AUTH_SESSION_INVALID",
		"登录会话已失效，请重新登录",
		"LOGIN_AGAIN",
	)
}

func accountDisabledError() *apperrors.Error {
	return apperrors.New(
		http.StatusForbidden,
		"AUTH_ACCOUNT_DISABLED",
		"账号当前不可用，请联系管理员",
		"CONTACT_SUPPORT",
	)
}
