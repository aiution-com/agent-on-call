CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  halted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX users_org_idx ON users(org_id);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX api_keys_org_idx ON api_keys(org_id);
CREATE INDEX api_keys_user_idx ON api_keys(user_id);
CREATE TABLE auth_limits (
  key TEXT PRIMARY KEY,
  attempts INT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX auth_limits_expiry_idx ON auth_limits(expires_at);
CREATE INDEX IF NOT EXISTS agents_org_idx ON agents(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_org_idx ON tasks(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_agent_idx ON tasks(agent_id);
CREATE INDEX IF NOT EXISTS approvals_task_idx ON approval_requests(task_id);
CREATE INDEX IF NOT EXISTS approvals_agent_idx ON approval_requests(agent_id);
CREATE INDEX IF NOT EXISTS incidents_org_idx ON incidents(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS policies_org_idx ON policies(org_id);
