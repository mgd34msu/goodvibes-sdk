/**
 * pairing/origin-posture.ts
 *
 * The honest TLS/capability posture of a web origin, served over the pairing
 * contract so every surface renders the SAME truth instead of dead buttons:
 *
 *  - Plain http on a PRIVATE-NETWORK origin (LAN IP, .local, localhost) is a
 *    deliberate, supported posture. The one honest line about it is stated at
 *    pairing — never a nag.
 *  - Browsers gate some capabilities on a secure context (https, or the
 *    localhost loopback). Rather than a surface showing a dead button, the
 *    daemon labels each gated capability with WHY it is unavailable and the
 *    supported way to get it (tailscale ⇒ https without minting certificates —
 *    the daemon NEVER provisions a CA or mints certificates).
 */
import { isPrivateNetworkHost } from '@pellux/goodvibes-transport-http';

/** The browser-gated capabilities a surface renders availability for. */
export type BrowserGatedCapability = 'service-worker' | 'push' | 'microphone';

export const BROWSER_GATED_CAPABILITIES: readonly BrowserGatedCapability[] = [
  'service-worker',
  'push',
  'microphone',
];

export interface OriginCapability {
  readonly capability: BrowserGatedCapability;
  readonly available: boolean;
  /** Present when unavailable: the label a surface renders instead of a dead button. */
  readonly reason?: string | undefined;
}

export interface OriginPosture {
  /** The origin the posture describes (scheme://host[:port]). */
  readonly origin: string;
  readonly scheme: 'http' | 'https' | 'other';
  /** Loopback / RFC 1918 / .local — the supported plain-http LAN posture. */
  readonly privateNetwork: boolean;
  /** Whether browsers treat this origin as a secure context (https, or loopback). */
  readonly secureContext: boolean;
  /**
   * The ONE honest posture line, stated at pairing (never a nag): present only
   * for the plain-http-on-LAN posture; absent when the origin is already a
   * secure context.
   */
  readonly notice?: string | undefined;
  readonly capabilities: readonly OriginCapability[];
}

/** The single honest plain-http-on-LAN line every surface renders verbatim. */
export const LAN_PLAIN_HTTP_NOTICE =
  'Connection is unencrypted on your LAN. Everything works except browser-gated features; Tailscale gives encrypted access with the full app.';

const NEEDS_HTTPS_REASON = 'needs https — available via tailscale';

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.') || host.endsWith('.localhost');
}

/**
 * Describe the TLS/capability posture of a web origin. Invalid origins are
 * reported honestly as scheme 'other' with every capability unavailable —
 * never a throw (this feeds a render path, not a validation gate).
 */
export function describeOriginPosture(origin: string): OriginPosture {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return {
      origin,
      scheme: 'other',
      privateNetwork: false,
      secureContext: false,
      capabilities: BROWSER_GATED_CAPABILITIES.map((capability) => ({
        capability,
        available: false,
        reason: 'origin is not a valid URL',
      })),
    };
  }
  const scheme: OriginPosture['scheme'] = parsed.protocol === 'https:' ? 'https' : parsed.protocol === 'http:' ? 'http' : 'other';
  const privateNetwork = isPrivateNetworkHost(parsed.hostname);
  // Browsers treat https everywhere and http on the loopback as secure contexts;
  // http on a LAN IP or a .local name is NOT one (that is exactly the labeled gap).
  const secureContext = scheme === 'https' || (scheme === 'http' && isLoopbackHost(parsed.hostname));
  const capabilities: OriginCapability[] = BROWSER_GATED_CAPABILITIES.map((capability) => (
    secureContext
      ? { capability, available: true }
      : { capability, available: false, reason: NEEDS_HTTPS_REASON }
  ));
  const plainHttpLan = scheme === 'http' && privateNetwork && !secureContext;
  return {
    origin: parsed.origin,
    scheme,
    privateNetwork,
    secureContext,
    ...(plainHttpLan ? { notice: LAN_PLAIN_HTTP_NOTICE } : {}),
    capabilities,
  };
}
