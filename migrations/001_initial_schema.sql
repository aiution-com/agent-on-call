CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE TABLE IF NOT EXISTS agents ( id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, owner_email TEXT NOT NULL, capabilities JSONB DEFAULT '{}', status TEXT DEFAULT 'idle', health_score NUMERIC DEFAULT 100, last_seen_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now() );
CREATE TABLE IF NOT EXISTS tasks ( id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, agent_id UUID REFERENCES agents(id), title TEXT NOT NULL, description TEXT, source TEXT NOT NULL, status TEXT DEFAULT 'queued', budget_usd NUMERIC, spent_usd NUMERIC DEFAULT 0, permissions JSONB DEFAULT '{}', timeout_seconds INT DEFAULT 3600, required_approvals JSONB DEFAULT '[]', claimed_at TIMESTAMPTZ, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now() );
CREATE TABLE IF NOT EXISTS approval_requests ( id UUID PRIMARY KEY DEFAULT gen_random_uuid(), task_id UUID REFERENCES tasks(id), agent_id UUID REFERENCES agents(id), type TEXT NOT NULL, amount_usd NUMERIC, context JSONB, status TEXT DEFAULT 'pending', approver_chain JSONB DEFAULT '[]', requested_at TIMESTAMPTZ DEFAULT now(), decided_at TIMESTAMPTZ, decided_by TEXT, decision_reason TEXT );
CREATE TABLE IF NOT EXISTS incidents ( id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, agent_id UUID REFERENCES agents(id), task_id UUID REFERENCES tasks(id), severity TEXT DEFAULT 'warning', title TEXT NOT NULL, description TEXT, evidence JSONB, status TEXT DEFAULT 'open', created_at TIMESTAMPTZ DEFAULT now(), resolved_at TIMESTAMPTZ );
CREATE TABLE IF NOT EXISTS policies ( id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, agent_type TEXT, rule_type TEXT NOT NULL, rule_value JSONB NOT NULL, active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now() );
CREATE TABLE IF NOT EXISTS task_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error', 'pause', 'stdout', 'success')),
  message TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_logs_task_timestamp_idx ON task_logs (task_id, timestamp, id);
