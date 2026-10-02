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

/** Expands an IPv6 literal to its eight hextets, or null when it is malformed. */
function expandV6(address: string): number[] | null {
  const parts = address.replace(/^\[|\]$/g, '').toLowerCase().split('::');
  if (parts.length > 2) return null;
  const groups = (part: string): string[] => (part ? part.split(':') : []);
  const head = groups(parts[0]);
  const tail = parts.length === 2 ? groups(parts[1]) : [];
  const width = (list: string[]): number => list.reduce((total, part) => total + (part.includes('.') ? 2 : 1), 0);
  const fill = 8 - width(head) - width(tail);
  if (fill < 0 || (parts.length === 1 && fill !== 0)) return null;
  const filler = parts.length === 2 ? new Array<string>(fill).fill('0') : [];
  const values: number[] = [];
  for (const part of [...head, ...filler, ...tail]) {
    if (part.includes('.')) {
      const octets = part.split('.').map(Number);
      if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
      values.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    } else {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      values.push(parseInt(part, 16));
    }
  }
  return values.length === 8 ? values : null;
}

/** Dotted-quad text for the low 32 bits of an expanded IPv6 address. */
function low32(hextets: number[]): string {
  return [hextets[6], hextets[7]].map(pair => `${pair >> 8}.${pair & 0xff}`).join('.');
}

export function isBlockedAddress(address: string): boolean {
  const plain = address.replace(/^\[|\]$/g, '');
  const version = isIP(plain);
  if (version === 4) return blockedV4(plain);
  if (version !== 6) return false;
  const hextets = expandV6(plain);
  if (!hextets) return true;
  const [a, b, c, d, e, f] = hextets;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0) {
    return f === 0xffff ? blockedV4(low32(hextets)) : true;
  }
  if ((a & 0xfe00) === 0xfc00) return true;
  if ((a & 0xffc0) === 0xfe80 || (a & 0xffc0) === 0xfec0) return true;
  if ((a & 0xff00) === 0xff00) return true;
  if (a === 0x0064 && b === 0xff9b && c === 0 && d === 0 && e === 0) return true;
  if (a === 0x2001 && b === 0x0db8) return true;
  return false;
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
  const bare = host.replace(/\.$/, '');
  if (bare === 'localhost' || bare.endsWith('.localhost')) fail('Alert URLs cannot point at localhost.');
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
