import { query } from './db';
import { IncomingWebhook } from '@slack/webhook';
import 'dotenv/config';

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';

export async function getEmergencyStatus(orgId: string) {
  const openIncidents = await query(
    `SELECT * FROM incidents WHERE org_id = $1 AND title LIKE 'EMERGENCY STOP%' AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
    [orgId]
  );
  const isHalted = openIncidents.length > 0;
  return {
    isHalted,
    incident: openIncidents[0] || null,
  };
}

export async function triggerEmergencyStop(orgId: string, reason = 'Operator triggered emergency kill switch', stoppedBy = 'shivam.maurya') {
  // 1. Halt all in-progress / paused / claimed tasks
  const haltedTasks = await query(
    `UPDATE tasks
     SET status = 'halted'
     WHERE org_id = $1 AND status IN ('claimed', 'in_progress', 'paused')
     RETURNING id, title, agent_id`,
    [orgId]
  );

  // 2. Halt all busy agents
  await query(
    `UPDATE agents
     SET status = 'halted'
     WHERE org_id = $1 AND status IN ('busy', 'idle')`,
    [orgId]
  );

  // 3. Create Critical Incident
  const incidentRows = await query(
    `INSERT INTO incidents (org_id, severity, title, description, evidence, status)
     VALUES ($1, 'critical', 'EMERGENCY STOP: Fleet Halted', $2, $3, 'open')
     RETURNING *`,
    [
      orgId,
      reason,
      JSON.stringify({
        stopped_by: stoppedBy,
        timestamp: new Date().toISOString(),
        affected_tasks_count: haltedTasks.length,
        affected_task_ids: haltedTasks.map(t => t.id),
      }),
    ]
  );

  // 4. Alert Slack
  if (SLACK_WEBHOOK_URL) {
    try {
      const webhook = new IncomingWebhook(SLACK_WEBHOOK_URL);
      await webhook.send({
        text: `🚨 EMERGENCY STOP: All agents halted by ${stoppedBy}`,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: '🚨 FLEET EMERGENCY STOP ACTIVATED' },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Operator:* ${stoppedBy}\n*Reason:* ${reason}\n*Tasks Halted:* ${haltedTasks.length}\n*Status:* All agent executions are frozen immediately.`,
            },
          },
        ],
      });
    } catch (e) {
      console.error('[emergency] Failed to send Slack alert:', e);
    }
  }

  return {
    success: true,
    haltedTasksCount: haltedTasks.length,
    incident: incidentRows[0],
  };
}

export async function resumeEmergencyStop(orgId: string, resumedBy = 'shivam.maurya') {
  // 1. Resolve open emergency incidents
  await query(
    `UPDATE incidents
     SET status = 'resolved', resolved_at = now()
     WHERE org_id = $1 AND title LIKE 'EMERGENCY STOP%' AND status = 'open'`,
    [orgId]
  );

  // 2. Return halted agents to idle
  await query(
    `UPDATE agents
     SET status = 'idle'
     WHERE org_id = $1 AND status = 'halted'`,
    [orgId]
  );

  // 3. Re-queue halted tasks so agents can safely resume
  const resumedTasks = await query(
    `UPDATE tasks
     SET status = 'queued'
     WHERE org_id = $1 AND status = 'halted'
     RETURNING id`,
    [orgId]
  );

  // 4. Alert Slack
  if (SLACK_WEBHOOK_URL) {
    try {
      const webhook = new IncomingWebhook(SLACK_WEBHOOK_URL);
      await webhook.send({
        text: `✅ Emergency stop lifted by ${resumedBy}. Fleet resumed.`,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: '✅ EMERGENCY STOP LIFTED' },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Operator:* ${resumedBy}\n*Action:* Fleet status restored to normal operations.\n*Tasks re-queued:* ${resumedTasks.length}`,
            },
          },
        ],
      });
    } catch (e) {
      console.error('[emergency] Failed to send Slack alert:', e);
    }
  }

  return {
    success: true,
    resumedTasksCount: resumedTasks.length,
  };
}
