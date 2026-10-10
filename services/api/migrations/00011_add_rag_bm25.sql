-- +goose Up
CREATE EXTENSION IF NOT EXISTS pg_search;

-- Existing chunks remain vector-only; only new ingestion populates this field.
ALTER TABLE rag_chunks ADD COLUMN search_text TEXT;
COMMENT ON COLUMN rag_chunks.search_text IS 'Heading path + content for BM25; NULL for chunks ingested before hybrid search';

CREATE INDEX rag_chunks_bm25_idx ON rag_chunks
USING paradedb (id, (search_text::pdb.jieba('search_mode=true')));

-- +goose Down
DROP INDEX rag_chunks_bm25_idx;
ALTER TABLE rag_chunks DROP COLUMN search_text;
-- Keep the shared pg_search extension installed.
