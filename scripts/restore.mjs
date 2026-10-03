#!/usr/bin/env node
// Restores a backup written by scripts/backup.mjs.
//
//   node scripts/restore.mjs backups/agentoncall-....dump --yes
//
// This DROPS the objects in the target database before recreating them, so it
// destroys whatever is there now. It therefore refuses to run without --yes:
// a destructive command that runs by accident when someone mistypes a filename
// is worse than one that makes you type a flag.
//
// Expect the application to be stopped while this runs. pg_restore needs to
// drop tables that the app may be holding open.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const confirmed = args.includes('--yes');

if (!file) {
  console.error('Usage: node scripts/restore.mjs <backup.dump> --yes');
  process.exit(1);
}

const source = path.resolve(file);
if (!existsSync(source)) {
  console.error(`No such file: ${source}`);
  process.exit(1);
}

if (!confirmed) {
  const kb = (statSync(source).size / 1024).toFixed(1);
  console.error(`About to restore ${source} (${kb} KB) into the database.`);
  console.error('This DROPS existing tables and replaces their contents.');
  console.error('Stop the app first, then re-run with --yes to confirm.');
  process.exit(1);
}

const dump = readFileSync(source);

function has(command) {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

function composeDbAvailable() {
  if (!has('docker')) return false;
  return spawnSync('docker', ['compose', 'exec', '-T', 'db', 'pg_isready'], { stdio: 'ignore' }).status === 0;
}

let result;
let how;
if (has('pg_restore') && process.env.DATABASE_URL) {
  how = 'pg_restore on PATH';
  result = spawnSync('pg_restore', [
    '--dbname', process.env.DATABASE_URL,
    '--clean', '--if-exists', '--no-owner',
  ], { input: dump, maxBuffer: 1024 * 1024 * 512 });
} else if (composeDbAvailable()) {
  how = 'pg_restore inside the compose db container';
  result = spawnSync('docker', [
    'compose', 'exec', '-T', 'db',
    'pg_restore', '-U', process.env.POSTGRES_USER || 'agentoncall',
    '-d', process.env.POSTGRES_DB || 'agentoncall',
    '--clean', '--if-exists', '--no-owner',
  ], { input: dump, maxBuffer: 1024 * 1024 * 512 });
} else {
  console.error('No way to reach the database.');
  console.error('Either put pg_restore on PATH and set DATABASE_URL, or start the compose stack with `docker compose up -d db`.');
  process.exit(1);
}

// pg_restore reports a non-zero status when --clean tries to drop objects that
// were never there, which is expected on a first restore into an empty
// database. Only the stderr is worth reading, so show it rather than guess.
if (result.status !== 0) {
  const stderr = (result.stderr || '').toString().trim();
  const onlyMissingObjects = /does not exist|errors ignored on restore/i.test(stderr)
    && !/fatal|connection|could not/i.test(stderr);
  if (onlyMissingObjects) {
    console.log(`restored ${source} via ${how} (dropping objects that did not exist yet)`);
    process.exit(0);
  }
  console.error(`Restore failed via ${how}.`);
  if (stderr) console.error(stderr);
  process.exit(1);
}

console.log(`restored ${source} via ${how}`);
console.log('Start the app again, then confirm your workspace and its alert destinations are back.');
