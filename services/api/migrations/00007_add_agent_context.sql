-- +goose Up
ALTER TABLE messages
    ADD COLUMN agent_context JSONB,
    ADD CONSTRAINT messages_agent_context_array_check
        CHECK (agent_context IS NULL OR jsonb_typeof(agent_context) = 'array');

-- +goose Down
ALTER TABLE messages
    DROP CONSTRAINT messages_agent_context_array_check,
    DROP COLUMN agent_context;
