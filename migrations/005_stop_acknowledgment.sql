-- A workspace stop is a request until a connected worker reports that it saw it.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS stop_requested_at TIMESTAMPTZ;

-- stop_requested_at is set only on agents that had active work when the stop was
-- requested, so offline one-shot workers are not expected to acknowledge.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS stop_requested_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS stop_acknowledged_at TIMESTAMPTZ;
