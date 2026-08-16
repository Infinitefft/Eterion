-- Persist the stable model ID selected for every Agent run.
-- +goose Up
ALTER TABLE runs
    ADD COLUMN model_id VARCHAR(64) NOT NULL DEFAULT 'default';

ALTER TABLE runs
    ALTER COLUMN model_id DROP DEFAULT;

ALTER TABLE runs
    ADD CONSTRAINT runs_model_id_check
        CHECK (length(btrim(model_id)) > 0);

CREATE INDEX runs_model_id_created_idx
    ON runs (model_id, created_at DESC);

-- +goose Down
DROP INDEX IF EXISTS runs_model_id_created_idx;

ALTER TABLE runs
    DROP CONSTRAINT IF EXISTS runs_model_id_check;

ALTER TABLE runs
    DROP COLUMN IF EXISTS model_id;
