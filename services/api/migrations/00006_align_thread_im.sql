-- Align persisted chat state with the Thread-scoped frontend IM contract.
-- +goose Up
ALTER TABLE chats
    ADD COLUMN last_seq BIGINT NOT NULL DEFAULT 0,
    ADD CONSTRAINT chats_last_seq_check CHECK (last_seq >= 0);

DROP INDEX IF EXISTS runs_one_active_per_chat;

ALTER TABLE runs
    DROP CONSTRAINT IF EXISTS runs_status_check;

UPDATE runs
SET status = 'pending'
WHERE status = 'created';

UPDATE runs
SET status = 'running'
WHERE status = 'streaming';

ALTER TABLE runs
    ADD CONSTRAINT runs_status_check
        CHECK (status IN ('pending', 'running', 'waiting_user', 'completed', 'failed', 'cancelled'));

CREATE UNIQUE INDEX runs_one_active_per_chat
    ON runs (chat_id)
    WHERE status IN ('pending', 'running', 'waiting_user');

CREATE TABLE agent_blocks (
    run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    id VARCHAR(128) NOT NULL,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    kind VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL,
    sequence BIGINT NOT NULL,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (run_id, id),
    CONSTRAINT agent_blocks_sequence_check CHECK (sequence > 0)
);

CREATE INDEX agent_blocks_chat_sequence_idx
    ON agent_blocks (chat_id, sequence, id);

-- +goose Down
DROP TABLE IF EXISTS agent_blocks;

DROP INDEX IF EXISTS runs_one_active_per_chat;

ALTER TABLE runs
    DROP CONSTRAINT IF EXISTS runs_status_check;

UPDATE runs
SET status = 'created'
WHERE status = 'pending';

UPDATE runs
SET status = 'running'
WHERE status = 'waiting_user';

ALTER TABLE runs
    ADD CONSTRAINT runs_status_check
        CHECK (status IN ('created', 'running', 'streaming', 'completed', 'failed', 'cancelled'));

CREATE UNIQUE INDEX runs_one_active_per_chat
    ON runs (chat_id)
    WHERE status IN ('created', 'running', 'streaming');

ALTER TABLE chats
    DROP CONSTRAINT IF EXISTS chats_last_seq_check,
    DROP COLUMN IF EXISTS last_seq;
