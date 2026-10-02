import { query } from './db';

export async function createApprovalRequest(taskId: string, agentId: string, type: string, amountUsd: number | null, context: object, approverChain: string[] = []) {
  await query(
    `UPDATE tasks SET status = 'paused' WHERE id = $1 AND status IN ('claimed', 'in_progress')`,
    [taskId]
  );
  const rows = await query(
    `INSERT INTO approval_requests (task_id, agent_id, type, amount_usd, context, status, approver_chain)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6)
     RETURNING *`,
    [taskId, agentId, type, amountUsd, JSON.stringify(context), JSON.stringify(approverChain)]
  );
  return rows[0];
}

export async function listPendingApprovals(orgId: string) {
  return query(
    `SELECT ar.*, t.title as task_title, a.name as agent_name, a.type as agent_type
     FROM approval_requests ar
     JOIN tasks t ON ar.task_id = t.id
     JOIN agents a ON ar.agent_id = a.id
     WHERE t.org_id = $1 AND ar.status = 'pending'
     ORDER BY ar.requested_at DESC`,
    [orgId]
  );
}

export async function getApprovalRequest(id: string) {
  const rows = await query('SELECT * FROM approval_requests WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function decideApproval(id: string, decision: 'approved' | 'rejected', decidedBy: string, reason?: string) {
  const rows = await query(
    `UPDATE approval_requests SET status = $2, decided_at = now(), decided_by = $3, decision_reason = $4
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id, decision, decidedBy, reason]
  );
  if (rows.length > 0 && decision === 'approved') {
    await query(
      `UPDATE tasks SET status = 'in_progress' WHERE id = $1 AND status IN ('paused', 'claimed')`,
      [rows[0].task_id]
    );
  }
  return rows[0] || null;
}
