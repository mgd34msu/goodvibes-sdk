/**
 * web-origin.ts, the web-app origin a pairing deep link points at, and the
 * one-time write of `web.publicBaseUrl` from the stable-name resolution.
 *
 * The origin is the WEB endpoint's public URL (the surface a `#pair=<token>`
 * link opens), not the control-plane daemon URL. A user-set `web.publicBaseUrl`
 * is authoritative and is never re-derived or clobbered; only when it is empty
 * does this fall back to `http://<stable-host>:<web-port>` using the same ladder
 * (stable-host.ts) the printed/QR link uses, so the link and the persisted
 * origin always agree.
 *
 * The web endpoint's host is resolved from the three stored `web.*` keys and its
 * port through {@link resolveWebPort}, which is what actually binds the
 * listener, so a printed origin can never name a port the daemon is not on.
 */
import type { ConfigManager } from '../config/manager.js';
import { resolveWebPort } from '../daemon/host-resolver.js';
import { stableUrlHostForBindHost, type ResolvedStableHost, type StableHostInputs } from './stable-host.js';

export interface PairingWebOrigin {
  readonly origin: string;
  readonly resolvedHost: ResolvedStableHost;
  /** True when the origin is http:// on a non-loopback host, the honest LAN-posture case. */
  readonly httpOnLan: boolean;
  /** True when the origin came verbatim from a user-set web.publicBaseUrl. */
  readonly fromPublicBaseUrl: boolean;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** http:// on anything other than loopback is served in the clear on the LAN. */
export function isHttpOnLan(origin: string): boolean {
  if (!origin.startsWith('http://')) return false;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
}

/**
 * The bind host the web endpoint is configured for, from `web.hostMode` and
 * `web.host`. A wildcard bind ('network') is what sends the caller through the
 * stable-name ladder; every other mode names its own host, and an unrecognized
 * mode falls back to loopback rather than guessing something routable.
 */
function webBindHost(config: Pick<ConfigManager, 'get'>): string {
  const hostMode = String(config.get('web.hostMode') ?? 'local');
  const configuredHost = String(config.get('web.host') ?? '127.0.0.1');
  if (hostMode === 'network') return '0.0.0.0';
  if (hostMode === 'custom') return configuredHost || '127.0.0.1';
  return '127.0.0.1';
}

export function resolvePairingWebOrigin(
  configManager: Pick<ConfigManager, 'get'>,
  probe?: () => StableHostInputs,
): PairingWebOrigin {
  const publicBaseUrl = trimTrailingSlash(String(configManager.get('web.publicBaseUrl') ?? '').trim());
  if (publicBaseUrl) {
    return {
      origin: publicBaseUrl,
      resolvedHost: { host: hostnameOf(publicBaseUrl), kind: 'gateway-interface', stable: true },
      httpOnLan: isHttpOnLan(publicBaseUrl),
      fromPublicBaseUrl: true,
    };
  }
  const port = resolveWebPort(configManager.get('web.port'));
  const resolvedHost = stableUrlHostForBindHost(webBindHost(configManager), probe);
  const origin = `http://${resolvedHost.host}:${port}`;
  return { origin, resolvedHost, httpOnLan: isHttpOnLan(origin), fromPublicBaseUrl: false };
}

function hostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

/**
 * Persist web.publicBaseUrl once, from the stable-name resolution, and only when
 * it is empty AND the resolution produced a stable name (a DHCP-bound address is
 * not worth freezing into config). Returns the resolved origin either way. Never
 * overwrites a user-set value.
 */
export function ensurePublicBaseUrl(
  configManager: Pick<ConfigManager, 'get' | 'setDynamic'>,
  probe?: () => StableHostInputs,
): PairingWebOrigin {
  const resolved = resolvePairingWebOrigin(configManager, probe);
  if (!resolved.fromPublicBaseUrl && resolved.resolvedHost.stable) {
    configManager.setDynamic('web.publicBaseUrl', resolved.origin);
    return { ...resolved, fromPublicBaseUrl: true };
  }
  return resolved;
}
