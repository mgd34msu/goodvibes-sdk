/**
 * Reachable base URL for notification deep links.
 *
 * `0.0.0.0` (and `::`) is a BIND address, not a destination. When the control
 * plane is configured to bind every interface, the configured base URL can end
 * up carrying that wildcard verbatim, and a notification whose click target is
 * `http://0.0.0.0:3421/...` goes nowhere when it is tapped on a phone.
 *
 * The rule this module implements:
 *
 * 1. A configured URL with a real host is used as-is.
 * 2. A wildcard host is replaced with the machine's own routable LAN address,
 *    keeping the scheme, port, and path, that is the address a phone on the
 *    same network can actually reach.
 * 3. With no LAN address to substitute, the URL is dropped and the caller omits
 *    the click target entirely. A missing link beats a broken one.
 * 4. A LOOPBACK host is substituted the same way, but ONLY when the control
 *    plane is actually bound somewhere off-host (a wildcard or LAN bind). See
 *    below.
 *
 * ONE MODE, ONE ANSWER (owner ruling: "if it is set to network, it should NOT
 * be exposing local")
 *
 * The effective BIND decides the host, totally:
 *
 *   network (binds 0.0.0.0, or a LAN address) -> the LAN address. Never
 *     127.0.0.1, which is useless on the phone the notification is read on,
 *     and never 0.0.0.0, which is a bind address rather than a destination.
 *   local   (binds 127.0.0.1)                 -> loopback. Never "upgraded" to
 *     a LAN address the daemon does not answer on.
 *
 * Because the host is a pure function of the mode, one run cannot emit both
 * forms, the state the owner observed (127.0.0.1 and 0.0.0.0 in the same
 * burst) is not representable from a single configuration.
 *
 * WHY LOOPBACK IS CONDITIONAL
 *
 * `http://127.0.0.1:3421` is the shipped default posture and it is correct for
 * a link opened on the host itself, and dead for the same notification tapped
 * on a phone, which is where these notifications are actually read. Rewriting
 * it unconditionally would trade a link that works in one place for a link
 * that works nowhere, because a daemon bound to 127.0.0.1 does not answer on
 * its LAN address at all.
 *
 * So the substitution is driven by the BIND address, and whether a loopback
 * answer is acceptable at all is driven by WHERE THE LINK IS GOING
 * ({@link ClickTargetDestination}). A loopback-only daemon has no answer for an
 * off-host destination, so the link is omitted rather than fabricated.
 *
 * A wildcard bind serves loopback AND the LAN address at the same time, so
 * both keep working: the destination picks which one this particular link
 * needs. `0.0.0.0` itself is never emitted, it is a bind address, not a
 * destination.
 */
import { networkInterfaces as osNetworkInterfaces } from 'node:os';
import {
  deriveControlPlaneBaseUrl,
  readControlPlaneBinding,
} from '../config/control-plane-base-url.js';

const WILDCARD_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0', '[0:0:0:0:0:0:0:0]', '*']);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isWildcardHost(host: string | undefined): boolean {
  if (!host) return true;
  return WILDCARD_HOSTS.has(host.trim().toLowerCase());
}

/** Loopback: correct on this machine, unreachable from any other one. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const normalized = host.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(normalized) || normalized.startsWith('127.');
}

/**
 * Is the control plane answering on an address other machines can reach?
 *
 * True for a wildcard bind and for an explicit LAN/hostname bind; false for
 * loopback and for an unset host (the shipped default is loopback).
 */
export function isOffHostBind(bindHost: string | undefined): boolean {
  const normalized = (bindHost ?? '').trim();
  if (!normalized) return false;
  if (isLoopbackHost(normalized)) return false;
  return true;
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
/**
 * The two answers there are. One run has exactly one of these, because it has
 * exactly one effective bind.
 */
export type ClickTargetMode = 'network' | 'local';

/**
 * Where the link is GOING, the discriminator, per the owner's ruling.
 *
 * - `off-host` the link will be opened somewhere else: a notification tapped
 *   on a phone, a manifest handed to Home Assistant, an attachment URL posted
 *   into a chat. Loopback is meaningless there.
 * - `local`    the link will be opened on this machine.
 *
 * The bind mode alone cannot answer this. A loopback-only daemon used to put
 * `127.0.0.1` in the `Click` header of a notification read on a phone, which
 * is a dead link every time.
 */
export type ClickTargetDestination = 'off-host' | 'local';

/**
 * The bind mode in force, from the address the control plane is bound to.
 *
 * `network` means the daemon answers on every interface (or on a specific LAN
 * address); `local` means it answers only on loopback. Nothing else is a mode.
 */
export function resolveClickTargetMode(bindHost: string | undefined): ClickTargetMode {
  return isOffHostBind(bindHost) ? 'network' : 'local';
}

/**
 * The ONE host a click target may carry, given the bind mode and where the
 * link is going:
 *
 * | bind mode | destination | host                                        |
 * |-----------|-------------|---------------------------------------------|
 * | network   | off-host    | this machine's routable LAN address, or null |
 * | network   | local       | loopback                                     |
 * | local     | off-host    | **null**, nothing off-host can reach it     |
 * | local     | local       | loopback                                     |
 *
 * Never the wildcard: `0.0.0.0` is a bind address, not a destination, and is
 * not emitted in any mode. Null means the caller OMITS the link, a missing
 * link beats a broken one.
 *
 * Note the `network` + `local` cell: loopback is served by a wildcard bind, so
 * it is correct there. A daemon bound to one specific LAN address and nothing
 * else does not answer on loopback; that posture has no in-tree caller today
 * (every current caller is off-host) and is called out here rather than
 * silently assumed away.
 */
export function resolveClickTargetHost(
  mode: ClickTargetMode,
  destination: ClickTargetDestination,
  readInterfaces: NetworkInterfaceReader = osNetworkInterfaces,
): string | null {
  if (destination === 'local') return LOOPBACK_CLICK_HOST;
  return mode === 'network' ? findRoutableHostAddress(readInterfaces) : null;
}

const LOOPBACK_CLICK_HOST = '127.0.0.1';
const WILDCARD_BIND_HOST = '0.0.0.0';

/**
 * Normalize one candidate base URL.
 *
 * A URL carrying a REAL host (a hostname, a LAN address, a tunnel) is the
 * operator's declared destination and passes through untouched in either mode.
 * A loopback or wildcard host is derived, not declared, and the mode decides
 * it, see {@link resolveClickTargetHost}. Returns null when the result would
 * not be reachable, and the caller omits the click target.
 */
export function normalizeReachableBaseUrl(
  raw: string | undefined,
  destination: ClickTargetDestination,
  readInterfaces: NetworkInterfaceReader = osNetworkInterfaces,
  /**
   * The address the control plane is BOUND to (`controlPlane.host`, or the
   * wildcard when `controlPlane.hostMode` is 'network'). Omitted, the URL's own
   * host states the intent: a wildcard URL is network intent, loopback is local.
   */
  bindHost?: string | undefined,
): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const wildcard = isWildcardHost(url.hostname);
  const derived = wildcard || isLoopbackHost(url.hostname);
  if (!derived) return url.toString().replace(/\/+$/, '');
  const mode = bindHost === undefined
    ? (wildcard ? 'network' : 'local')
    : resolveClickTargetMode(bindHost);
  const host = resolveClickTargetHost(mode, destination, readInterfaces);
  if (!host) return null;
  url.hostname = host;
  return url.toString().replace(/\/+$/, '');
}

export interface ReachableBaseUrlReader {
  get(key: string): unknown;
}

export function resolveReachableBaseUrl(
  reader: ReachableBaseUrlReader,
  destination: ClickTargetDestination,
  readInterfaces: NetworkInterfaceReader = osNetworkInterfaces,
): string | undefined {
  // The control-plane candidate is DERIVED from the bind, never read from a
  // stored mirror: an explicitly declared external address wins when present,
  // and otherwise the URL is computed from hostMode/host/port/tls.mode so it
  // cannot disagree with where the daemon actually listens.
  const controlPlane = deriveControlPlaneBaseUrl(
    readControlPlaneBinding((key) => reader.get(key)),
    'external',
  );
  const candidates = [controlPlane, reader.get('web.publicBaseUrl')];
  // `controlPlane.hostMode: 'network'` binds the wildcard without necessarily
  // rewriting `controlPlane.host`, so the mode counts as an off-host bind too.
  const configuredHost = reader.get('controlPlane.host');
  const hostMode = reader.get('controlPlane.hostMode');
  const bindHost = hostMode === 'network'
    ? WILDCARD_BIND_HOST
    : typeof configuredHost === 'string' ? configuredHost : undefined;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = normalizeReachableBaseUrl(candidate, destination, readInterfaces, bindHost);
    if (normalized) return normalized;
  }
  return undefined;
}
