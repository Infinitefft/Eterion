-- 负责创建 Chat、消息和 Agent Run 所需的数据库表、索引与状态约束。
-- +goose Up
CREATE TABLE chats (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(120) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX chats_user_updated_idx
    ON chats (user_id, updated_at DESC);

CREATE TABLE messages (
    id UUID PRIMARY KEY,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    run_id UUID,
    role VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    CONSTRAINT messages_role_check
        CHECK (role IN ('user', 'assistant', 'system')),
    CONSTRAINT messages_status_check
        CHECK (status IN ('pending', 'streaming', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX messages_chat_created_idx
    ON messages (chat_id, created_at, id);

CREATE INDEX messages_run_idx
    ON messages (run_id)
    WHERE run_id IS NOT NULL;

CREATE TABLE runs (
    id UUID PRIMARY KEY,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    input_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    output_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    status VARCHAR(16) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    last_seq BIGINT NOT NULL DEFAULT 0,
    error_code VARCHAR(64),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    CONSTRAINT runs_status_check
        CHECK (status IN ('created', 'running', 'streaming', 'completed', 'failed', 'cancelled')),
    CONSTRAINT runs_last_seq_check CHECK (last_seq >= 0),
    CONSTRAINT runs_idempotency_unique UNIQUE (user_id, idempotency_key),
    CONSTRAINT runs_distinct_messages_check
        CHECK (input_message_id <> output_message_id)
);

CREATE INDEX runs_chat_created_idx
    ON runs (chat_id, created_at, id);

CREATE UNIQUE INDEX runs_one_active_per_chat
    ON runs (chat_id)
    WHERE status IN ('created', 'running', 'streaming');

-- +goose Down
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS chats;
