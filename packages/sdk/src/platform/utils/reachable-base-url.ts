/**
 * Reachable base URL for notification deep links.
 *
 * `0.0.0.0` (and `::`) is a BIND address, not a destination. When the control
 * plane is configured to bind every interface, the configured base URL can end
 * up carrying that wildcard verbatim — and a notification whose click target is
 * `http://0.0.0.0:3421/...` goes nowhere when it is tapped on a phone.
 *
 * The rule this module implements:
 *
 * 1. A configured URL with a real host is used as-is.
 * 2. A wildcard host is replaced with the machine's own routable LAN address,
 *    keeping the scheme, port, and path — that is the address a phone on the
 *    same network can actually reach.
 * 3. With no LAN address to substitute, the URL is dropped and the caller omits
 *    the click target entirely. A missing link beats a broken one.
 *
 * Loopback is deliberately left alone: `127.0.0.1` is the shipped default and
 * is genuinely correct for a notification clicked on the host itself.
 */
import { networkInterfaces as osNetworkInterfaces } from 'node:os';

const WILDCARD_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0', '[0:0:0:0:0:0:0:0]', '*']);

export function isWildcardHost(host: string | undefined): boolean {
  if (!host) return true;
  return WILDCARD_HOSTS.has(host.trim().toLowerCase());
}

export interface NetworkInterfaceAddress {
  readonly address: string;
  readonly family: string | number;
  readonly internal: boolean;
}

export type NetworkInterfaceReader = () => Record<string, readonly NetworkInterfaceAddress[] | undefined>;

/**
 * The first non-internal IPv4 address on this host, or null. IPv4 only: an
 * IPv6 literal in a notification click target is far more likely to be
 * unroutable from a phone than helpful.
 */
export function findRoutableHostAddress(readInterfaces: NetworkInterfaceReader = osNetworkInterfaces): string | null {
  let interfaces: Record<string, readonly NetworkInterfaceAddress[] | undefined>;
  try {
    interfaces = readInterfaces();
  } catch {
    return null;
  }
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const isIpv4 = entry.family === 'IPv4' || entry.family === 4;
      if (!isIpv4 || entry.internal) continue;
      if (!entry.address || entry.address.startsWith('169.254.')) continue;
      return entry.address;
    }
  }
  return null;
}

/**
 * Normalize one candidate base URL. Returns null when the URL is unusable as a
 * click destination and no substitute host is available.
 */
export function normalizeReachableBaseUrl(
  raw: string | undefined,
  readInterfaces: NetworkInterfaceReader = osNetworkInterfaces,
): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!isWildcardHost(url.hostname)) {
    return url.toString().replace(/\/+$/, '');
  }
  const routable = findRoutableHostAddress(readInterfaces);
  if (!routable) return null;
  url.hostname = routable;
  return url.toString().replace(/\/+$/, '');
}

export interface ReachableBaseUrlReader {
  get(key: string): unknown;
}

/**
 * The base URL notification deep links should use, or undefined when nothing
 * configured resolves to something reachable. Callers MUST treat undefined as
 * "omit the click target", not as "fall back to the raw config string".
 */
export function resolveReachableBaseUrl(
  reader: ReachableBaseUrlReader,
  readInterfaces: NetworkInterfaceReader = osNetworkInterfaces,
): string | undefined {
  const candidates = [reader.get('controlPlane.baseUrl'), reader.get('web.publicBaseUrl')];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = normalizeReachableBaseUrl(candidate, readInterfaces);
    if (normalized) return normalized;
  }
  return undefined;
}
