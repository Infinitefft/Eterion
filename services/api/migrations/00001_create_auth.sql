-- +goose Up
CREATE TABLE users (
    id UUID PRIMARY KEY,
    account VARCHAR(32) NOT NULL,
    account_normalized VARCHAR(32) NOT NULL UNIQUE,
    password_hash VARCHAR(60),
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    auth_provider VARCHAR(32) NOT NULL DEFAULT 'local',
    external_subject VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT users_account_normalized_format_check
        CHECK (account_normalized ~ '^[a-z0-9][a-z0-9_.-]{2,31}$'),
    CONSTRAINT users_status_check
        CHECK (status IN ('active', 'disabled')),
    CONSTRAINT users_local_password_check
        CHECK (auth_provider <> 'local' OR password_hash IS NOT NULL)
);

CREATE UNIQUE INDEX users_external_identity_unique
    ON users (auth_provider, external_subject)
    WHERE external_subject IS NOT NULL;

CREATE TABLE auth_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT auth_sessions_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_user_active_idx
    ON auth_sessions (user_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    replaced_by_id UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT refresh_tokens_expiry_check CHECK (expires_at > created_at),
    CONSTRAINT refresh_tokens_hash_format_check CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX refresh_tokens_session_active_idx
    ON refresh_tokens (session_id, expires_at)
    WHERE revoked_at IS NULL;

-- +goose Down
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS auth_sessions;
DROP TABLE IF EXISTS users;
