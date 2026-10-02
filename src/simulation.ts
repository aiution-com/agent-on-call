import { query } from './db';
import { postApprovalToSlack } from './slack';
import { runWatchdogCycle } from './watchdog';
import { IncomingWebhook } from '@slack/webhook';
import 'dotenv/config';

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';

/**
 * Scenario 1: Production Canary Rollout (Human-in-the-Loop Gate)
 * High-stakes deploy proposal pauses itself, pings Slack with diff & buttons, awaits human sign-off.
 */
export async function simulateCanaryRollout(orgId: string) {
  let agentRows = await query(
    `SELECT * FROM agents WHERE org_id = $1 AND name = 'devops-sentinel' LIMIT 1`,
    [orgId]
  );

  let agentId: string;
  if (agentRows.length === 0) {
    const newAgent = await query(
      `INSERT INTO agents (org_id, name, type, owner_email, capabilities, status, health_score, last_seen_at)
       VALUES ($1, 'devops-sentinel', 'DevOps & SRE', 'sre-oncall@agentoncall.dev', $2, 'busy', 99, now())
       RETURNING *`,
      [
        orgId,
        JSON.stringify({
          model: 'claude-3-5-sonnet',
          skills: ['k8s-rollout', 'slo-monitoring', 'canary-traffic'],
          version: '2.4.0',
        }),
      ]
    );
    agentId = newAgent[0].id;
  } else {
    agentId = agentRows[0].id;
    await query(`UPDATE agents SET status = 'busy', last_seen_at = now() WHERE id = $1`, [agentId]);
  }

  const patchVersion = Math.floor(Math.random() * 9 + 1);
  const taskTitle = `Production Canary Rollout: Payment Gateway v4.${patchVersion}.0`;
  const taskRows = await query(
    `INSERT INTO tasks (org_id, agent_id, title, description, source, status, budget_usd, spent_usd, permissions, required_approvals, claimed_at, started_at)
     VALUES ($1, $2, $3, $4, 'slack-ops', 'paused', 25.00, 0.45, $5, $6, now(), now())
     RETURNING *`,
    [
      orgId,
      agentId,
      taskTitle,
      'Automated zero-downtime canary deployment across AWS EKS clusters. 248 integration tests passed.',
      JSON.stringify({ deploy_production: true, rollback_allowed: true }),
      JSON.stringify(['production_deploy']),
    ]
  );
  const taskId = taskRows[0].id;

  const approvalRows = await query(
    `INSERT INTO approval_requests (task_id, agent_id, type, amount_usd, context, status, approver_chain)
     VALUES ($1, $2, 'production_deploy', 0, $3, 'pending', $4)
     RETURNING *`,
    [
      taskId,
      agentId,
      JSON.stringify({
        cluster: 'prod-us-east-1-eks',
        service: 'payment-gateway',
        canary_traffic: '10% (5-min soak window)',
        automated_tests: '248 / 248 passed',
        slo_impact: '< 0.01% error budget',
        rollback_trigger: 'Auto-rollback if 5xx > 0.05%',
      }),
      JSON.stringify(['shivam@agentoncall.dev']),
    ]
  );
  const approvalId = approvalRows[0].id;

  let slackNotified = false;
  try {
    const slackRes = await postApprovalToSlack(approvalId);
    slackNotified = slackRes.ok;
  } catch (err) {
    console.error('[simulation] Slack notify error:', err);
  }

  return {
    scenario: 'canary_rollout',
    agentId,
    taskId,
    approvalId,
    slackNotified,
    taskTitle,
    summary: 'Autonomous agent requested human authorization before deploying to production.',
  };
}

/**
 * Scenario 2: Runaway LLM Loop / Cost Spike Clamped
 * Simulates an autonomous agent caught in an expensive recursive loop.
 * The Watchdog intercepts the budget cap breach, clamps the task to halted, and alerts Slack.
 */
export async function simulateRunawaySpend(orgId: string) {
  let agentRows = await query(
    `SELECT * FROM agents WHERE org_id = $1 AND name = 'data-scraper-bot' LIMIT 1`,
    [orgId]
  );

  let agentId: string;
  if (agentRows.length === 0) {
    const newAgent = await query(
      `INSERT INTO agents (org_id, name, type, owner_email, capabilities, status, health_score, last_seen_at)
       VALUES ($1, 'data-scraper-bot', 'Data Processing', 'data-ops@agentoncall.dev', $2, 'busy', 95, now())
       RETURNING *`,
      [
        orgId,
        JSON.stringify({ model: 'gpt-4o', rate_limit: '100rpm' }),
      ]
    );
    agentId = newAgent[0].id;
  } else {
    agentId = agentRows[0].id;
    await query(`UPDATE agents SET status = 'busy', last_seen_at = now() WHERE id = $1`, [agentId]);
  }

  // Create task with strict $5 budget cap, but current spend is $5.20 (runaway loop)
  const taskTitle = `Bulk Financial Report Synthesis (Recursive Deep Search)`;
  const taskRows = await query(
    `INSERT INTO tasks (org_id, agent_id, title, description, source, status, budget_usd, spent_usd, permissions, claimed_at, started_at)
     VALUES ($1, $2, $3, $4, 'cron-pipeline', 'in_progress', 5.00, 5.25, $5, now(), now())
     RETURNING *`,
    [
      orgId,
      agentId,
      taskTitle,
      'High-throughput web document synthesis. LLM loop triggered rapid OpenAI API calls.',
      JSON.stringify({ network_egress: true }),
    ]
  );
  const taskId = taskRows[0].id;

  // Run the watchdog to immediately catch and clamp this runaway task
  const report = await runWatchdogCycle(orgId);

  return {
    scenario: 'runaway_spend_clamped',
    agentId,
    taskId,
    budgetCap: 5.00,
    currentSpend: 5.25,
    taskTitle,
    watchdogReport: report,
    summary: 'Autonomous watchdog detected runaway spend loop and clamped execution before card drained.',
  };
}

/**
 * Scenario 3: Dead-Man Switch Tripped (Unresponsive Agent)
 * Simulates a coding agent crashing mid-execution or hanging on a socket without heartbeats.
 * Watchdog flags the zombie task, degrades health score, auto-creates a P1 Incident, and alerts Slack.
 */
export async function simulateAgentHang(orgId: string) {
  let agentRows = await query(
    `SELECT * FROM agents WHERE org_id = $1 AND name = 'code-synthesizer-9' LIMIT 1`,
    [orgId]
  );

  let agentId: string;
  if (agentRows.length === 0) {
    const newAgent = await query(
      `INSERT INTO agents (org_id, name, type, owner_email, capabilities, status, health_score, last_seen_at)
       VALUES ($1, 'code-synthesizer-9', 'Autonomous Coding', 'eng-leads@agentoncall.dev', $2, 'busy', 98, now() - INTERVAL '5 minutes')
       RETURNING *`,
      [
        orgId,
        JSON.stringify({ model: 'deepseek-coder-v2', runtime: 'docker-isolated' }),
      ]
    );
    agentId = newAgent[0].id;
  } else {
    agentId = agentRows[0].id;
    // Force last_seen_at to 5 minutes ago to simulate silent freeze
    await query(
      `UPDATE agents SET status = 'busy', last_seen_at = now() - INTERVAL '5 minutes' WHERE id = $1`,
      [agentId]
    );
  }

  const taskTitle = `Refactor Monolith Auth Module into Go Microservice`;
  const taskRows = await query(
    `INSERT INTO tasks (org_id, agent_id, title, description, source, status, budget_usd, spent_usd, permissions, claimed_at, started_at)
     VALUES ($1, $2, $3, $4, 'linear-ticket', 'in_progress', 15.00, 1.80, $5, now() - INTERVAL '5 minutes', now() - INTERVAL '5 minutes')
     RETURNING *`,
    [
      orgId,
      agentId,
      taskTitle,
      'Complex multi-file refactoring and AST parsing. Process became unresponsive.',
      JSON.stringify({ repo_write: true }),
    ]
  );
  const taskId = taskRows[0].id;

  // Run watchdog to detect the unresponsive agent
  const report = await runWatchdogCycle(orgId);

  return {
    scenario: 'agent_hang_deadman_tripped',
    agentId,
    taskId,
    taskTitle,
    watchdogReport: report,
    summary: 'Dead-man switch tripped: agent stopped sending heartbeats for > 3 minutes. P1 incident opened.',
  };
}

// Backward compatible export
export const simulateAgentRun = simulateCanaryRollout;
