import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('restore tolerates missing objects but not real failures', async () => {
  const { onlyMissingObjects } = await import('../scripts/restore-status.mjs');
  assert.equal(onlyMissingObjects('pg_restore: error: could not execute query: ERROR:  table "task_logs" does not exist\npg_restore: warning: errors ignored on restore: 1'), true);
  assert.equal(onlyMissingObjects('pg_restore: error: could not execute query: ERROR:  duplicate key value violates unique constraint "users_email_key"\npg_restore: warning: errors ignored on restore: 1'), false);
  assert.equal(onlyMissingObjects('pg_restore: error: connection to server at "127.0.0.1" failed'), false);
  assert.equal(onlyMissingObjects('pg_restore: warning: errors ignored on restore: 3'), false);
  assert.equal(onlyMissingObjects(''), false);
});

test('an idle database connection error does not crash the process', () => {
  const { pool } = require('../dist/db.js');
  assert.ok(pool.listenerCount('error') > 0, 'The pool must handle idle client errors');
});

test('backups are readable by their owner only', t => {
  if (spawnSync('pg_dump', ['--version'], { stdio: 'ignore' }).status !== 0) return t.skip('pg_dump is not installed');
  const dir = mkdtempSync(path.join(tmpdir(), 'aoc-backup-'));
  const output = path.join(dir, 'backup.dump');
  try {
    const run = spawnSync(process.execPath, ['scripts/backup.mjs', output], { cwd: root, env: { ...process.env }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
