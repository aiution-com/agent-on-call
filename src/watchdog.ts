import { query } from './db';
import { IncomingWebhook } from '@slack/webhook';
import 'dotenv/config';

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';

export interface WatchdogReport {
  timestamp: string;
  stuckAgentsDetected: number;
  budgetBreachesDetected: number;
  incidentsCreated: number;
  details: string[];
}

/**
 * Autonomous Fleet Watchdog:
 * 1. Dead-Man Switch: Flags busy agents that have missed heartbeats (>3 minutes).
 * 2. Budget Runaway Guard: Auto-halts tasks whose spent_usd exceeds budget_usd.
 * 3. Health Score Degradation: Dynamically adjusts agent health scores based on anomalies.
 */
export async function runWatchdogCycle(orgId = '00000000-0000-0000-0000-000000000001'): Promise<WatchdogReport> {
  const details: string[] = [];
  let stuckCount = 0;
  let budgetBreachCount = 0;
  let incidentsCreated = 0;

  // 1. Check for Stuck / Unresponsive Agents (busy for > 3 minutes with no heartbeat)
  const stuckAgents = await query(
    `SELECT a.id, a.name, a.type, a.last_seen_at, t.id as task_id, t.title as task_title
     FROM agents a
     JOIN tasks t ON t.agent_id = a.id AND t.status = 'in_progress'
     WHERE a.org_id = $1
       AND a.status = 'busy'
       AND a.last_seen_at < now() - INTERVAL '3 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM incidents i
         WHERE i.agent_id = a.id AND i.status = 'open' AND i.title LIKE 'WATCHDOG: Agent Unresponsive%'
       )`,
    [orgId]
  );

  for (const agent of stuckAgents) {
    stuckCount++;
    // Degrade health score & set status to stuck
    await query(
      `UPDATE agents SET status = 'stuck', health_score = 35 WHERE id = $1`,
      [agent.id]
    );

    // Pause the task
    await query(
      `UPDATE tasks SET status = 'paused' WHERE id = $1`,
      [agent.task_id]
    );

    // Create Critical Incident
    await query(
      `INSERT INTO incidents (org_id, agent_id, task_id, severity, title, description, evidence, status)
       VALUES ($1, $2, $3, 'critical', 'WATCHDOG: Agent Unresponsive (Dead-Man Switch Triggered)',
               $4, $5, 'open')`,
      [
        orgId,
        agent.id,
        agent.task_id,
        `Agent '${agent.name}' stopped reporting heartbeats while processing '${agent.task_title}'. Task paused safely.`,
        JSON.stringify({
          last_seen_at: agent.last_seen_at,
          action_taken: 'Task auto-paused to prevent zombie processing',
        }),
      ]
    );
    incidentsCreated++;
    details.push(`Dead-man switch tripped for ${agent.name} on task ${agent.task_id}`);

    // Alert Slack
    if (SLACK_WEBHOOK_URL) {
      try {
        const webhook = new IncomingWebhook(SLACK_WEBHOOK_URL);
        await webhook.send({
          text: `🚨 WATCHDOG ALERT: Agent ${agent.name} is unresponsive!`,
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: '🚨 WATCHDOG: UNRESPONSIVE AGENT DETECTED' },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Agent:* \`${agent.name}\` (${agent.type})\n*Task:* ${agent.task_title}\n*Incident:* Missed heartbeat timeout (> 3 min)\n*Action:* Task auto-paused to protect execution queue.`,
              },
            },
          ],
        });
      } catch (e) {
        console.error('[watchdog] Slack notify error:', e);
      }
    }
  }

  // 2. Check for Budget Runaway Breaches (spent_usd >= budget_usd on active tasks)
  const runawayTasks = await query(
    `SELECT t.id, t.title, t.budget_usd, t.spent_usd, a.id as agent_id, a.name as agent_name
     FROM tasks t
     LEFT JOIN agents a ON t.agent_id = a.id
     WHERE t.org_id = $1
       AND t.status IN ('in_progress', 'claimed')
       AND t.budget_usd IS NOT NULL
       AND t.spent_usd >= t.budget_usd
       AND NOT EXISTS (
         SELECT 1 FROM incidents i
         WHERE i.task_id = t.id AND i.status = 'open' AND i.title LIKE 'WATCHDOG: Budget Cap Exceeded%'
       )`,
    [orgId]
  );

  for (const task of runawayTasks) {
    budgetBreachCount++;
    // Clamp task to halted
    await query(
      `UPDATE tasks SET status = 'halted' WHERE id = $1`,
      [task.id]
    );

    // Auto-create High Severity Incident
    await query(
      `INSERT INTO incidents (org_id, agent_id, task_id, severity, title, description, evidence, status)
       VALUES ($1, $2, $3, 'high', 'WATCHDOG: Budget Cap Exceeded (Runaway Clamped)',
               $4, $5, 'open')`,
      [
        orgId,
        task.agent_id,
        task.id,
        `Task '${task.title}' reached $${task.spent_usd} spend against a $${task.budget_usd} cap. Execution halted immediately.`,
        JSON.stringify({
          budget_usd: task.budget_usd,
          spent_usd: task.spent_usd,
          agent_name: task.agent_name,
        }),
      ]
    );
    incidentsCreated++;
    details.push(`Budget clamp activated on task '${task.title}' ($${task.spent_usd}/$${task.budget_usd})`);

    // Alert Slack
    if (SLACK_WEBHOOK_URL) {
      try {
        const webhook = new IncomingWebhook(SLACK_WEBHOOK_URL);
        await webhook.send({
          text: `⚠️ WATCHDOG ALERT: Runaway spend clamped on ${task.title}!`,
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: '⚠️ RUNAWAY SPEND AUTOMATICALLY CLAMPED' },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Task:* ${task.title}\n*Agent:* ${task.agent_name || 'Autonomous Worker'}\n*Budget Cap:* $${task.budget_usd}\n*Current Spend:* $${task.spent_usd}\n*Action:* Task execution frozen before additional charges incurred.`,
              },
            },
          ],
        });
      } catch (e) {
        console.error('[watchdog] Slack notify error:', e);
      }
    }
  }

  return {
    timestamp: new Date().toISOString(),
    stuckAgentsDetected: stuckCount,
    budgetBreachesDetected: budgetBreachCount,
    incidentsCreated,
    details,
  };
}

let watchdogTimer: NodeJS.Timeout | null = null;

export function startWatchdogService(intervalMs = 20000) {
  if (watchdogTimer) return;
  console.log(`[watchdog] Autonomous Fleet Watchdog started (cycle every ${intervalMs / 1000}s)`);
  watchdogTimer = setInterval(async () => {
    try {
      await runWatchdogCycle();
    } catch (err) {
      console.error('[watchdog] Execution error:', err);
    }
  }, intervalMs);
}

export function stopWatchdogService() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
    console.log('[watchdog] Autonomous Fleet Watchdog stopped');
  }
}
