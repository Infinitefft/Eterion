-- +goose Up
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE rag_chunks (
    id UUID PRIMARY KEY,
    file_id UUID NOT NULL REFERENCES knowledge_files(id) ON DELETE CASCADE,
    section_id UUID NOT NULL,
    content TEXT NOT NULL,
    heading_path TEXT[] NOT NULL DEFAULT '{}',
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    start_offset INTEGER,
    end_offset INTEGER,
    embedding VECTOR(1024) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT rag_chunks_section_index_unique UNIQUE (file_id, section_id, chunk_index),
    CONSTRAINT rag_chunks_offsets_check CHECK (
        (start_offset IS NULL AND end_offset IS NULL)
        OR (start_offset IS NOT NULL AND end_offset IS NOT NULL
            AND start_offset >= 0 AND end_offset > start_offset)
    )
);

COMMENT ON COLUMN rag_chunks.section_id IS 'Logical section ID; no separate section table in v1';
COMMENT ON COLUMN rag_chunks.chunk_index IS 'Zero-based index within a section';
COMMENT ON COLUMN rag_chunks.start_offset IS 'UTF-16 source offset, inclusive; NULL when unavailable';
COMMENT ON COLUMN rag_chunks.end_offset IS 'UTF-16 source offset, exclusive; NULL when unavailable';
COMMENT ON COLUMN rag_chunks.embedding IS 'text-embedding-v4, 1024 dimensions; heading path + content';

-- +goose Down
DROP TABLE rag_chunks;
-- Keep the shared vector extension when rolling back this table.
