/**
 * Slack Integration for AgentOnCall
 * 
 * Two modes:
 * 1. Incoming webhook mode (simplest): post approval cards to a Slack channel via webhook URL.
 *    AgentOnCall posts a message with Approve/Reject buttons (Block Kit).
 *    Human clicks button → Slack sends interactive payload to our webhook endpoint → we decide approval.
 * 
 * 2. Bolt mode (full): Socket Mode or HTTP with interactive components, slash commands.
 *    More setup, better UX. Kept for later.
 * 
 * For MVP, we use webhook mode: post approval card + receive button clicks via REST endpoint.
 */

import { Pool } from 'pg';
import { IncomingWebhook } from '@slack/webhook';
import 'dotenv/config';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://agentoncall:agentoncall@localhost:5432/agentoncall',
});

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const APPROVAL_BASE_URL = process.env.APPROVAL_BASE_URL || 'http://localhost:3000';

// Post approval card to Slack
export async function postApprovalToSlack(approvalId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    // Get approval + task + agent details
    const approvalRows = await pool.query(
      `SELECT ar.*, t.title as task_title, t.org_id, a.name as agent_name, a.type as agent_type
       FROM approval_requests ar
       JOIN tasks t ON ar.task_id = t.id
       JOIN agents a ON ar.agent_id = a.id
       WHERE ar.id = $1`,
      [approvalId]
    );
    if (approvalRows.rows.length === 0) {
      return { ok: false, error: 'Approval not found' };
    }
    const approval = approvalRows.rows[0];
    if (approval.status !== 'pending') {
      return { ok: false, error: 'Approval already decided' };
    }
    
    const webhook = new IncomingWebhook(SLACK_WEBHOOK_URL);
    const blocks = buildApprovalBlocks(approval, { title: approval.task_title }, { name: approval.agent_name, type: approval.agent_type });
    
    await webhook.send({
      text: `Approval needed: ${approval.type}${approval.amount_usd ? ` ($${approval.amount_usd})` : ''} — ${approval.task_title}`,
      blocks,
    });
    
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// Handle Slack interactive payload (button click)
// Slack sends this as application/x-www-form-urlencoded with payload=JSON
export interface SlackActionPayload {
  type: string;
  actions: Array<{
    action_id: string;
    value: string; // JSON string with approval_id and decision
  }>;
  user: { id: string; username: string; name: string };
  channel: { id: string };
  message_ts: string;
}

export async function handleSlackAction(payload: SlackActionPayload): Promise<{ ok: boolean; error?: string; decision?: string; approval_id?: string }> {
  try {
    const action = payload.actions[0];
    const actionMap: Record<string, string> = {
      approval_approve: 'approved',
      approval_reject: 'rejected',
    };
    const mappedDecision = actionMap[action.action_id];
    if (!mappedDecision) {
      return { ok: false, error: 'Unknown action' };
    }
    
    const value = JSON.parse(action.value);
    const { approval_id } = value;
    const decision = mappedDecision as 'approved' | 'rejected';
    
    // Decide approval
    const result = await pool.query(
      `UPDATE approval_requests
       SET status = $2, decided_at = now(), decided_by = $3, decision_reason = 'Slack button'
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [approval_id, decision, payload.user?.username || payload.user?.name || payload.user?.id || 'slack_user']
    );
    
    if (result.rows.length === 0) {
      return { ok: false, error: 'Already decided or not found' };
    }
    
    const approval = result.rows[0];
    
    // If approved, resume task
    if (decision === 'approved') {
      await pool.query(
        `UPDATE tasks SET status = 'in_progress' WHERE id = $1 AND status IN ('paused', 'claimed')`,
        [approval.task_id]
      );
    }
    
    return { ok: true, decision, approval_id };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

import { buildApprovalBlocks, buildDecisionBlocks } from './alert-blocks';
export { buildApprovalBlocks, buildDecisionBlocks };
