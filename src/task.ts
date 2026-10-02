import { query } from './db';

export async function createTask(orgId: string, title: string, description: string | null, source: string, budget: number | null, permissions: object = {}, requiredApprovals: string[] = [], timeoutSeconds = 3600) {
  const rows = await query(
    `INSERT INTO tasks (org_id, title, description, source, status, budget_usd, permissions, required_approvals, timeout_seconds)
     VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7, $8)
     RETURNING *`,
    [orgId, title, description, source, budget, JSON.stringify(permissions), JSON.stringify(requiredApprovals), timeoutSeconds]
  );
  return rows[0];
}

export async function listTasks(orgId: string, status?: string) {
  if (status) {
    return query('SELECT * FROM tasks WHERE org_id = $1 AND status = $2 ORDER BY created_at DESC', [orgId, status]);
  }
  return query('SELECT * FROM tasks WHERE org_id = $1 ORDER BY created_at DESC', [orgId]);
}

export async function getTask(id: string) {
  const rows = await query('SELECT * FROM tasks WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function claimTask(taskId: string, agentId: string) {
  // Atomic claim: only succeed if task is still queued and no other agent claimed it
  const rows = await query(
    `UPDATE tasks SET agent_id = $2, status = 'claimed', claimed_at = now()
     WHERE id = $1 AND status = 'queued'
     RETURNING *`,
    [taskId, agentId]
  );
  return rows[0] || null;
}

export async function updateTaskStatus(id: string, status: string) {
  const rows = await query(
    `UPDATE tasks SET status = $2,
     started_at = CASE WHEN $2 = 'in_progress' THEN now() ELSE started_at END,
     completed_at = CASE WHEN $2 IN ('done','failed','halted') THEN now() ELSE completed_at END
     WHERE id = $1 RETURNING *`,
    [id, status]
  );
  return rows[0] || null;
}

export async function updateTaskSpend(id: string, amountUsd: number) {
  const rows = await query(
    `UPDATE tasks SET spent_usd = spent_usd + $2 WHERE id = $1 RETURNING *`,
    [id, amountUsd]
  );
  return rows[0] || null;
}
