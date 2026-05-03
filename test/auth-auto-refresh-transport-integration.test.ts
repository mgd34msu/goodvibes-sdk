/**
 * auth-auto-refresh-transport-integration.test.ts
 *
 * Integration tests for the auto-refresh transport middleware wired into
 * createGoodVibesSdk. Verifies that ALL typed operator/peer calls benefit
 * from silent token refresh — not only auth.current().
 *
 * Wave 6/8 discipline: exact literal assertions, no regex unions, no auto-pass,
 * no `.catch(() => {})`, no `test.skip`, no `test.todo`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createGoodVibesSdk,
} from '../packages/sdk/src/client.js';
import {
  createMemoryTokenStore,
} from '../packages/sdk/src/auth.js';
import { GoodVibesSdkError } from '../packages/errors/src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_NOW_MS = 1_800_000_000_000;
const originalDateNow = Date.now;

beforeEach(() => {
  Date.now = () => TEST_NOW_MS;
});

afterEach(() => {
  Date.now = originalDateNow;
});

/** Minimal valid accounts.snapshot response that passes Zod validation. */
function makeSnapshotResponse(): object {
  return {
    capturedAt: Date.now(),
    providers: [],
    configuredCount: 0,
    issueCount: 0,
  };
}

/** Build a JSON Response with a given status code. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build a stateful mock fetch that returns 401 on the first call, then 200. */
function makeStatefulFetch(successBody: object): {
  fetch: typeof globalThis.fetch;
  callCount: () => number;
} {
  let calls = 0;
  const fetchImpl: typeof globalThis.fetch = async (_input, _init) => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    return jsonResponse(successBody);
  };
  return { fetch: fetchImpl, callCount: () => calls };
}

// ---------------------------------------------------------------------------
// Test 1: Typed operator call 401 → refresh → retry succeeds
// ---------------------------------------------------------------------------

describe('transport integration: reactive 401 retry via middleware', () => {
  it('operator.accounts.snapshot() 401 triggers coordinator refresh and retries', async () => {
    let refreshCount = 0;
    const store = createMemoryTokenStore('stale-token');
    const { fetch: mockFetch, callCount } = makeStatefulFetch(makeSnapshotResponse());

    const sdk = createGoodVibesSdk({
      baseUrl: 'https://daemon.example.com',
      tokenStore: store,
      fetch: mockFetch,
      autoRefresh: {
        autoRefresh: true,
        refresh: async () => {
          refreshCount += 1;
          return { token: 'fresh-token', expiresAt: Date.now() + 3_600_000 };
        },
      },
    });

    const result = await sdk.operator.accounts.snapshot();

    // Two HTTP calls: initial (401) + retry (200).
    expect(callCount()).toBe(2);
    // Refresh was called exactly once.
    expect(refreshCount).toBe(1);
    // Fresh token was persisted to the store.
    expect(await store.getToken()).toBe('fresh-token');
    // Result is the snapshot payload.
    expect(typeof result).toBe('object');
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 2: Refresh fails → caller sees SDKError{kind:'auth'} (no infinite loop)
// ---------------------------------------------------------------------------

describe('transport integration: failed refresh produces terminal auth error', () => {
  it('throws GoodVibesSdkError with kind=auth when refresh fails', async () => {
    // Mock fetch always returns 401.
    const alwaysUnauthorized: typeof globalThis.fetch = async () =>
      jsonResponse({ error: 'Unauthorized' }, 401);

    const store = createMemoryTokenStore('bad-token');

    const sdk = createGoodVibesSdk({
      baseUrl: 'https://daemon.example.com',
      tokenStore: store,
      fetch: alwaysUnauthorized,
      autoRefresh: {
        autoRefresh: true,
        refresh: async () => {
          // Returns a new token but the server still rejects all requests.
          return { token: 'still-bad-token', expiresAt: Date.now() + 3_600_000 };
        },
      },
    });

    let caught: unknown;
    try {
      await sdk.operator.accounts.snapshot();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GoodVibesSdkError);
    const sdkErr = caught as GoodVibesSdkError;
    expect(sdkErr.kind).toBe('auth');
    expect(sdkErr.category).toBe('authentication');
    expect(sdkErr.status).toBe(401);
    expect(sdkErr.recoverable).toBe(false);
    // Wave 6 three-part message: contains "Authentication failed"
    expect(sdkErr.message).toContain('Authentication failed');
  });
});

// ---------------------------------------------------------------------------
// Test 3: Pre-flight fires before typed method call when token is within leeway
// ---------------------------------------------------------------------------

describe('transport integration: pre-flight refresh fires within leeway', () => {
  it('refreshes token before request when within leeway window', async () => {
    let refreshCount = 0;
    const fetchCalls: string[] = [];

    // Token expires in 10s — well inside 60s leeway.
    const store = createMemoryTokenStore('expiring-token', Date.now() + 10_000);

    const sdk = createGoodVibesSdk({
      baseUrl: 'https://daemon.example.com',
      tokenStore: store,
      fetch: async (_input, init) => {
        const headers = init?.headers instanceof Headers
          ? init.headers
          : new Headers(init?.headers as HeadersInit);
        fetchCalls.push(headers.get('authorization') ?? '(none)');
        return jsonResponse(makeSnapshotResponse());
      },
      autoRefresh: {
        autoRefresh: true,
        refreshLeewayMs: 60_000,
        refresh: async () => {
          refreshCount += 1;
          return { token: 'refreshed-token', expiresAt: Date.now() + 3_600_000 };
        },
      },
    });

    await sdk.operator.accounts.snapshot();

    // Pre-flight refresh ran before the request.
    expect(refreshCount).toBe(1);
    // Request was made with the freshly-refreshed token.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toBe('Bearer refreshed-token');
  });
});

// ---------------------------------------------------------------------------
// Test 4: Multiple concurrent calls during active refresh → ONE refresh call
// ---------------------------------------------------------------------------

describe('transport integration: concurrent 401s collapse to one refresh', () => {
  it('issues ONE refresh for multiple concurrent operator calls that receive 401', async () => {
    let refreshCount = 0;
    let fetchCount = 0;
    let refreshResolve: () => void;
    const refreshBarrier = new Promise<void>((res) => { refreshResolve = res; });

    const store = createMemoryTokenStore('stale-token');

    // First N calls return 401; after barrier is released, all succeed.
    const mockFetch: typeof globalThis.fetch = async () => {
      fetchCount += 1;
      if (fetchCount <= 2) {
        // First two calls are the concurrent initial attempts — both 401.
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      // Retry calls (after refresh) succeed.
      return jsonResponse(makeSnapshotResponse());
    };

    const sdk = createGoodVibesSdk({
      baseUrl: 'https://daemon.example.com',
      tokenStore: store,
      fetch: mockFetch,
      autoRefresh: {
        autoRefresh: true,
        refresh: async () => {
          refreshCount += 1;
          await refreshBarrier;
          return { token: 'refreshed-token', expiresAt: Date.now() + 3_600_000 };
        },
      },
    });

    // Fire two concurrent calls.
    const p1 = sdk.operator.accounts.snapshot();
    const p2 = sdk.operator.accounts.snapshot();

    // Unblock the refresh.
    refreshResolve!();

    const [r1, r2] = await Promise.all([p1, p2]);

    // Both calls should return valid results.
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    // Coordinator must have serialised refresh — exactly ONE refresh call.
    expect(refreshCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Consumer middleware registered via sdk.use() sees fresh token
// ---------------------------------------------------------------------------

describe('transport integration: consumer middleware sees fresh token after pre-flight', () => {
  it('sdk.use(mw) middleware sees refreshed Bearer token in ctx.headers.Authorization', async () => {
    const seenAuthorizations: string[] = [];
    // Token expires in 5s — well within 60s leeway → pre-flight refresh will fire.
    const store = createMemoryTokenStore('expiring-token', Date.now() + 5_000);

    const sdk = createGoodVibesSdk({
      baseUrl: 'https://daemon.example.com',
      tokenStore: store,
      fetch: async () => jsonResponse(makeSnapshotResponse()),
      autoRefresh: {
        autoRefresh: true,
        refreshLeewayMs: 60_000,
        refresh: async () => ({
          token: 'fresh-token',
          expiresAt: Date.now() + 3_600_000,
        }),
      },
    });

    // Register a consumer middleware AFTER construction via sdk.use().
    sdk.use(async (ctx, next) => {
      seenAuthorizations.push(ctx.headers['Authorization'] ?? ctx.headers['authorization'] ?? '(none)');
      await next();
    });

    await sdk.operator.accounts.snapshot();

    // The consumer middleware should see the FRESH token (auto-refresh ran first).
    expect(seenAuthorizations).toHaveLength(1);
    expect(seenAuthorizations[0]).toBe('Bearer fresh-token');
  });
});
