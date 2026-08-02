-- Align persisted message/run metadata with the frontend IM protocol.
-- +goose Up
ALTER TABLE messages
    ADD COLUMN content_format VARCHAR(16) NOT NULL DEFAULT 'plain_text';

UPDATE messages
SET content_format = 'markdown'
WHERE role = 'assistant';

ALTER TABLE messages
    ADD CONSTRAINT messages_content_format_check
        CHECK (content_format IN ('plain_text', 'markdown'));

ALTER TABLE runs
    ADD COLUMN error_retryable BOOLEAN NOT NULL DEFAULT FALSE;

-- +goose Down
ALTER TABLE runs
    DROP COLUMN IF EXISTS error_retryable;

ALTER TABLE messages
    DROP CONSTRAINT IF EXISTS messages_content_format_check;

ALTER TABLE messages
    DROP COLUMN IF EXISTS content_format;
