-- Bind each agent to the workspace key that registered it. Legacy rows keep
-- NULL and remain usable by any key in the workspace; new agents are scoped.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_by_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS agents_created_by_key_idx ON agents(created_by_key_id);
