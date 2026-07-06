/**
 * oauth-flow.ts — the OAuth 2.0 machinery for calendar connectivity: the
 * authorization-code flow with a loopback redirect and mandatory PKCE (the standard
 * native-app pattern, RFC 8252/7636), and the device-code flow (RFC 8628) as the
 * headless fallback. Token exchange, refresh, and revocation live here too.
 *
 * Every network call goes through the injected HttpFetch — this file never imports
 * a real fetch — so the full flow runs against fake servers in tests with no real
 * network and no real port. PKCE hashing/randomness reuse the SDK's runtime-neutral
 * crypto adapter.
 */

import { createSha256Hash, randomBytesBase64url } from '../runtime/auth/crypto-adapter.js';
import type {
  AuthCodeFlowStart,
  DeviceCodeFlowStart,
  FlowFailureReason,
  HttpFetch,
  LoopbackListenerFactory,
  LoopbackWaiter,
  ResolvedClientConfig,
  StoredTokenSet,
} from './oauth-types.js';

/** A typed flow failure carrying the honest reason a caller surfaces to the user. */
export class OAuthFlowError extends Error {
  readonly reason: FlowFailureReason;
  /** The provider status, when the failure came from an HTTP response. */
  readonly status?: number;
  constructor(reason: FlowFailureReason, message: string, status?: number) {
    super(message);
    this.name = 'OAuthFlowError';
    this.reason = reason;
    if (typeof status === 'number') this.status = status;
  }
}

function assertClientConfigured(config: ResolvedClientConfig): void {
  if (config.isPlaceholder) {
    throw new OAuthFlowError(
      'client-not-configured',
      `No ${config.provider} client id is configured. Either this build ships no project default yet, ` +
        'or supply your own client id under advanced settings.',
    );
  }
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

/** Create a PKCE verifier + S256 challenge. */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomBytesBase64url(32);
  const challenge = await createSha256Hash(verifier);
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// Token response parsing
// ---------------------------------------------------------------------------

interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

/**
 * A conservative fallback lifetime (seconds) used when a provider's token response
 * omits `expires_in` or sends something we cannot parse as a positive number. Never
 * treat that as "never expires" — an access token that silently 401s later, with no
 * expiry recorded to trigger a proactive refresh, is worse than refreshing a bit
 * early. One hour matches the common real-world default (Google/Microsoft both
 * normally send 3600).
 */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

/**
 * Coerce a token response's `expires_in` into a positive number of seconds.
 * Accepts a real number, a numeric string (some providers send `"3600"` instead of
 * `3600`), and falls back to {@link DEFAULT_EXPIRES_IN_SECONDS} for anything else
 * (absent, non-numeric, zero, or negative) — this build never emits a token set with
 * no expiry at all, which the store would otherwise read as "connected forever".
 */
function coerceExpiresInSeconds(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_EXPIRES_IN_SECONDS;
}

/** Turn a provider token response into a StoredTokenSet, keeping a prior refresh
 *  token when the response omits one (Google omits it on refresh). */
export function parseTokenResponse(
  raw: unknown,
  now: number,
  priorRefreshToken?: string,
): StoredTokenSet {
  const json = (raw ?? {}) as RawTokenResponse;
  if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new OAuthFlowError('token-request-rejected', 'Token response did not include an access token.');
  }
  const refreshToken = typeof json.refresh_token === 'string' && json.refresh_token.length > 0
    ? json.refresh_token
    : priorRefreshToken;
  const scopes = typeof json.scope === 'string' && json.scope.trim().length > 0
    ? json.scope.trim().split(/\s+/)
    : undefined;
  return {
    accessToken: json.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    tokenType: typeof json.token_type === 'string' && json.token_type.length > 0 ? json.token_type : 'Bearer',
    // Always set expiresAt — never omit it just because expires_in was absent or
    // unparsable — a coerced/defaulted lifetime beats "never expires".
    expiresAt: now + coerceExpiresInSeconds(json.expires_in) * 1000,
    ...(scopes ? { scopes } : {}),
    obtainedAt: now,
  };
}

function formBody(payload: Record<string, string>): string {
  return new URLSearchParams(payload).toString();
}

async function readError(res: { status: number; text(): Promise<string> }): Promise<string> {
  const body = await res.text().catch(() => '');
  return body.length > 0 ? `${res.status}: ${body}` : `HTTP ${res.status}`;
}

// ---------------------------------------------------------------------------
// Authorization-code flow
// ---------------------------------------------------------------------------

/**
 * Begin the authorization-code flow: bind a loopback listener, build the PKCE
 * authorization URL, and return both. The caller opens the URL in a browser and
 * awaits waiter.waitForCode(), then calls completeAuthCodeFlow.
 */
export async function beginAuthCodeFlow(
  config: ResolvedClientConfig,
  listenerFactory: LoopbackListenerFactory,
): Promise<{ readonly start: AuthCodeFlowStart; readonly waiter: LoopbackWaiter }> {
  assertClientConfigured(config);
  const state = randomBytesBase64url(24);
  const { verifier, challenge } = await createPkcePair();
  const waiter = await listenerFactory({
    expectedState: state,
    ...(config.redirectHost ? { host: config.redirectHost } : {}),
    ...(typeof config.redirectPort === 'number' ? { port: config.redirectPort } : {}),
  });
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', waiter.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  for (const [key, value] of Object.entries(config.extraAuthParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return {
    start: { authorizationUrl: url.toString(), state, verifier, redirectUri: waiter.redirectUri },
    waiter,
  };
}

/** Exchange an authorization code for tokens (PKCE). */
export async function completeAuthCodeFlow(
  config: ResolvedClientConfig,
  fetchImpl: HttpFetch,
  input: { readonly code: string; readonly verifier: string; readonly redirectUri: string },
  now: number,
): Promise<StoredTokenSet> {
  const payload: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  };
  if (config.clientSecret) payload.client_secret = config.clientSecret;
  let res;
  try {
    res = await fetchImpl({
      url: config.tokenEndpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: formBody(payload),
    });
  } catch (error) {
    throw new OAuthFlowError('network-error', `Reaching the token endpoint failed: ${describe(error)}`);
  }
  if (!res.ok) {
    throw new OAuthFlowError('token-request-rejected', `Token exchange failed (${await readError(res)}).`, res.status);
  }
  return parseTokenResponse(await res.json(), now);
}

// ---------------------------------------------------------------------------
// Device-code flow (RFC 8628)
// ---------------------------------------------------------------------------

/** Begin the device-code flow: request a device + user code to display. */
export async function beginDeviceCodeFlow(
  config: ResolvedClientConfig,
  fetchImpl: HttpFetch,
  now: number,
): Promise<DeviceCodeFlowStart> {
  assertClientConfigured(config);
  let res;
  try {
    res = await fetchImpl({
      url: config.deviceAuthorizationEndpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: formBody({ client_id: config.clientId, scope: config.scopes.join(' ') }),
    });
  } catch (error) {
    throw new OAuthFlowError('network-error', `Reaching the device endpoint failed: ${describe(error)}`);
  }
  if (!res.ok) {
    throw new OAuthFlowError('token-request-rejected', `Device authorization failed (${await readError(res)}).`, res.status);
  }
  const json = (await res.json()) as {
    device_code?: unknown;
    user_code?: unknown;
    verification_uri?: unknown;
    verification_url?: unknown;
    verification_uri_complete?: unknown;
    expires_in?: unknown;
    interval?: unknown;
  };
  const deviceCode = requireString(json.device_code, 'device_code');
  const userCode = requireString(json.user_code, 'user_code');
  // Google returns verification_url; the RFC and Microsoft use verification_uri.
  const verificationUri = typeof json.verification_uri === 'string'
    ? json.verification_uri
    : requireString(json.verification_url, 'verification_uri');
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 900;
  const interval = typeof json.interval === 'number' ? json.interval : 5;
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof json.verification_uri_complete === 'string'
      ? { verificationUriComplete: json.verification_uri_complete }
      : {}),
    expiresAt: now + expiresIn * 1000,
    intervalMs: interval * 1000,
  };
}

/** Injected delay so device-code polling is deterministic in tests. */
export type Sleep = (ms: number) => Promise<void>;

/**
 * Poll the token endpoint until the user approves the device code, the code expires,
 * or the request is denied. Honors authorization_pending (keep polling) and slow_down
 * (widen the interval) per RFC 8628.
 */
export async function pollDeviceCodeFlow(
  config: ResolvedClientConfig,
  fetchImpl: HttpFetch,
  start: DeviceCodeFlowStart,
  clock: () => number,
  sleep: Sleep,
): Promise<StoredTokenSet> {
  let intervalMs = start.intervalMs;
  for (;;) {
    if (clock() >= start.expiresAt) {
      throw new OAuthFlowError('device-code-expired', 'The device code expired before it was approved.');
    }
    await sleep(intervalMs);
    const payload: Record<string, string> = {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: config.clientId,
      device_code: start.deviceCode,
    };
    if (config.clientSecret) payload.client_secret = config.clientSecret;
    let res;
    try {
      res = await fetchImpl({
        url: config.tokenEndpoint,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: formBody(payload),
      });
    } catch (error) {
      throw new OAuthFlowError('network-error', `Polling the token endpoint failed: ${describe(error)}`);
    }
    if (res.ok) return parseTokenResponse(await res.json(), clock());
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    const err = typeof body.error === 'string' ? body.error : `http_${res.status}`;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') {
      intervalMs += 5000;
      continue;
    }
    if (err === 'expired_token') {
      throw new OAuthFlowError('device-code-expired', 'The device code expired before it was approved.');
    }
    throw new OAuthFlowError('token-request-rejected', `Device authorization was rejected (${err}).`, res.status);
  }
}

// ---------------------------------------------------------------------------
// Refresh + revoke
// ---------------------------------------------------------------------------

/** Exchange a refresh token for a fresh access token. */
export async function refreshAccessToken(
  config: ResolvedClientConfig,
  fetchImpl: HttpFetch,
  refreshToken: string,
  now: number,
): Promise<StoredTokenSet> {
  const payload: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: refreshToken,
  };
  if (config.clientSecret) payload.client_secret = config.clientSecret;
  let res;
  try {
    res = await fetchImpl({
      url: config.tokenEndpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: formBody(payload),
    });
  } catch (error) {
    throw new OAuthFlowError('network-error', `Reaching the token endpoint failed: ${describe(error)}`);
  }
  if (!res.ok) {
    throw new OAuthFlowError('token-request-rejected', `Token refresh failed (${await readError(res)}).`, res.status);
  }
  // Preserve the prior refresh token when the provider omits a new one.
  return parseTokenResponse(await res.json(), now, refreshToken);
}

/**
 * Revoke a token at the provider (Google). Returns true when the provider confirms.
 * When the provider has no revocation endpoint (Microsoft), returns false so the
 * caller knows disconnect is local-only.
 */
export async function revokeToken(
  config: ResolvedClientConfig,
  fetchImpl: HttpFetch,
  token: string,
): Promise<boolean> {
  if (!config.revocationEndpoint) return false;
  try {
    const res = await fetchImpl({
      url: config.revocationEndpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ token }),
    });
    return res.ok;
  } catch {
    // A revocation network failure must not block a local disconnect.
    return false;
  }
}

// ---------------------------------------------------------------------------

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OAuthFlowError('token-request-rejected', `Provider response missing ${field}.`);
  }
  return value;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
