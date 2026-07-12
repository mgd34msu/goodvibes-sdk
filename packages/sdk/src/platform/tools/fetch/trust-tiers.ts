/**
 * Host trust tier classification.
 *
 * Classifies outbound HTTP request targets into one of four tiers before
 * the request is sent. Blocked hosts are denied pre-request with an
 * `SSRF_DENY` telemetry event — absolutely, regardless of configuration.
 * Localhost/loopback targets (dev servers) are their own tier: they ask once
 * and can be allowed per project (fetch.allowLocalhost). Unknown hosts
 * receive `safe-text` sanitization. Trusted hosts may opt into `none`
 * sanitization via config.
 *
 * Trust tiers:
 *   - `trusted`   — Host is explicitly allowlisted. Sanitization may be relaxed.
 *   - `unknown`   — Host is not in any list; apply `safe-text` sanitization.
 *   - `localhost` — Loopback/dev-server target; requires the per-project
 *                   approval (fetch.allowLocalhost) before the request is sent.
 *   - `blocked`   — Host matches an internal address, metadata endpoint, or
 *                   explicit blocklist entry. Request is denied pre-flight.
 *
 * SSRF protections detect (always blocked):
 *   - Private IPv4 ranges (RFC 1918) and link-local metadata (169.254.x.x)
 *   - IPv6 link-local and unique-local ranges
 *   - Cloud metadata endpoints (metadata.google.internal, etc.)
 *   - DNS rebinding patterns (encoded or obfuscated IP addresses)
 */

import { logger } from '../../utils/logger.js';
import { hostMatchesGlob } from './host-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Trust classification for an outbound request host.
 *
 * - `trusted`   — Explicitly allowlisted; sanitization may be relaxed.
 * - `unknown`   — Not in any list; standard `safe-text` sanitization applied.
 * - `localhost` — Loopback dev-server target; needs the per-project approval.
 * - `blocked`   — Sensitive host; request denied pre-request, absolutely.
 */
export type HostTrustTier = 'trusted' | 'unknown' | 'localhost' | 'blocked';

/**
 * Result of classifying a host's trust tier.
 */
export interface TrustTierResult {
  /** The classified trust tier. */
  tier: HostTrustTier;
  /** Human-readable reason for the classification. */
  reason: string;
  /** True when the host matched an SSRF pattern specifically. */
  isSsrf: boolean;
}

/**
 * Configuration for host trust tier classification.
 */
export interface TrustTierConfig {
  /**
   * Hostnames or glob patterns that are explicitly trusted.
   * Trusted hosts may opt out of sanitization via fetch config.
   * Example: `['api.anthropic.com', '*.internal.example.com']`
   */
  trustedHosts?: string[] | undefined;
  /**
   * Hostnames or glob patterns that are explicitly blocked.
   * Blocked hosts are denied pre-request regardless of other config.
   */
  blockedHosts?: string[] | undefined;
}

// ---------------------------------------------------------------------------
// SSRF detection patterns
// ---------------------------------------------------------------------------

/** IPv4 private/loopback ranges per RFC 1918, RFC 5735. */
const PRIVATE_IPV4_PATTERNS: RegExp[] = [
  // 127.0.0.0/8 — loopback
  /^127\./,
  // 10.0.0.0/8
  /^10\./,
  // 172.16.0.0/12
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  // 192.168.0.0/16
  /^192\.168\./,
  // 169.254.0.0/16 — link-local / AWS/GCP metadata
  /^169\.254\./,
  // 0.0.0.0 — unspecified
  /^0\.0\.0\.0$/,
];

/** IPv6 loopback, link-local, and private prefixes. */
const PRIVATE_IPV6_PATTERNS: RegExp[] = [
  // ::1 — loopback
  /^::1$/i,
  // fe80::/10 — link-local
  /^fe[89ab][0-9a-f]:/i,
  // fc00::/7 — unique local (fc00:: and fd00::)
  /^f[cd][0-9a-f]{2}:/i,
];

/** Cloud metadata endpoints. */
const METADATA_HOSTS: ReadonlySet<string> = new Set([
  // AWS EC2 Instance Metadata Service
  'metadata.aws.internal',
  // GCP metadata server (hostname)
  'metadata.google.internal',
  // Azure IMDS hostname
  'metadata.azure.internal',
  // Alibaba Cloud ECS metadata
  'metadata.aliyuncs.internal',
]);

/** Known localhost aliases. */
const LOCALHOST_ALIASES: ReadonlySet<string> = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

/**
 * Regex patterns for detecting encoded/obfuscated IP representations
 * used in DNS rebinding / SSRF bypass attempts.
 * Hex and octal variants are straightforward; decimal integers require
 * value-aware decoding via `isPrivateDecimalIp()`.
 */
const ENCODED_IP_HEX_OCTAL_PATTERNS: RegExp[] = [
  // Hex-encoded IPv4: 0xC0A80001 style
  /^0x[0-9a-f]{1,8}$/i,
  // Octal-encoded IPv4 segments: 0177.0.0.1 style
  /^0[0-7]+\./,
];

/**
 * Returns true if the host is a decimal integer representation of a
 * private/loopback IPv4 address (e.g. 2130706433 = 127.0.0.1).
 *
 * Only block decimal integers that decode to private addresses; ordinary
 * numeric hostnames remain subject to the rest of the trust-tier checks.
 */
function isPrivateDecimalIp(host: string): boolean {
  if (!/^\d{1,10}$/.test(host)) return false;
  const num = parseInt(host, 10);
  if (num > 0xFFFFFFFF) return false;
  const a = (num >>> 24) & 0xFF;
  const b = (num >>> 16) & 0xFF;
  // Private ranges: 10.x.x.x, 172.16-31.x.x, 192.168.x.x, 127.x.x.x
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the host is a private/loopback IPv4 address.
 */
function isPrivateIpv4(host: string): boolean {
  return PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(host));
}

/**
 * Returns true if the host is an IPv6 loopback or private address.
 */
function isPrivateIpv6(host: string): boolean {
  // Strip brackets from bracketed IPv6: [::1] -> ::1
  const normalized = host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1)
    : host;
  return PRIVATE_IPV6_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Returns true if the host uses an encoded/obfuscated IP representation
 * commonly used to bypass naive SSRF filters.
 */
function isEncodedIp(host: string): boolean {
  return ENCODED_IP_HEX_OCTAL_PATTERNS.some((pattern) => pattern.test(host))
    || isPrivateDecimalIp(host);
}

/**
 * Returns true if the host matches a cloud metadata endpoint.
 */
function isMetadataHost(host: string): boolean {
  // Exact match
  if (METADATA_HOSTS.has(host.toLowerCase())) return true;
  // 169.254.x.x is the link-local metadata IP (AWS/GCP use 169.254.169.254)
  return /^169\.254\./.test(host);
}

/**
 * Returns true if the host is a localhost alias.
 */
function isLocalhostAlias(host: string): boolean {
  return LOCALHOST_ALIASES.has(host.toLowerCase());
}

/**
 * Returns true if the host is a plainly-written loopback target — a localhost
 * alias, a 127.0.0.0/8 IPv4 address, or IPv6 ::1. Encoded/obfuscated loopback
 * forms (hex, octal, decimal-int) deliberately do NOT count: writing
 * 0x7f000001 instead of localhost is a filter-bypass signal and stays blocked.
 */
function isPlainLoopbackHost(host: string): boolean {
  if (isLocalhostAlias(host)) return true;
  if (/^127\./.test(host)) return true;
  const normalized = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return /^::1$/i.test(normalized);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Telemetry event names emitted by the trust tier classifier.
 * These are the canonical runtime contract strings for host trust classification.
 */
export const TRUST_TIER_EVENTS = {
  /** Emitted when a host trust tier has been classified (all tiers). */
  HOST_TRUST_TIER: 'HOST_TRUST_TIER',
  /** Emitted when a request is denied due to SSRF detection. */
  SSRF_DENY: 'SSRF_DENY',
} as const;

/**
 * Classify the trust tier of an outbound request host.
 *
 * Classification order (first match wins):
 *   1. Explicit blocklist → `blocked`
 *   2. Plain loopback targets (localhost, 127.x, ::1) → `localhost`
 *   3. SSRF patterns (private IPs, metadata endpoints) → `blocked`
 *   4. Encoded IP bypass attempts (including encoded loopback) → `blocked`
 *   5. Explicit trustlist → `trusted`
 *   6. Default → `unknown`
 *
 * @param host   - Hostname or IP to classify (without port).
 * @param config - Trust tier configuration with optional allow/deny lists.
 * @returns      `TrustTierResult` with tier, reason, and SSRF flag.
 */
export function classifyHostTrustTier(
  host: string,
  config: TrustTierConfig = {},
): TrustTierResult {
  const normalizedHost = host.toLowerCase().trim();

  // 1. Explicit blocklist
  const blockedEntry = (config.blockedHosts ?? []).find((pattern) =>
    hostMatchesGlob(normalizedHost, pattern),
  );
  if (blockedEntry !== undefined) {
    return {
      tier: 'blocked',
      reason: `host "${host}" matched explicit blocklist pattern "${blockedEntry}"`,
      isSsrf: false,
    };
  }

  // 2. Plain loopback dev-server targets — their own tier, gated by the
  // per-project approval rather than blocked outright.
  if (isPlainLoopbackHost(normalizedHost)) {
    return {
      tier: 'localhost',
      reason: `host "${host}" is a loopback address — needs the per-project localhost approval (fetch.allowLocalhost)`,
      isSsrf: false,
    };
  }

  // 3. SSRF — cloud metadata endpoints (checked before the generic private
  // ranges so 169.254.169.254 reports the specific metadata reason).
  if (isMetadataHost(normalizedHost)) {
    return {
      tier: 'blocked',
      reason: `host "${host}" is a cloud metadata endpoint — SSRF risk`,
      isSsrf: true,
    };
  }

  // 4. SSRF — private IPv4
  if (isPrivateIpv4(normalizedHost)) {
    return {
      tier: 'blocked',
      reason: `host "${host}" is a private IPv4 address — SSRF risk`,
      isSsrf: true,
    };
  }

  // 5. SSRF — private IPv6
  if (isPrivateIpv6(normalizedHost)) {
    return {
      tier: 'blocked',
      reason: `host "${host}" is a private IPv6 address — SSRF risk`,
      isSsrf: true,
    };
  }

  // 6. SSRF — encoded/obfuscated IP bypass
  if (isEncodedIp(normalizedHost)) {
    return {
      tier: 'blocked',
      reason: `host "${host}" uses encoded IP representation — DNS rebinding / SSRF bypass risk`,
      isSsrf: true,
    };
  }

  // 7. Explicit trustlist
  const trustedEntry = (config.trustedHosts ?? []).find((pattern) =>
    hostMatchesGlob(normalizedHost, pattern),
  );
  if (trustedEntry !== undefined) {
    return {
      tier: 'trusted',
      reason: `host "${host}" matched trusted host pattern "${trustedEntry}"`,
      isSsrf: false,
    };
  }

  // 8. Default — unknown
  return {
    tier: 'unknown',
    reason: `host "${host}" is not in any trust list`,
    isSsrf: false,
  };
}

/**
 * Emit SSRF deny telemetry to the logger as a structured event.
 *
 * Emits a log entry with event name `SSRF_DENY` that can be consumed by
 * the telemetry pipeline. This fulfils the runtime contract for the
 * `SSRF_DENY` telemetry event in fetch sanitization.
 *
 * @param host     - The host that was denied.
 * @param url      - The full URL that was attempted.
 * @param reason   - Human-readable reason for the denial.
 */
export function emitSsrfDeny(host: string, url: string, reason: string): void {
  logger.warn('SSRF_DENY', {
    event: TRUST_TIER_EVENTS.SSRF_DENY,
    host,
    url,
    reason,
    timestamp: Date.now(),
  });
}

/**
 * Emit host trust tier telemetry to the logger as a structured event.
 *
 * Emits a log entry with event name `HOST_TRUST_TIER` that can be consumed
 * by the telemetry pipeline. This fulfils the runtime contract for the
 * `HOST_TRUST_TIER` telemetry event in fetch sanitization.
 *
 * @param host   - The classified host.
 * @param url    - The full URL being fetched.
 * @param result - The trust tier classification result.
 */
export function emitHostTrustTier(
  host: string,
  url: string,
  result: TrustTierResult,
): void {
  logger.debug('HOST_TRUST_TIER', {
    event: TRUST_TIER_EVENTS.HOST_TRUST_TIER,
    host,
    url,
    tier: result.tier,
    reason: result.reason,
    isSsrf: result.isSsrf,
    timestamp: Date.now(),
  });
}

/**
 * Extract the hostname from a URL string for trust tier classification.
 *
 * Returns `null` if the URL cannot be parsed.
 *
 * @param url - Full URL string (e.g. `https://example.com/path`).
 * @returns   Hostname string (without port), or `null` on parse failure.
 */
export function extractHostname(url: string): string | null {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.hostname;
  } catch {
    return null;
  }
}
