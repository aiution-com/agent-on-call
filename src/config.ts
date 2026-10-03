import 'dotenv/config';

/**
 * Deployment configuration, read once at import.
 *
 * Every value here has a default that is safe on a developer's laptop. Nothing
 * in this file makes the app require new configuration to keep running locally;
 * the variables exist so a deployment can change the four decisions that differ
 * between a laptop and a server: what interface to bind, what sits in front of
 * the app, what database to talk to, and whether this is production at all.
 */

export const nodeEnv = process.env.NODE_ENV || 'development';
export const isProduction = nodeEnv === 'production';

export const port = Number(process.env.PORT) || 3000;

/**
 * The interface the HTTP server binds. The default is loopback, deliberately:
 * an app nobody configured should not appear on a public interface. A container
 * sets this to 0.0.0.0 because the container boundary is the isolation, and the
 * port is published to the host's loopback rather than the world.
 */
export const host = process.env.HOST || '127.0.0.1';

/**
 * What Express should believe about `X-Forwarded-*` headers.
 *
 * This is not cosmetic. `checkOrigin` compares the browser's `Origin` header
 * against `${req.protocol}://${req.get('host')}`, and `req.protocol` is only
 * `https` when the proxy that terminated TLS is trusted. Get this wrong behind
 * a TLS-terminating proxy and every mutating request fails the origin check
 * with a 403 that looks like a CSRF bug rather than a misconfiguration.
 *
 * The default suits the documented laptop topology, where cloudflared connects
 * over loopback. It does NOT suit a separate proxy container, which is why this
 * is configurable. See docs/DEPLOY.md.
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string | string[] {
  if (value === undefined || value.trim() === '') return 'loopback';
  const raw = value.trim();
  // Express's own vocabulary, passed through where it means the same thing.
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  // A bare integer is Express's "trust this many hops from the socket peer".
  if (/^\d+$/.test(raw)) return Number(raw);
  // A list of addresses or subnets, e.g. "loopback,172.16.0.0/12".
  if (raw.includes(',')) return raw.split(',').map(part => part.trim()).filter(Boolean);
  return raw;
}

export const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);

/**
 * The database to talk to.
 *
 * Outside production the fallback is the local development database, so a fresh
 * clone runs with no configuration. Under NODE_ENV=production there is no
 * fallback: silently connecting to the machine's own Postgres because an
 * environment variable went missing is the kind of mistake that is only noticed
 * after it has written to the wrong database.
 */
export const databaseUrl = (() => {
  const configured = process.env.DATABASE_URL;
  if (configured) return configured;
  if (isProduction) {
    throw new Error('DATABASE_URL must be set when NODE_ENV=production.');
  }
  return 'postgresql://agentoncall:agentoncall@127.0.0.1:5432/agentoncall';
})();

/** Whether the entrypoint should apply migrations before starting. Off by default. */
export const runMigrations = ['1', 'true', 'yes'].includes((process.env.RUN_MIGRATIONS || '').toLowerCase());
