-- +goose Up
CREATE TABLE knowledge_bases (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(120) NOT NULL CHECK (char_length(btrim(title)) > 0),
    description VARCHAR(2000) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX knowledge_bases_user_created_idx
    ON knowledge_bases (user_id, created_at DESC, id);

-- +goose Down
DROP TABLE knowledge_bases;
