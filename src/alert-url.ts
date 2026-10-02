import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';

/** Loopback, private, link-local, carrier-grade NAT, multicast and unspecified ranges. */
function blockedV4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19));
}

export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return blockedV4(address);
  if (version !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blockedV4(mapped[1]);
  const normalised = address.toLowerCase();
  return normalised === '::' || normalised === '::1'
    || /^f[cd]/.test(normalised)
    || /^fe[89ab]/.test(normalised)
    || /^ff/.test(normalised);
}

const fail = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }); };

/** Validates a channel URL and returns the normalized href to store. */
export function validChannelUrl(value: unknown): { url: string; host: string } {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) fail('An alert URL is required.');
  if (raw.length > 1000) fail('Alert URLs must be 1000 characters or fewer.');
  const parsed = ((): URL => { try { return new URL(raw); } catch { return fail('Enter a valid alert URL.'); } })();
  if (parsed.protocol !== 'https:') fail('Alert URLs must use https.');
  if (parsed.username || parsed.password) fail('Remove the credentials from the alert URL.');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host) fail('Enter a valid alert URL.');
  if (host === 'localhost' || host.endsWith('.localhost')) fail('Alert URLs cannot point at localhost.');
  if (isBlockedAddress(host)) fail('Alert URLs cannot point at a private or internal address.');
  return { url: parsed.href, host };
}

/**
 * Refuses delivery to a host that resolves anywhere internal. The hostname is resolved
 * at send time because DNS can change after the URL was saved.
 *
 * Known limit: fetch resolves the host again when it connects, so an authoritative server
 * that answers differently between this check and the connection can still win the race.
 * Redirects are refused and only an authenticated operator can supply the URL at all.
 */
export async function assertDeliverableAddress(host: string): Promise<void> {
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('Address is not publicly routable.');
    return;
  }
  const addresses = await dns.lookup(host, { all: true });
  if (!addresses.length) throw new Error('Host did not resolve.');
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) throw new Error('Host resolves to a private address.');
  }
}
