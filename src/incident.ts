import { query } from './db';

export async function createIncident(orgId: string, agentId: string, taskId: string, title: string, description: string, severity: string, evidence: object) {
  const rows = await query(
    `INSERT INTO incidents (org_id, agent_id, task_id, title, description, severity, evidence, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
     RETURNING *`,
    [orgId, agentId, taskId, title, description, severity, JSON.stringify(evidence)]
  );
  return rows[0];
}

export async function listIncidents(orgId: string, status?: string) {
  if (status) {
    return query('SELECT * FROM incidents WHERE org_id = $1 AND status = $2 ORDER BY created_at DESC', [orgId, status]);
  }
  return query('SELECT * FROM incidents WHERE org_id = $1 ORDER BY created_at DESC', [orgId]);
}

export async function getIncident(id: string) {
  const rows = await query('SELECT * FROM incidents WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function resolveIncident(id: string) {
  const rows = await query(
    `UPDATE incidents SET status = 'resolved', resolved_at = now() WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}
