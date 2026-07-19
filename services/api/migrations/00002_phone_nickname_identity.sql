-- +goose Up
ALTER TABLE users
    ADD COLUMN phone VARCHAR(16),
    ADD COLUMN nickname VARCHAR(32),
    ADD COLUMN nickname_normalized VARCHAR(32);

-- Existing pre-release users can migrate only when their old account is already
-- a valid phone number. This preserves compatible data and fails safely otherwise.
UPDATE users
SET phone = account_normalized,
    nickname = account,
    nickname_normalized = LOWER(account);

ALTER TABLE users
    ALTER COLUMN phone SET NOT NULL,
    ALTER COLUMN nickname SET NOT NULL,
    ALTER COLUMN nickname_normalized SET NOT NULL,
    ADD CONSTRAINT users_phone_unique UNIQUE (phone),
    ADD CONSTRAINT users_nickname_normalized_unique UNIQUE (nickname_normalized),
    ADD CONSTRAINT users_phone_format_check CHECK (phone ~ '^1[3-9][0-9]{9}$'),
    ADD CONSTRAINT users_nickname_length_check
        CHECK (char_length(nickname) BETWEEN 2 AND 32);

ALTER TABLE users
    DROP CONSTRAINT users_account_normalized_format_check,
    DROP COLUMN account,
    DROP COLUMN account_normalized;

-- +goose Down
ALTER TABLE users
    ADD COLUMN account VARCHAR(32),
    ADD COLUMN account_normalized VARCHAR(32);

UPDATE users
SET account = phone,
    account_normalized = phone;

ALTER TABLE users
    ALTER COLUMN account SET NOT NULL,
    ALTER COLUMN account_normalized SET NOT NULL,
    ADD CONSTRAINT users_account_normalized_key UNIQUE (account_normalized),
    ADD CONSTRAINT users_account_normalized_format_check
        CHECK (account_normalized ~ '^[a-z0-9][a-z0-9_.-]{2,31}$');

ALTER TABLE users
    DROP CONSTRAINT users_phone_unique,
    DROP CONSTRAINT users_nickname_normalized_unique,
    DROP CONSTRAINT users_phone_format_check,
    DROP CONSTRAINT users_nickname_length_check,
    DROP COLUMN phone,
    DROP COLUMN nickname,
    DROP COLUMN nickname_normalized;
