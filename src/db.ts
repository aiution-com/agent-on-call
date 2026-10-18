import { Pool } from 'pg';
import { databaseUrl } from './config';

export const pool = new Pool({
  connectionString: databaseUrl,
});

// An idle client can be closed by the server, a pooler, or the network. The pg
// pool emits that as an error event; without a listener Node treats it as fatal
// and exits the process, dropping every in-flight request.
pool.on('error', error => console.error('[db] idle client error:', error.message));

export async function query(text: string, params?: any[]) {
  const result = await pool.query(text, params);
  return result.rows;
}

export async function transaction<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
