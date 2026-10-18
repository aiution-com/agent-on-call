#!/usr/bin/env node
// Host-side account recovery. There is no self-service email reset, so an
// operator with database access can set a new password and revoke sessions.
import 'dotenv/config';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';

const scrypt = promisify(scryptCallback);
const args = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const email = String(flag('email') || process.env.AOC_EMAIL || '').trim().toLowerCase();
// Prefer AOC_NEW_PASSWORD: a password passed as a flag is visible to other
// users of the host and stays in shell history.
const password = process.env.AOC_NEW_PASSWORD || flag('password') || '';

if (!email || password.length < 12 || password.length > 128) {
  console.error('Usage: AOC_EMAIL=user@example.com AOC_NEW_PASSWORD=... node scripts/reset-password.mjs');
  console.error('The new password must be between 12 and 128 characters.');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://agentoncall:agentoncall@127.0.0.1:5432/agentoncall',
});

try {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query('UPDATE users SET password_hash=$1 WHERE lower(email)=$2 RETURNING id', [`${salt}:${hash.toString('hex')}`, email]);
    if (!user.rowCount) {
      await client.query('ROLLBACK');
      console.error(`No account uses ${email}.`);
      process.exitCode = 1;
    } else {
      const sessions = await client.query('DELETE FROM sessions WHERE user_id=$1', [user.rows[0].id]);
      await client.query('COMMIT');
      console.log(`Password reset for ${email}. ${sessions.rowCount} session(s) signed out.`);
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
