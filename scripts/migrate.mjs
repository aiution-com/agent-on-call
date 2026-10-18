import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://agentoncall:agentoncall@127.0.0.1:5432/agentoncall',
});

try {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [78194321]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    for (const name of ['001_initial_schema.sql', '002_task_logs.sql', '003_accounts.sql', '004_alert_channels.sql', '005_stop_acknowledgment.sql', '006_agent_key_scope.sql']) {
      const existing = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (existing.rowCount) {
        console.log(`skip ${name} (already applied)`);
        continue;
      }

      const sql = await readFile(path.join(root, 'migrations', name), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        console.log(`applied ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [78194321]);
    client.release();
  }
} finally {
  await pool.end();
}
