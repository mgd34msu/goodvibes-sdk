/**
 * platform-calendar-oauth.test.ts
 *
 * Authenticated calendar provider connectivity (Google
 * Calendar API v3 + Microsoft Graph over OAuth 2.0). The ENTIRE flow is proven
 * against in-memory fake servers behind the connector's injected HttpFetch — there
 * is NO real network, no real port, and no real keychain anywhere in this file.
 *
 * Covered:
 *  - authorization-code + PKCE: the fake token endpoint verifies the code_verifier
 *    hashes (S256) to the challenge that beginAuthCodeFlow put in the authorize URL;
 *    a wrong verifier is rejected.
 *  - device-code (RFC 8628): authorization_pending -> slow_down -> success, with a
 *    fake clock + fake sleep; expiry is honest.
 *  - bundled-default vs user-override client resolution; placeholder -> a flow
 *    refuses with client-not-configured (never a fake success).
 *  - token refresh on expiry; a refresh FAILURE flips the durable state to
 *    reconnect-needed and refuses to hand back a stale token.
 *  - revoke/disconnect: Google revocation endpoint hit + keys cleared; Microsoft
 *    (no revocation endpoint) clears keys locally and reports revokedRemotely:false.
 *  - Google + Graph list-calendars, paginated list-events, and create-event, all
 *    normalized + source-labeled into the merged model.
 *  - honest degraded states: 403 names the missing scope; 429 carries Retry-After;
 *    401 -> reconnect-needed.
 *  - tokens live only in the secret store, never echoed into account/state.
 */
import { describe, expect, test } from 'bun:test';
import { createSha256Hash } from '../packages/sdk/src/platform/runtime/auth/crypto-adapter.ts';
import {
  CalendarApiError,
  CalendarConnector,
  CalendarTokenStore,
  OAuthFlowError,
  TokenRefreshError,
  parseTokenResponse,
  providerProfile,
  resolveClientConfig,
  type HttpFetch,
  type HttpRequest,
  type HttpResponse,
  type LoopbackListenerFactory,
  type ResolvedClientConfig,
  type SecretStoreSlice,
} from '../packages/sdk/src/platform/calendar/index.ts';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeSecrets(): SecretStoreSlice & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    ok: status >= 200 && status < 300,
    header: (name) => lower[name.toLowerCase()] ?? null,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

interface ServerState {
  /** code -> the PKCE challenge captured from the authorize URL. */
  readonly pkceByCode: Map<string, string>;
  /** valid refresh tokens; refreshing an absent one 400s. */
  readonly refreshTokens: Set<string>;
  /** device_code -> polls remaining before it flips to approved. */
  readonly devicePollsLeft: Map<string, number>;
  readonly revoked: Set<string>;
  nextAccess: number;
  /** toggles for degraded-state tests. */
  eventsStatus: number; // 200 normal, 401/403/429 to force a degraded state
  /** account email surfaced by the primary calendar. */
  googleEmail: string;
}

function freshState(): ServerState {
  return {
    pkceByCode: new Map(),
    refreshTokens: new Set(),
    devicePollsLeft: new Map(),
    revoked: new Set(),
    nextAccess: 1,
    eventsStatus: 200,
    googleEmail: 'user@gmail.com',
  };
}

function form(body: string | undefined): URLSearchParams {
  return new URLSearchParams(body ?? '');
}

/**
 * One fake fetch that stands in for Google's OAuth + Calendar API and Microsoft's
 * OAuth + Graph API, routing by the real provider URLs the connector calls.
 */
function makeFakeFetch(state: ServerState): HttpFetch {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(req.url);
    const path = url.pathname;

    // --- OAuth token endpoints (Google + Microsoft) ---
    if (path === '/token' || path === '/common/oauth2/v2.0/token' || path.endsWith('/oauth2/v2.0/token')) {
      const body = form(req.body);
      const grant = body.get('grant_type');
      if (grant === 'authorization_code') {
        const code = body.get('code') ?? '';
        const verifier = body.get('code_verifier') ?? '';
        const expected = state.pkceByCode.get(code);
        if (!expected) return jsonResponse(400, { error: 'invalid_grant' });
        const actual = await createSha256Hash(verifier);
        if (actual !== expected) return jsonResponse(400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
        const refresh = `refresh-${state.nextAccess}`;
        state.refreshTokens.add(refresh);
        return jsonResponse(200, {
          access_token: `access-${state.nextAccess++}`,
          refresh_token: refresh,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: body.get('scope') ?? 'calendar',
        });
      }
      if (grant === 'refresh_token') {
        const rt = body.get('refresh_token') ?? '';
        if (!state.refreshTokens.has(rt)) return jsonResponse(400, { error: 'invalid_grant' });
        return jsonResponse(200, { access_token: `access-${state.nextAccess++}`, token_type: 'Bearer', expires_in: 3600 });
      }
      if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
        const dc = body.get('device_code') ?? '';
        const left = state.devicePollsLeft.get(dc) ?? 0;
        if (left > 1) {
          state.devicePollsLeft.set(dc, left - 1);
          return jsonResponse(400, { error: 'authorization_pending' });
        }
        if (left === 1) {
          state.devicePollsLeft.set(dc, 0);
          return jsonResponse(400, { error: 'slow_down' });
        }
        const refresh = `refresh-${state.nextAccess}`;
        state.refreshTokens.add(refresh);
        return jsonResponse(200, {
          access_token: `access-${state.nextAccess++}`,
          refresh_token: refresh,
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      return jsonResponse(400, { error: 'unsupported_grant_type' });
    }

    // --- Device authorization endpoints ---
    if (path.endsWith('/device/code') || path.endsWith('/devicecode')) {
      const dc = `device-${state.nextAccess}`;
      state.devicePollsLeft.set(dc, 2); // pending, then slow_down, then success
      return jsonResponse(200, {
        device_code: dc,
        user_code: 'WXYZ-1234',
        verification_uri: 'https://example.test/device',
        verification_uri_complete: 'https://example.test/device?code=WXYZ-1234',
        expires_in: 900,
        interval: 5,
      });
    }

    // --- Revocation (Google only) ---
    if (path === '/revoke') {
      const token = form(req.body).get('token') ?? '';
      state.revoked.add(token);
      return jsonResponse(200, {});
    }

    // --- Google Calendar API v3 ---
    if (url.host === 'www.googleapis.com') {
      if (path === '/calendar/v3/users/me/calendarList') {
        return jsonResponse(200, {
          items: [
            { id: state.googleEmail, summary: 'Primary', primary: true, accessRole: 'owner' },
            { id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'reader' },
          ],
        });
      }
      if (path.startsWith('/calendar/v3/calendars/') && path.endsWith('/events') && req.method === 'GET') {
        if (state.eventsStatus === 403) {
          return jsonResponse(403, { error: { message: 'insufficient scope: calendar.readonly' } });
        }
        if (state.eventsStatus === 429) {
          return jsonResponse(429, { error: { message: 'rate limit' } }, { 'Retry-After': '30' });
        }
        if (state.eventsStatus === 401) return jsonResponse(401, { error: { message: 'invalid credentials' } });
        const pageToken = url.searchParams.get('pageToken');
        if (!pageToken) {
          return jsonResponse(200, {
            nextPageToken: 'page2',
            items: [
              { id: 'g1', iCalUID: 'g1@google', summary: 'Timed', start: { dateTime: '2026-07-06T09:00:00-07:00' }, end: { dateTime: '2026-07-06T10:00:00-07:00' } },
            ],
          });
        }
        return jsonResponse(200, {
          items: [
            { id: 'g2', summary: 'All day', start: { date: '2026-07-07' }, end: { date: '2026-07-08' } },
            { id: 'g3', status: 'cancelled', start: { date: '2026-07-09' } },
          ],
        });
      }
      if (path.startsWith('/calendar/v3/calendars/') && path.endsWith('/events') && req.method === 'POST') {
        const created = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
        return jsonResponse(200, { id: 'g-created', iCalUID: 'g-created@google', ...created });
      }
    }

    // --- Microsoft Graph ---
    if (url.host === 'graph.microsoft.com') {
      if (path === '/v1.0/me/calendars') {
        return jsonResponse(200, {
          value: [
            { id: 'cal-primary', name: 'Calendar', canEdit: true, isDefaultCalendar: true },
            { id: 'cal-2', name: 'Work', canEdit: false },
          ],
        });
      }
      if (path.includes('/calendarView')) {
        if (state.eventsStatus === 403) return jsonResponse(403, { error: { message: 'Access denied: Calendars.Read' } });
        const skip = url.searchParams.get('$skiptoken');
        if (!skip) {
          return jsonResponse(200, {
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars/cal-primary/calendarView?$skiptoken=p2',
            value: [
              { id: 'm1', iCalUId: 'm1@ms', subject: 'Sync', start: { dateTime: '2026-07-06T15:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-07-06T15:30:00.0000000', timeZone: 'UTC' }, isAllDay: false },
            ],
          });
        }
        return jsonResponse(200, {
          value: [
            { id: 'm2', subject: 'Holiday', start: { dateTime: '2026-07-07T00:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-07-08T00:00:00.0000000', timeZone: 'UTC' }, isAllDay: true },
          ],
        });
      }
      if (path.endsWith('/events') && req.method === 'POST') {
        const created = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
        return jsonResponse(201, { id: 'm-created', iCalUId: 'm-created@ms', ...created });
      }
    }

    return jsonResponse(404, { error: `unhandled ${req.method} ${req.url}` });
  };
}

/** A fake loopback that captures the authorize URL's challenge/state and hands back
 *  a canned code, wiring PKCE end-to-end without a port. */
function makeLoopback(state: ServerState, code = 'auth-code-1'): {
  readonly factory: LoopbackListenerFactory;
  arm(authorizationUrl: string): void;
} {
  let pending: { code: string; state: string } | null = null;
  const factory: LoopbackListenerFactory = async ({ expectedState }) => ({
    redirectUri: 'http://127.0.0.1:52111/callback',
    async waitForCode() {
      if (!pending) throw new Error('loopback not armed');
      return pending;
    },
    close() {},
  });
  return {
    factory,
    arm(authorizationUrl: string) {
      const u = new URL(authorizationUrl);
      const challenge = u.searchParams.get('code_challenge')!;
      const st = u.searchParams.get('state')!;
      state.pkceByCode.set(code, challenge);
      pending = { code, state: st };
    },
  };
}

/** A resolved config for a provider with a REAL (non-placeholder) client id. */
function realConfig(provider: 'google' | 'microsoft'): ResolvedClientConfig {
  return resolveClientConfig(providerProfile(provider), { clientId: `real-${provider}-client-id` });
}

const noSleep = async () => {};

// ---------------------------------------------------------------------------
// Client-config resolution
// ---------------------------------------------------------------------------

describe('client-config resolution', () => {
  test('a placeholder bundled default resolves isPlaceholder and refuses a flow', async () => {
    const config = resolveClientConfig(providerProfile('google'));
    expect(config.usingBundledDefault).toBe(true);
    expect(config.isPlaceholder).toBe(true);

    const connector = new CalendarConnector({ secrets: makeSecrets(), fetchImpl: makeFakeFetch(freshState()), listenerFactory: makeLoopback(freshState()).factory });
    await expect(connector.beginConnectAuthCode(config)).rejects.toMatchObject({ reason: 'client-not-configured' });
  });

  test('a registered project default resolves as bundled but not placeholder', () => {
    const profile = { ...providerProfile('microsoft'), bundledClientId: 'project-registered-id' };
    const config = resolveClientConfig(profile);
    expect(config.usingBundledDefault).toBe(true);
    expect(config.isPlaceholder).toBe(false);
    expect(config.clientId).toBe('project-registered-id');
  });

  test('a user override wins over the bundled default and is not treated as bundled', () => {
    const config = resolveClientConfig(providerProfile('google'), { clientId: 'my-own-id', clientSecret: 's3cret' });
    expect(config.usingBundledDefault).toBe(false);
    expect(config.isPlaceholder).toBe(false);
    expect(config.clientId).toBe('my-own-id');
    expect(config.clientSecret).toBe('s3cret');
  });
});

// ---------------------------------------------------------------------------
// Authorization-code + PKCE
// ---------------------------------------------------------------------------

describe('authorization-code flow with PKCE', () => {
  test('connects Google end to end; tokens land only in the secret store', async () => {
    const state = freshState();
    const secrets = makeSecrets();
    const loopback = makeLoopback(state);
    const connector = new CalendarConnector({ secrets, fetchImpl: makeFakeFetch(state), listenerFactory: loopback.factory });
    const config = realConfig('google');

    const { start, waiter } = await connector.beginConnectAuthCode(config);
    expect(start.authorizationUrl).toContain('code_challenge=');
    expect(start.authorizationUrl).toContain('code_challenge_method=S256');
    expect(start.authorizationUrl).toContain('access_type=offline');
    loopback.arm(start.authorizationUrl);

    const { code } = await waiter.waitForCode();
    const account = await connector.completeConnectAuthCode(config, { code, verifier: start.verifier, redirectUri: start.redirectUri });

    expect(account.provider).toBe('google');
    expect(account.label).toBe('user@gmail.com'); // derived from the primary calendar id
    // the access/refresh tokens live in the secret store, never on the account object
    const stored = JSON.parse(secrets.map.get('GOODVIBES_CALENDAR_GOOGLE_TOKENS')!) as { accessToken: string; refreshToken: string };
    expect(stored.accessToken).toMatch(/^access-/);
    expect(stored.refreshToken).toMatch(/^refresh-/);
    expect(JSON.stringify(account)).not.toContain(stored.accessToken);
    expect(JSON.stringify(account)).not.toContain(stored.refreshToken);
    expect(await connector.connectionState('google')).toBe('connected');
  });

  test('a wrong PKCE verifier is rejected by the token endpoint', async () => {
    const state = freshState();
    const loopback = makeLoopback(state);
    const connector = new CalendarConnector({ secrets: makeSecrets(), fetchImpl: makeFakeFetch(state), listenerFactory: loopback.factory });
    const config = realConfig('google');
    const { start } = await connector.beginConnectAuthCode(config);
    loopback.arm(start.authorizationUrl);
    await expect(
      connector.completeConnectAuthCode(config, { code: 'auth-code-1', verifier: 'not-the-verifier', redirectUri: start.redirectUri }),
    ).rejects.toMatchObject({ reason: 'token-request-rejected' });
  });
});

// ---------------------------------------------------------------------------
// Device-code flow
// ---------------------------------------------------------------------------

describe('device-code flow', () => {
  test('shows a user code, tolerates authorization_pending + slow_down, then connects', async () => {
    const state = freshState();
    const secrets = makeSecrets();
    const connector = new CalendarConnector({ secrets, fetchImpl: makeFakeFetch(state), sleep: noSleep, clock: () => 1_000 });
    const config = realConfig('microsoft');

    const start = await connector.beginConnectDeviceCode(config);
    expect(start.userCode).toBe('WXYZ-1234');
    expect(start.verificationUri).toBe('https://example.test/device');

    const account = await connector.completeConnectDeviceCode(config, start);
    expect(account.provider).toBe('microsoft');
    expect(secrets.map.has('GOODVIBES_CALENDAR_MICROSOFT_TOKENS')).toBe(true);
  });

  test('an expired device code fails honestly', async () => {
    const state = freshState();
    let now = 1_000;
    const connector = new CalendarConnector({ secrets: makeSecrets(), fetchImpl: makeFakeFetch(state), sleep: async () => { now += 10_000_000; }, clock: () => now });
    const config = realConfig('microsoft');
    const start = await connector.beginConnectDeviceCode(config);
    await expect(connector.completeConnectDeviceCode(config, start)).rejects.toMatchObject({ reason: 'device-code-expired' });
  });
});

// ---------------------------------------------------------------------------
// F3: expires_in coercion — never silently "never expires"
// ---------------------------------------------------------------------------

describe('parseTokenResponse: expires_in coercion', () => {
  test('a numeric expires_in sets expiresAt normally', () => {
    const tokens = parseTokenResponse({ access_token: 'a', expires_in: 3600 }, 1_000_000);
    expect(tokens.expiresAt).toBe(1_000_000 + 3_600_000);
  });

  test('a numeric-STRING expires_in ("3600") is coerced, not ignored', () => {
    const tokens = parseTokenResponse({ access_token: 'a', expires_in: '3600' }, 1_000_000);
    expect(tokens.expiresAt).toBe(1_000_000 + 3_600_000);
  });

  test('an absent expires_in gets the conservative default, never "no expiry"', () => {
    const tokens = parseTokenResponse({ access_token: 'a' }, 1_000_000);
    expect(tokens.expiresAt).toBe(1_000_000 + 3_600_000);
  });

  test('a non-numeric expires_in ("soon") gets the conservative default', () => {
    const tokens = parseTokenResponse({ access_token: 'a', expires_in: 'soon' }, 1_000_000);
    expect(tokens.expiresAt).toBe(1_000_000 + 3_600_000);
  });

  test('a zero/negative expires_in gets the conservative default rather than an already-expired or nonsensical token', () => {
    expect(parseTokenResponse({ access_token: 'a', expires_in: 0 }, 1_000_000).expiresAt).toBe(1_000_000 + 3_600_000);
    expect(parseTokenResponse({ access_token: 'a', expires_in: -5 }, 1_000_000).expiresAt).toBe(1_000_000 + 3_600_000);
  });
});

// ---------------------------------------------------------------------------
// Token refresh + honest reconnect-needed
// ---------------------------------------------------------------------------

describe('token refresh lifecycle', () => {
  test('refreshes a due token and keeps serving', async () => {
    const state = freshState();
    const secrets = makeSecrets();
    let now = 10_000;
    const store = new CalendarTokenStore({ secrets, clock: () => now });
    state.refreshTokens.add('rt-1');
    await store.save('google', { accessToken: 'old', refreshToken: 'rt-1', tokenType: 'Bearer', expiresAt: 100_000, obtainedAt: 10_000 }, {
      provider: 'google', accountId: 'google', label: 'user@gmail.com', scopes: [], connectedAt: 10_000,
    });
    expect(await store.connectionState('google')).toBe('connected');
    now = 200_000; // past expiry (beyond the 60s refresh leeway)
    expect(await store.connectionState('google')).toBe('refresh-due');
    const token = await store.getFreshAccessToken('google', realConfig('google'), makeFakeFetch(state));
    expect(token).toMatch(/^access-/);
    expect(await store.connectionState('google')).toBe('connected');
  });

  test('a failed refresh flips to reconnect-needed and refuses a stale token', async () => {
    const state = freshState();
    const secrets = makeSecrets();
    let now = 10_000;
    const store = new CalendarTokenStore({ secrets, clock: () => now });
    // rt-missing is NOT registered on the server, so refresh 400s
    await store.save('google', { accessToken: 'old', refreshToken: 'rt-missing', tokenType: 'Bearer', expiresAt: 20_000, obtainedAt: 10_000 }, {
      provider: 'google', accountId: 'google', label: 'user@gmail.com', scopes: [], connectedAt: 10_000,
    });
    now = 25_000;
    await expect(store.getFreshAccessToken('google', realConfig('google'), makeFakeFetch(state))).rejects.toBeInstanceOf(TokenRefreshError);
    expect(await store.connectionState('google')).toBe('reconnect-needed');
  });

  // F2: Microsoft rotates refresh tokens on every use, so two concurrent
  // getFreshAccessToken calls sharing one stored (soon-to-be-invalidated) refresh
  // token must not both hit the provider — the loser would get invalid_grant on an
  // otherwise perfectly working account.
  test('two concurrent getFreshAccessToken calls single-flight to exactly one refresh request', async () => {
    const state = freshState();
    const secrets = makeSecrets();
    let now = 10_000;
    const store = new CalendarTokenStore({ secrets, clock: () => now });
    state.refreshTokens.add('rt-1');
    await store.save('google', { accessToken: 'old', refreshToken: 'rt-1', tokenType: 'Bearer', expiresAt: 100_000, obtainedAt: 10_000 }, {
      provider: 'google', accountId: 'google', label: 'user@gmail.com', scopes: [], connectedAt: 10_000,
    });
    now = 200_000; // past expiry (beyond the 60s refresh leeway)

    let refreshRequests = 0;
    const base = makeFakeFetch(state);
    const countingFetch: HttpFetch = async (req) => {
      const url = new URL(req.url);
      if (url.pathname === '/token' && form(req.body).get('grant_type') === 'refresh_token') refreshRequests++;
      return base(req);
    };

    const [a, b] = await Promise.all([
      store.getFreshAccessToken('google', realConfig('google'), countingFetch),
      store.getFreshAccessToken('google', realConfig('google'), countingFetch),
    ]);
    expect(refreshRequests).toBe(1);
    expect(a).toBe(b);
    expect(a).toMatch(/^access-/);
    expect(await store.connectionState('google')).toBe('connected');
  });

  // F2: a genuinely-dead refresh token (not merely lost a single-flight race) must
  // still produce an honest reconnect-needed — the fix to (b) below must not make
  // real failures silently invisible.
  test('a genuinely-dead refresh token still produces reconnect-needed', async () => {
    const state = freshState();
    const secrets = makeSecrets();
    let now = 10_000;
    const store = new CalendarTokenStore({ secrets, clock: () => now });
    await store.save('google', { accessToken: 'old', refreshToken: 'rt-dead', tokenType: 'Bearer', expiresAt: 20_000, obtainedAt: 10_000 }, {
      provider: 'google', accountId: 'google', label: 'user@gmail.com', scopes: [], connectedAt: 10_000,
    });
    now = 25_000; // rt-dead was never registered on the server -> refresh 400s
    await expect(store.getFreshAccessToken('google', realConfig('google'), makeFakeFetch(state))).rejects.toBeInstanceOf(TokenRefreshError);
    expect(await store.connectionState('google')).toBe('reconnect-needed');
  });

  // F2(b): markReconnectNeeded must re-read state before writing the marker. If a
  // concurrent process/instance already stored a fresh, valid token set for the
  // same provider (sharing the same secret store) between this refresh's failure
  // and the marker write, the marker must NOT stamp over that working account.
  test('a refresh failure does not stamp reconnect-needed over a token another process already refreshed', async () => {
    const state = freshState();
    const secrets = makeSecrets();
    let now = 10_000;
    const store = new CalendarTokenStore({ secrets, clock: () => now });
    state.refreshTokens.add('rt-1');
    await store.save('google', { accessToken: 'old', refreshToken: 'rt-1', tokenType: 'Bearer', expiresAt: 100_000, obtainedAt: 10_000 }, {
      provider: 'google', accountId: 'google', label: 'user@gmail.com', scopes: [], connectedAt: 10_000,
    });
    now = 200_000;
    const racyFetch: HttpFetch = async () => {
      // Simulate another process/instance winning the race: it refreshes and saves
      // a fresh, valid token set into the SAME shared secret store before this
      // call's own (losing) refresh attempt is handled as a failure.
      await secrets.set('GOODVIBES_CALENDAR_GOOGLE_TOKENS', JSON.stringify({
        accessToken: 'access-from-other-process',
        refreshToken: 'rt-2',
        tokenType: 'Bearer',
        expiresAt: now + 3_600_000,
        obtainedAt: now,
      }));
      return jsonResponse(400, { error: 'invalid_grant' });
    };
    await expect(store.getFreshAccessToken('google', realConfig('google'), racyFetch)).rejects.toBeInstanceOf(TokenRefreshError);
    // The marker must NOT have been stamped over the now-valid token.
    expect(await store.connectionState('google')).toBe('connected');
  });
});

// ---------------------------------------------------------------------------
// Disconnect / revoke
// ---------------------------------------------------------------------------

describe('disconnect', () => {
  test('Google disconnect revokes remotely and clears keys', async () => {
    const state = freshState();
    const secrets = makeSecrets();
    const store = new CalendarTokenStore({ secrets });
    state.refreshTokens.add('rt-x');
    await store.save('google', { accessToken: 'a', refreshToken: 'rt-x', tokenType: 'Bearer', obtainedAt: 1 }, {
      provider: 'google', accountId: 'google', label: 'e', scopes: [], connectedAt: 1,
    });
    const result = await store.disconnect('google', realConfig('google'), makeFakeFetch(state));
    expect(result.revokedRemotely).toBe(true);
    expect(state.revoked.has('rt-x')).toBe(true);
    expect(secrets.map.has('GOODVIBES_CALENDAR_GOOGLE_TOKENS')).toBe(false);
    expect(await store.connectionState('google')).toBe('disconnected');
  });

  test('Microsoft disconnect clears keys locally and reports no remote revocation', async () => {
    const state = freshState();
    const secrets = makeSecrets();
    const store = new CalendarTokenStore({ secrets });
    await store.save('microsoft', { accessToken: 'a', tokenType: 'Bearer', obtainedAt: 1 }, {
      provider: 'microsoft', accountId: 'microsoft', label: 'e', scopes: [], connectedAt: 1,
    });
    const result = await store.disconnect('microsoft', realConfig('microsoft'), makeFakeFetch(state));
    expect(result.revokedRemotely).toBe(false);
    expect(secrets.map.has('GOODVIBES_CALENDAR_MICROSOFT_TOKENS')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reading calendars + events, normalized + paginated
// ---------------------------------------------------------------------------

async function connectedGoogle(): Promise<{ connector: CalendarConnector; state: ServerState }> {
  const state = freshState();
  const secrets = makeSecrets();
  const loopback = makeLoopback(state);
  const connector = new CalendarConnector({ secrets, fetchImpl: makeFakeFetch(state), listenerFactory: loopback.factory });
  const config = realConfig('google');
  const { start, waiter } = await connector.beginConnectAuthCode(config);
  loopback.arm(start.authorizationUrl);
  const { code } = await waiter.waitForCode();
  await connector.completeConnectAuthCode(config, { code, verifier: start.verifier, redirectUri: start.redirectUri });
  return { connector, state };
}

describe('Google Calendar API', () => {
  test('lists calendars with honest write access', async () => {
    const { connector } = await connectedGoogle();
    const calendars = await connector.listCalendars(realConfig('google'));
    expect(calendars).toHaveLength(2);
    expect(calendars.find((c) => c.primary)?.canWrite).toBe(true);
    expect(calendars.find((c) => c.name === 'Team')?.canWrite).toBe(false);
  });

  test('lists events across pages and calendars, normalized + source-labeled', async () => {
    const { connector } = await connectedGoogle();
    const events = await connector.listEvents(realConfig('google'), { timeMin: '2026-07-01T00:00:00Z', timeMax: '2026-07-31T00:00:00Z' });
    // 2 calendars x (page1: 1 event + page2: 1 usable + 1 cancelled skipped) = 4 usable
    expect(events.filter((e) => e.source === 'google-api')).toHaveLength(events.length);
    const timed = events.find((e) => e.uid === 'g1@google')!;
    expect(timed.start.zone).toBe('utc'); // -07:00 offset normalized to a real UTC instant
    expect(timed.start.value).toBe('2026-07-06T16:00:00Z');
    const allDay = events.find((e) => e.summary === 'All day')!;
    expect(allDay.start.kind).toBe('date');
    expect(allDay.start.zone).toBe('floating');
    expect(events.some((e) => (e as { start: { value: string } }).start.value === '2026-07-09')).toBe(false); // cancelled dropped
  });

  test('creates an event and returns it normalized', async () => {
    const { connector } = await connectedGoogle();
    const created = await connector.createEvent(realConfig('google'), 'user@gmail.com', 'Primary', {
      summary: 'New meeting',
      start: { value: '2026-07-10T14:00:00Z', kind: 'date-time', zone: 'utc' },
      end: { value: '2026-07-10T15:00:00Z', kind: 'date-time', zone: 'utc' },
    });
    expect(created.source).toBe('google-api');
    expect(created.summary).toBe('New meeting');
    expect(created.sourceEventId).toBe('g-created');
  });

  test('a 403 names the missing scope; a 429 carries Retry-After; a 401 reconnect', async () => {
    const { connector, state } = await connectedGoogle();
    state.eventsStatus = 403;
    await connector.listEvents(realConfig('google'), { timeMin: 'a', timeMax: 'b' }).then(
      () => { throw new Error('expected 403'); },
      (err: unknown) => {
        expect(err).toBeInstanceOf(CalendarApiError);
        const degraded = (err as CalendarApiError).degraded;
        expect(degraded.kind).toBe('insufficient-scope');
        if (degraded.kind === 'insufficient-scope') expect(degraded.missingScope).toContain('calendar.readonly');
      },
    );
    state.eventsStatus = 429;
    await connector.listEvents(realConfig('google'), { timeMin: 'a', timeMax: 'b' }).then(
      () => { throw new Error('expected 429'); },
      (err: unknown) => {
        const degraded = (err as CalendarApiError).degraded;
        expect(degraded.kind).toBe('rate-limited');
        if (degraded.kind === 'rate-limited') expect(degraded.retryAfterMs).toBe(30_000);
      },
    );
    state.eventsStatus = 401;
    await connector.listEvents(realConfig('google'), { timeMin: 'a', timeMax: 'b' }).then(
      () => { throw new Error('expected 401'); },
      (err: unknown) => expect((err as CalendarApiError).degraded.kind).toBe('reconnect-needed'),
    );
  });
});

describe('Microsoft Graph API', () => {
  async function connectedGraph(): Promise<{ connector: CalendarConnector; state: ServerState }> {
    const state = freshState();
    const connector = new CalendarConnector({ secrets: makeSecrets(), fetchImpl: makeFakeFetch(state), sleep: noSleep, clock: () => 1_000 });
    const config = realConfig('microsoft');
    const start = await connector.beginConnectDeviceCode(config);
    await connector.completeConnectDeviceCode(config, start);
    return { connector, state };
  }

  test('lists calendars, paginated events, and creates an event', async () => {
    const { connector } = await connectedGraph();
    const calendars = await connector.listCalendars(realConfig('microsoft'));
    expect(calendars.find((c) => c.primary)?.canWrite).toBe(true);

    const events = await connector.listEvents(realConfig('microsoft'), { timeMin: '2026-07-01T00:00:00Z', timeMax: '2026-07-31T00:00:00Z' });
    expect(events.every((e) => e.source === 'microsoft-graph')).toBe(true);
    const sync = events.find((e) => e.uid === 'm1@ms')!;
    expect(sync.start.zone).toBe('utc');
    expect(sync.start.value).toBe('2026-07-06T15:00:00Z');
    const holiday = events.find((e) => e.summary === 'Holiday')!;
    expect(holiday.start.kind).toBe('date');

    const created = await connector.createEvent(realConfig('microsoft'), 'cal-primary', 'Calendar', {
      summary: 'Graph event',
      start: { value: '2026-07-11T09:00:00Z', kind: 'date-time', zone: 'utc' },
      end: { value: '2026-07-11T10:00:00Z', kind: 'date-time', zone: 'utc' },
    });
    expect(created.source).toBe('microsoft-graph');
    expect(created.sourceEventId).toBe('m-created');
  });
});
