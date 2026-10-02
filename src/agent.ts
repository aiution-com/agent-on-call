import { query } from './db';

export async function createAgent(orgId: string, name: string, type: string, ownerEmail: string, capabilities: object = {}) {
  const rows = await query(
    `INSERT INTO agents (org_id, name, type, owner_email, capabilities, status, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, 'idle', now())
     RETURNING *`,
    [orgId, name, type, ownerEmail, JSON.stringify(capabilities)]
  );
  return rows[0];
}

export async function listAgents(orgId: string) {
  return query('SELECT * FROM agents WHERE org_id = $1 ORDER BY created_at DESC', [orgId]);
}

export async function getAgent(id: string) {
  const rows = await query('SELECT * FROM agents WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function updateAgentStatus(id: string, status: string, healthScore?: number) {
  const rows = await query(
    `UPDATE agents SET status = $2, last_seen_at = now(),
     health_score = COALESCE($3, health_score)
     WHERE id = $1 RETURNING *`,
    [id, status, healthScore]
  );
  return rows[0] || null;
}
