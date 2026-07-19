package auth

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	apperrors "github.com/Infinitefft/Eterion/services/api/internal/shared/errors"
	"github.com/google/uuid"
)

type fakeRepository struct {
	transactionMu   sync.Mutex
	usersByID       map[uuid.UUID]*User
	usersByPhone    map[string]*User
	usersByNickname map[string]*User
	sessions        map[uuid.UUID]*AuthSession
	tokensByHash    map[string]*RefreshToken
}

func newFakeRepository() *fakeRepository {
	return &fakeRepository{
		usersByID:       make(map[uuid.UUID]*User),
		usersByPhone:    make(map[string]*User),
		usersByNickname: make(map[string]*User),
		sessions:        make(map[uuid.UUID]*AuthSession),
		tokensByHash:    make(map[string]*RefreshToken),
	}
}

func (f *fakeRepository) WithTransaction(_ context.Context, fn func(Repository) error) error {
	f.transactionMu.Lock()
	defer f.transactionMu.Unlock()
	return fn(f)
}

func (f *fakeRepository) CreateUserAndSession(
	_ context.Context,
	user *User,
	session *AuthSession,
	token *RefreshToken,
) error {
	if _, exists := f.usersByPhone[user.Phone]; exists {
		return ErrPhoneExists
	}
	if _, exists := f.usersByNickname[user.NicknameNormalized]; exists {
		return ErrNicknameExists
	}
	f.usersByID[user.ID] = user
	f.usersByPhone[user.Phone] = user
	f.usersByNickname[user.NicknameNormalized] = user
	f.sessions[session.ID] = session
	f.tokensByHash[token.TokenHash] = token
	return nil
}

func (f *fakeRepository) CreateSession(_ context.Context, session *AuthSession, token *RefreshToken) error {
	f.sessions[session.ID] = session
	f.tokensByHash[token.TokenHash] = token
	return nil
}

func (f *fakeRepository) FindUserByPhone(_ context.Context, phone string) (*User, error) {
	user, exists := f.usersByPhone[phone]
	if !exists {
		return nil, ErrNotFound
	}
	return user, nil
}

func (f *fakeRepository) FindUserByID(_ context.Context, id uuid.UUID) (*User, error) {
	user, exists := f.usersByID[id]
	if !exists {
		return nil, ErrNotFound
	}
	return user, nil
}

func (f *fakeRepository) FindRefreshTokenForUpdate(_ context.Context, tokenHash string) (*RefreshToken, error) {
	token, exists := f.tokensByHash[tokenHash]
	if !exists {
		return nil, ErrNotFound
	}
	return token, nil
}

func (f *fakeRepository) FindSessionForUpdate(_ context.Context, id uuid.UUID) (*AuthSession, error) {
	session, exists := f.sessions[id]
	if !exists {
		return nil, ErrNotFound
	}
	return session, nil
}

func (f *fakeRepository) CreateRefreshToken(_ context.Context, token *RefreshToken) error {
	f.tokensByHash[token.TokenHash] = token
	return nil
}

func (f *fakeRepository) MarkRefreshTokenUsed(
	_ context.Context,
	id, replacementID uuid.UUID,
	usedAt time.Time,
) error {
	for _, token := range f.tokensByHash {
		if token.ID == id {
			token.UsedAt = &usedAt
			token.ReplacedByID = &replacementID
			return nil
		}
	}
	return ErrNotFound
}

func (f *fakeRepository) RevokeSessionAndTokens(_ context.Context, sessionID uuid.UUID, revokedAt time.Time) error {
	session, exists := f.sessions[sessionID]
	if !exists {
		return ErrNotFound
	}
	session.RevokedAt = &revokedAt
	for _, token := range f.tokensByHash {
		if token.SessionID == sessionID {
			token.RevokedAt = &revokedAt
		}
	}
	return nil
}

func TestRegisterLoginAndStrictRefreshRotation(t *testing.T) {
	repository := newFakeRepository()
	tokenManager := NewTokenManager(
		"0123456789abcdef0123456789abcdef",
		"eterion-api",
		"eterion-web",
		15*time.Minute,
	)
	service, err := NewService(repository, tokenManager, 30*24*time.Hour)
	if err != nil {
		t.Fatalf("create service: %v", err)
	}
	now := time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }
	registration := RegisterRequest{
		Phone:    " 13800138000 ",
		Nickname: " 测试用户 ",
		Password: "correct horse battery staple",
	}

	registered, err := service.Register(context.Background(), registration)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if registered.Response.User.Phone != "13800138000" ||
		registered.Response.User.Nickname != "测试用户" ||
		registered.Response.ExpiresIn != 900 {
		t.Fatalf("unexpected registration response: %+v", registered.Response)
	}
	user := repository.usersByPhone["13800138000"]
	if user == nil || user.PasswordHash == nil || *user.PasswordHash == registration.Password {
		t.Fatal("registered user did not receive a password hash")
	}
	if _, exists := repository.tokensByHash[registered.RefreshToken]; exists {
		t.Fatal("raw refresh token was stored by the repository")
	}
	if _, exists := repository.tokensByHash[HashRefreshToken(registered.RefreshToken)]; !exists {
		t.Fatal("refresh token hash was not stored")
	}

	_, err = service.Register(context.Background(), RegisterRequest{
		Phone:    registration.Phone,
		Nickname: "另一个昵称",
		Password: registration.Password,
	})
	assertAppErrorCode(t, err, "AUTH_PHONE_EXISTS")
	_, err = service.Register(context.Background(), RegisterRequest{
		Phone:    "13900139000",
		Nickname: "测试用户",
		Password: registration.Password,
	})
	assertAppErrorCode(t, err, "AUTH_NICKNAME_EXISTS")
	_, err = service.Login(context.Background(), LoginRequest{Phone: "13800138000", Password: "wrong password"})
	assertAppErrorCode(t, err, "AUTH_INVALID_CREDENTIALS")

	loggedIn, err := service.Login(context.Background(), LoginRequest{
		Phone:    " 13800138000 ",
		Password: registration.Password,
	})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if loggedIn.RefreshToken == registered.RefreshToken {
		t.Fatal("each session must receive a unique refresh token")
	}

	rotated, err := service.Refresh(context.Background(), registered.RefreshToken)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if rotated.RefreshToken == registered.RefreshToken || rotated.Response.AccessToken == registered.Response.AccessToken {
		t.Fatal("refresh did not rotate both credentials")
	}
	oldRecord := repository.tokensByHash[HashRefreshToken(registered.RefreshToken)]
	if oldRecord.UsedAt == nil || oldRecord.ReplacedByID == nil {
		t.Fatal("old refresh token was not marked as consumed")
	}

	_, err = service.Refresh(context.Background(), registered.RefreshToken)
	assertAppErrorCode(t, err, "AUTH_REFRESH_REUSED")
	replacement := repository.tokensByHash[HashRefreshToken(rotated.RefreshToken)]
	if replacement.RevokedAt == nil {
		t.Fatal("refresh token reuse did not revoke the replacement token")
	}
	if repository.sessions[replacement.SessionID].RevokedAt == nil {
		t.Fatal("refresh token reuse did not revoke the session")
	}

	_, err = service.Refresh(context.Background(), rotated.RefreshToken)
	assertAppErrorCode(t, err, "AUTH_REFRESH_INVALID")
}

func TestRefreshRejectsMissingMalformedAndExpiredTokens(t *testing.T) {
	repository := newFakeRepository()
	service, err := NewService(
		repository,
		NewTokenManager("0123456789abcdef0123456789abcdef", "issuer", "audience", 15*time.Minute),
		30*24*time.Hour,
	)
	if err != nil {
		t.Fatalf("create service: %v", err)
	}
	service.now = func() time.Time { return time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC) }

	_, err = service.Refresh(context.Background(), "")
	assertAppErrorCode(t, err, "AUTH_REFRESH_MISSING")
	_, err = service.Refresh(context.Background(), "malformed")
	assertAppErrorCode(t, err, "AUTH_REFRESH_INVALID")

	registered, err := service.Register(context.Background(), RegisterRequest{
		Phone:    "13700137000",
		Nickname: "过期用户",
		Password: "correct horse battery staple",
	})
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	service.now = func() time.Time { return registered.RefreshExpiresAt.Add(time.Second) }
	_, err = service.Refresh(context.Background(), registered.RefreshToken)
	assertAppErrorCode(t, err, "AUTH_REFRESH_EXPIRED")
}

func TestConcurrentRefreshAllowsSingleRotation(t *testing.T) {
	repository := newFakeRepository()
	service, err := NewService(
		repository,
		NewTokenManager("0123456789abcdef0123456789abcdef", "issuer", "audience", 15*time.Minute),
		30*24*time.Hour,
	)
	if err != nil {
		t.Fatalf("create service: %v", err)
	}
	service.now = func() time.Time { return time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC) }
	registered, err := service.Register(context.Background(), RegisterRequest{
		Phone:    "13600136000",
		Nickname: "并发用户",
		Password: "correct horse battery staple",
	})
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	type refreshOutcome struct {
		result *AuthResult
		err    error
	}
	start := make(chan struct{})
	outcomes := make(chan refreshOutcome, 2)
	for range 2 {
		go func() {
			<-start
			result, refreshErr := service.Refresh(context.Background(), registered.RefreshToken)
			outcomes <- refreshOutcome{result: result, err: refreshErr}
		}()
	}
	close(start)

	successes := 0
	reuses := 0
	for range 2 {
		outcome := <-outcomes
		if outcome.err == nil && outcome.result != nil {
			successes++
			continue
		}
		var appErr *apperrors.Error
		if errors.As(outcome.err, &appErr) && appErr.Code == "AUTH_REFRESH_REUSED" {
			reuses++
			continue
		}
		t.Fatalf("unexpected refresh outcome: result=%v error=%v", outcome.result, outcome.err)
	}
	if successes != 1 || reuses != 1 {
		t.Fatalf("expected one success and one reuse rejection, got %d and %d", successes, reuses)
	}
}

func assertAppErrorCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s error", code)
	}
	var appErr *apperrors.Error
	if !errors.As(err, &appErr) {
		t.Fatalf("expected app error, got %T: %v", err, err)
	}
	if appErr.Code != code {
		t.Fatalf("expected %s, got %s", code, appErr.Code)
	}
}
