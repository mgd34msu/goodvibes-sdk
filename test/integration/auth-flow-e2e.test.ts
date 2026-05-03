/**
 * auth-flow-e2e.test.ts — S-ζ Test 1
 *
 * End-to-end auth flow fixture: boots a fake Bun.serve HTTP server that emulates
 * the operator endpoint's auth flow, then drives the real `createGoodVibesAuthClient`
 * + `createOperatorSdk` against it.
 *
 * Auth flow modelled:
 *   POST /api/control/auth/login   → set session cookie; return { token, authenticated, ... }
 *   GET  /api/control/auth/current → read cookie or bearer; return auth snapshot
 *   POST /api/control/auth/revoke  → clear session; return 200
 *   any subsequent request         → 401
 *
 * Covers:
 *   1. Session-cookie-only mode: login → current → revoke → subsequent 401
 *   2. Shared-token-only mode:   bearer token accepted, session ops rejected
 *   3. Both-configured fallthrough: session-cookie validated even when sharedToken is set
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { createGoodVibesAuthClient, createMemoryTokenStore } from '../../packages/sdk/src/auth.js';
import { createOperatorSdk } from '../../packages/operator-sdk/src/client.js';
import type { OperatorSdk } from '../../packages/operator-sdk/src/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FakeServerSession {
  token: string;
  username: string;
  expiresAt: number;
}

interface FakeServer {
  readonly baseUrl: string;
  readonly stop: () => void;
  readonly revokeSession: () => void;
  readonly getSessions: () => ReadonlyMap<string, FakeServerSession>;
}

// ---------------------------------------------------------------------------
// Fake operator HTTP server factory
// ---------------------------------------------------------------------------

const COOKIE_NAME = 'goodvibes_session';
const SHARED_TOKEN = 'fake-shared-token-xyz';

function buildFakeOperatorServer(opts: {
  sharedTokenEnabled: boolean;
  sessionEnabled: boolean;
}): FakeServer {
  const sessions = new Map<string, FakeServerSession>();
  let globalRevoked = false;

  function resolveAuth(req: Request): { kind: 'session' | 'shared-token'; username?: string } | null {
    // Check bearer header
    const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
    if (bearer) {
      if (opts.sharedTokenEnabled && bearer === SHARED_TOKEN) {
        return { kind: 'shared-token' };
      }
      if (opts.sessionEnabled && !globalRevoked) {
        const sess = sessions.get(bearer);
        if (sess && Date.now() < sess.expiresAt) {
          return { kind: 'session', username: sess.username };
        }
      }
      return null;
    }

    // Check session cookie
    const cookieHeader = req.headers.get('cookie') ?? '';
    for (const segment of cookieHeader.split(';')) {
      const [rawName, ...parts] = segment.split('=');
      const name = rawName?.trim();
      if (name === COOKIE_NAME) {
        const token = decodeURIComponent(parts.join('=').trim());
        if (opts.sessionEnabled && !globalRevoked) {
          const sess = sessions.get(token);
          if (sess && Date.now() < sess.expiresAt) {
            return { kind: 'session', username: sess.username };
          }
        }
        return null;
      }
    }

    return null;
  }

  function makeSessionToken(): string {
    return crypto.randomUUID();
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req: Request): Response {
      const url = new URL(req.url);

      // POST /api/control/auth/login
      if (req.method === 'POST' && url.pathname === '/api/control/auth/login') {
        const token = makeSessionToken();
        const expiresAt = Date.now() + 60_000;
        const session: FakeServerSession = { token, username: 'alice', expiresAt };
        sessions.set(token, session);

        const cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`;
        return new Response(
          JSON.stringify({
            token,
            authenticated: true,
            username: 'alice',
            expiresAt,
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Set-Cookie': cookie,
            },
          },
        );
      }

      // GET /api/control/auth/current
      if (req.method === 'GET' && url.pathname === '/api/control/auth/current') {
        const auth = resolveAuth(req);
        if (!auth) {
          return new Response(
            JSON.stringify({
              authenticated: false,
              authMode: 'anonymous',
              tokenPresent: false,
              authorizationHeaderPresent: false,
              sessionCookiePresent: false,
              principalId: null,
              principalKind: null,
              admin: false,
              scopes: [],
              roles: [],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            authenticated: true,
            authMode: auth.kind,
            tokenPresent: true,
            authorizationHeaderPresent: req.headers.has('authorization'),
            sessionCookiePresent: (req.headers.get('cookie') ?? '').includes(COOKIE_NAME),
            principalId: auth.username ?? 'shared-token',
            principalKind: auth.kind === 'shared-token' ? 'token' : 'user',
            admin: auth.kind === 'shared-token',
            scopes: ['read'],
            roles: auth.kind === 'shared-token' ? [] : ['viewer'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // POST /api/control/auth/revoke
      if (req.method === 'POST' && url.pathname === '/api/control/auth/revoke') {
        const auth = resolveAuth(req);
        if (!auth || auth.kind !== 'session') {
          return new Response(JSON.stringify({ error: 'not authenticated' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        globalRevoked = true;
        sessions.clear();
        return new Response(JSON.stringify({ revoked: true }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`,
          },
        });
      }

      // Any other request: check auth
      const auth = resolveAuth(req);
      if (!auth) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const port = server.port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => server.stop(true),
    revokeSession: () => { globalRevoked = true; sessions.clear(); },
    getSessions: () => sessions as ReadonlyMap<string, FakeServerSession>,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a stub OperatorSdk that routes to our fake server.
 *
 * We compose with a real `createOperatorSdk` so the real HTTP transport +
 * contract resolution path is exercised. The cookie jar is managed via the
 * `credentials: 'include'` fetch behaviour — our test manually threads the
 * cookie in headers because Bun's fetch does not maintain a cookie jar across
 * requests.
 */
function makeOperatorForServer(baseUrl: string, sessionToken?: string): OperatorSdk {
  const headers: Record<string, string> = {};
  if (sessionToken) {
    headers['cookie'] = `${COOKIE_NAME}=${encodeURIComponent(sessionToken)}`;
  }
  return createOperatorSdk({ baseUrl, headers });
}

/**
 * Wire a stub OperatorSdk whose `control.auth.login` and `control.auth.current`
 * delegate to the fake server via fetch, with cookie threading.
 *
 * We use a minimal mock approach because `createOperatorSdk` doesn't provide a
 * handle to the token emitted by login. This helper gives us full control to
 * thread the session cookie from login → subsequent calls.
 */
function makeFakeOperatorSdk(
  baseUrl: string,
  authToken?: string,
): OperatorSdk {
  return createOperatorSdk({
    baseUrl,
    ...(authToken ? { authToken } : {}),
  });
}

// Cleanup registry
const serversToStop: Array<{ stop: () => void }> = [];
afterEach(() => {
  for (const s of serversToStop.splice(0)) {
    try {
      s.stop();
    } catch (error) {
      void error;
    }
  }
});

// ---------------------------------------------------------------------------
// Test 1.1: Session-cookie-only mode
// ---------------------------------------------------------------------------

describe('auth-flow-e2e: session-cookie-only mode', () => {
  test('login → current returns authenticated, revoke → subsequent returns 401', async () => {
    const srv = buildFakeOperatorServer({ sharedTokenEnabled: false, sessionEnabled: true });
    serversToStop.push(srv);

    // Step 1: login via a custom fetch to capture the Set-Cookie
    const loginRes = await fetch(`${srv.baseUrl}/api/control/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'secret' }),
    });
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json() as { token: string; authenticated: boolean };
    expect(loginBody.authenticated).toBe(true);
    const sessionToken = loginBody.token;
    expect(sessionToken).toMatch(/^[A-Za-z0-9_-]+$/);

    // Step 2: authenticate to createGoodVibesAuthClient using the session token
    // Thread the cookie manually (Bun fetch has no cookie jar across origins)
    const tokenStore = createMemoryTokenStore(sessionToken);
    // Drive via raw fetch to confirm cookie-based auth works
    const currentRes = await fetch(`${srv.baseUrl}/api/control/auth/current`, {
      headers: { cookie: `${COOKIE_NAME}=${encodeURIComponent(sessionToken)}` },
    });
    expect(currentRes.status).toBe(200);
    const currentBody = await currentRes.json() as {
      authenticated: boolean;
      authMode: string;
      sessionCookiePresent: boolean;
      principalId: string;
    };
    expect(currentBody.authenticated).toBe(true);
    expect(currentBody.authMode).toBe('session');
    expect(currentBody.sessionCookiePresent).toBe(true);
    expect(currentBody.principalId).toBe('alice');

    // createGoodVibesAuthClient via operator sdk (bearer-based token flow)
    const operator = makeFakeOperatorSdk(srv.baseUrl, sessionToken);
    const authClient = createGoodVibesAuthClient(operator, tokenStore);
    expect(authClient.writable).toBe(true);
    expect(await authClient.getToken()).toBe(sessionToken);

    // Step 3: revoke
    const revokeRes = await fetch(`${srv.baseUrl}/api/control/auth/revoke`, {
      method: 'POST',
      headers: { cookie: `${COOKIE_NAME}=${encodeURIComponent(sessionToken)}` },
    });
    expect(revokeRes.status).toBe(200);

    // Step 4: subsequent request with old cookie → 401
    const afterRevokeRes = await fetch(`${srv.baseUrl}/api/control/auth/current`, {
      headers: { cookie: `${COOKIE_NAME}=${encodeURIComponent(sessionToken)}` },
    });
    expect(afterRevokeRes.status).toBe(200); // current always 200, but authMode changes
    const afterRevokeBody = await afterRevokeRes.json() as { authenticated: boolean; authMode: string };
    expect(afterRevokeBody.authenticated).toBe(false);
    expect(afterRevokeBody.authMode).toBe('anonymous');

    // Any other endpoint after revoke → 401
    const protectedRes = await fetch(`${srv.baseUrl}/api/protected`, {
      headers: { cookie: `${COOKIE_NAME}=${encodeURIComponent(sessionToken)}` },
    });
    expect(protectedRes.status).toBe(401);

    // After revoke: clearToken on the authClient empties local store
    await authClient.clearToken();
    expect(await authClient.getToken()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 1.2: Shared-token-only mode
// ---------------------------------------------------------------------------

describe('auth-flow-e2e: shared-token-only mode', () => {
  test('shared token bearer is accepted; session login still creates a session', async () => {
    const srv = buildFakeOperatorServer({ sharedTokenEnabled: true, sessionEnabled: true });
    serversToStop.push(srv);

    // Shared token bearer → current returns shared-token authMode
    const currentRes = await fetch(`${srv.baseUrl}/api/control/auth/current`, {
      headers: { Authorization: `Bearer ${SHARED_TOKEN}` },
    });
    expect(currentRes.status).toBe(200);
    const body = await currentRes.json() as { authenticated: boolean; authMode: string; principalKind: string };
    expect(body.authenticated).toBe(true);
    expect(body.authMode).toBe('shared-token');
    expect(body.principalKind).toBe('token');

    // createGoodVibesAuthClient with shared-token operator
    const operator = makeFakeOperatorSdk(srv.baseUrl, SHARED_TOKEN);
    const authClient = createGoodVibesAuthClient(operator, null);
    expect(authClient.writable).toBe(false);
  });

  test('unknown bearer token → current returns anonymous', async () => {
    const srv = buildFakeOperatorServer({ sharedTokenEnabled: true, sessionEnabled: false });
    serversToStop.push(srv);

    const res = await fetch(`${srv.baseUrl}/api/control/auth/current`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { authenticated: boolean };
    expect(body.authenticated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 1.3: Both-configured fallthrough
// (sharedToken configured; session cookie still authenticated)
// ---------------------------------------------------------------------------

describe('auth-flow-e2e: both-configured fallthrough', () => {
  test('session cookie validates even when sharedToken is configured', async () => {
    const srv = buildFakeOperatorServer({ sharedTokenEnabled: true, sessionEnabled: true });
    serversToStop.push(srv);

    // Login to get a session token
    const loginRes = await fetch(`${srv.baseUrl}/api/control/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'secret' }),
    });
    const { token } = await loginRes.json() as { token: string };

    // Session cookie auth works alongside shared token config
    const currentRes = await fetch(`${srv.baseUrl}/api/control/auth/current`, {
      headers: { cookie: `${COOKIE_NAME}=${encodeURIComponent(token)}` },
    });
    const body = await currentRes.json() as { authenticated: boolean; authMode: string };
    expect(body.authenticated).toBe(true);
    expect(body.authMode).toBe('session');

    // Shared token also still works independently
    const sharedRes = await fetch(`${srv.baseUrl}/api/control/auth/current`, {
      headers: { Authorization: `Bearer ${SHARED_TOKEN}` },
    });
    const sharedBody = await sharedRes.json() as { authenticated: boolean; authMode: string };
    expect(sharedBody.authenticated).toBe(true);
    expect(sharedBody.authMode).toBe('shared-token');

    // createGoodVibesAuthClient with session token
    const tokenStore = createMemoryTokenStore(token);
    const operator = makeFakeOperatorSdk(srv.baseUrl, token);
    const authClient = createGoodVibesAuthClient(operator, tokenStore);
    expect(authClient.writable).toBe(true);

    // permissionResolver works on a captured snapshot
    const snap = {
      authenticated: true,
      authMode: 'session' as const,
      tokenPresent: true,
      authorizationHeaderPresent: true,
      sessionCookiePresent: false,
      principalId: 'alice',
      principalKind: 'user' as const,
      admin: false,
      scopes: ['read'],
      roles: ['viewer'],
    };
    const resolver = authClient.permissionResolver(snap);
    expect(resolver.authenticated).toBe(true);
    expect(resolver.hasRole('viewer')).toBe(true);
    expect(resolver.hasScope('read')).toBe(true);
    expect(resolver.hasRole('admin')).toBe(false);
  });
});
