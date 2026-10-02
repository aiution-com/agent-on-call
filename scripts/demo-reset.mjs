#!/usr/bin/env node
// Returns the demo workspace to a known state between rehearsals.
//
// Wipes the agent/task/approval/incident history for ONE workspace and leaves
// everything else alone: the account stays, the session stays, and any
// configured alert destination stays (so the Alerts card is not empty when the
// demo opens). Pass --wipe-alerts if you want that gone too.
//
// Usage:
//   node scripts/demo-reset.mjs                        # default demo account
//   node scripts/demo-reset.mjs --email you@example.com
//   node scripts/demo-reset.mjs --wipe-alerts
//
// Refuses to run against anything that is not a local database.
import 'dotenv/config';
import pg from 'pg';

const args = process.argv.slice(2);
const emailIndex = args.indexOf('--email');
const email = emailIndex === -1 ? 'alex@company.com' : args[emailIndex + 1];
const wipeAlerts = args.includes('--wipe-alerts');

const connectionString = process.env.DATABASE_URL
  || 'postgresql://agentoncall:agentoncall@127.0.0.1:5432/agentoncall';

// The point of this script is to destroy rows. Keep it pointed at a scratch
// database: the whole project is meant to run against a local Postgres, and a
// hosted one would be somebody's real data.
const host = new URL(connectionString).hostname;
const LOCAL = ['127.0.0.1', 'localhost', '::1', '[::1]'];
if (!LOCAL.includes(host)) {
  console.error(`Refusing to run: DATABASE_URL points at "${host}", which is not local.`);
  console.error('This script deletes rows. Point it at your local database.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });

try {
  const users = await pool.query('SELECT org_id FROM users WHERE email=$1', [email]);
  if (!users.rows.length) {
    console.error(`No user with email ${email} in this database. Nothing to reset.`);
    process.exit(1);
  }
  const org = users.rows[0].org_id;

  const client = await pool.connect();
  const counts = {};
  try {
    await client.query('BEGIN');

    // Ordered by dependency: approvals and incidents reference agents and tasks,
    // and task_logs cascades from tasks.
    counts.approvals = (await client.query(
      'DELETE FROM approval_requests WHERE task_id IN (SELECT id FROM tasks WHERE org_id=$1) OR agent_id IN (SELECT id FROM agents WHERE org_id=$1)',
      [org],
    )).rowCount;
    counts.incidents = (await client.query('DELETE FROM incidents WHERE org_id=$1', [org])).rowCount;
    counts.task_logs = (await client.query(
      'DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE org_id=$1)',
      [org],
    )).rowCount;
    counts.tasks = (await client.query('DELETE FROM tasks WHERE org_id=$1', [org])).rowCount;
    counts.agents = (await client.query('DELETE FROM agents WHERE org_id=$1', [org])).rowCount;
    if (wipeAlerts) {
      counts.alert_channels = (await client.query('DELETE FROM alert_channels WHERE org_id=$1', [org])).rowCount;
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const kept = await pool.query('SELECT count(*)::int AS c FROM alert_channels WHERE org_id=$1', [org]);
  console.log(`reset workspace for ${email} (${org})`);
  console.log(`  deleted: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  console.log(`  kept:    the account, its session${wipeAlerts ? '' : `, and ${kept.rows[0].c} alert destination(s)`}`);
  console.log(`\nStart the server and the demo is back to an empty workspace.`);
} finally {
  await pool.end();
}
