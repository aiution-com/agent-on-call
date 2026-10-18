#!/usr/bin/env node
// Writes a compressed backup of the database to a file.
//
//   node scripts/backup.mjs                       # backups/agentoncall-<timestamp>.dump
//   node scripts/backup.mjs /path/to/name.dump    # a specific path
//
// Uses pg_dump directly when it is on PATH, and otherwise falls back to running
// it inside the compose database container. The fallback matters: the common
// case is a deployment where Postgres lives in a container and the host has no
// PostgreSQL client tools installed at all.
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const outputArg = process.argv[2];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.resolve(outputArg || path.join('backups', `agentoncall-${stamp}.dump`));

/** True when the named executable is runnable. */
function has(command) {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

/** True when a compose database service is running. */
function composeDbAvailable() {
  if (!has('docker')) return false;
  const probe = spawnSync('docker', ['compose', 'exec', '-T', 'db', 'pg_isready'], { stdio: 'ignore' });
  return probe.status === 0;
}

let result;
let how;
if (has('pg_dump') && process.env.DATABASE_URL) {
  how = 'pg_dump on PATH';
  result = spawnSync('pg_dump', ['--dbname', process.env.DATABASE_URL, '--format=custom'], {
    maxBuffer: 1024 * 1024 * 512,
  });
} else if (composeDbAvailable()) {
  how = 'pg_dump inside the compose db container';
  result = spawnSync('docker', [
    'compose', 'exec', '-T', 'db',
    'pg_dump', '-U', process.env.POSTGRES_USER || 'agentoncall',
    '-d', process.env.POSTGRES_DB || 'agentoncall',
    '--format=custom',
  ], { maxBuffer: 1024 * 1024 * 512 });
} else {
  console.error('No way to reach the database.');
  console.error('Either put pg_dump on PATH and set DATABASE_URL, or start the compose stack with `docker compose up -d db`.');
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`Backup failed via ${how}.`);
  if (result.stderr) console.error(result.stderr.toString().trim());
  process.exit(1);
}

const dump = result.stdout;
if (!dump || dump.length === 0) {
  console.error(`Backup via ${how} produced no output. Refusing to write an empty file.`);
  process.exit(1);
}

mkdirSync(path.dirname(output), { recursive: true });
// The dump holds password, session, API-key and alert-signing hashes.
writeFileSync(output, dump, { mode: 0o600 });

const kb = (statSync(output).size / 1024).toFixed(1);
console.log(`wrote ${output} (${kb} KB) via ${how}`);
console.log('Restore it with:  node scripts/restore.mjs ' + path.relative(process.cwd(), output) + ' --yes');
