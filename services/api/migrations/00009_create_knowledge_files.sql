-- +goose Up
CREATE TABLE knowledge_files (
    id UUID PRIMARY KEY,
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE RESTRICT,
    original_name VARCHAR(255) NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    mime_type VARCHAR(128) NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX knowledge_files_base_created_idx
    ON knowledge_files (knowledge_base_id, created_at DESC, id);

-- +goose Down
DROP TABLE knowledge_files;
