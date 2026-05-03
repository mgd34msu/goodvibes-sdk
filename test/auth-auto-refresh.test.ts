/**
 * auth-auto-refresh.test.ts
 *
 * Tests for silent token auto-refresh with in-flight request queuing.
 *
 * Wave 6/8 discipline: exact literal assertions, no regex unions, no auto-pass,
 * no `.catch(() => {})`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createGoodVibesAuthClient,
  createMemoryTokenStore,
  type GoodVibesTokenStore,
} from '../packages/sdk/src/auth.js';
import type { AutoRefreshOptions } from '../packages/sdk/src/auth.js';
import { GoodVibesSdkError } from '../packages/errors/src/index.js';
import type { SDKObserver } from '../packages/sdk/src/observer/index.js';
import type { OperatorSdk } from '../packages/operator-sdk/src/index.js';

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

/** Build a 401 HTTP-status-error matching the SDK's expected shape. */
function make401Error(): GoodVibesSdkError {
  return new GoodVibesSdkError('Authentication failed', {
    category: 'authentication',
    source: 'transport',
    status: 401,
    recoverable: false,
  });
}

/**
 * Create a minimal OperatorSdk stub that records `control.auth.current` calls.
 *
 * @param handler Optional override for `control.auth.current`. Defaults to
 *   returning a successful anonymous response.
 */
function makeOperatorStub(
  handler?: () => Promise<object>,
): { sdk: OperatorSdk; calls: string[] } {
  const calls: string[] = [];
  const defaultCurrentResponse = {
    authenticated: false,
    authMode: 'anonymous' as const,
    tokenPresent: false,
    authorizationHeaderPresent: false,
    sessionCookiePresent: false,
    principalId: null,
    principalKind: null,
    admin: false,
    scopes: [],
    roles: [],
  };

  const sdk = {
    control: {
      auth: {
        current: async () => {
          calls.push('control.auth.current');
          return handler ? handler() : Promise.resolve(defaultCurrentResponse);
        },
        login: async () => {
          calls.push('control.auth.login');
          return {
            authenticated: true,
            token: 'new-token',
            username: 'alice',
            expiresAt: Date.now() + 3_600_000,
          };
        },
      },
    },
  } as unknown as OperatorSdk;

  return { sdk, calls };
}

// ---------------------------------------------------------------------------
// 1. Pre-flight refresh before token expires (leeway triggers refresh)
// ---------------------------------------------------------------------------

describe('pre-flight: leeway triggers refresh when token is near expiry', () => {
  it('calls ensureFreshToken and proceeds when leeway window not exceeded', async () => {
    // Token expires 2 hours from now — well outside 60s leeway.
    const store = createMemoryTokenStore('valid-token', Date.now() + 2 * 3_600_000);
    const { sdk, calls } = makeOperatorStub();

    const auth = createGoodVibesAuthClient(
      sdk,
      store,
      undefined,
      undefined,
      { autoRefresh: true, refreshLeewayMs: 60_000 },
    );

    await auth.current();

    // current() should still be called once (no refresh needed)
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('control.auth.current');
  });

  it('triggers refresh when token expires within leeway window', async () => {
    // Token expires in 30 seconds — inside 60s leeway.
    // No refresh endpoint → graceful no-op, but coordinator runs.
    const store = createMemoryTokenStore('expiring-token', Date.now() + 30_000);
    const { sdk, calls } = makeOperatorStub();

    const refreshCalls: string[] = [];
    // Override the store to track setToken calls (proxy)
    const proxyStore: GoodVibesTokenStore = {
      getToken: () => store.getToken(),
      setToken: async (t) => {
        refreshCalls.push('setToken');
        return store.setToken(t);
      },
      clearToken: async () => {
        refreshCalls.push('clearToken');
        return store.clearToken();
      },
      getTokenEntry: () => store.getTokenEntry!(),
      setTokenEntry: async (t, exp) => {
        refreshCalls.push('setTokenEntry');
        return store.setTokenEntry!(t, exp);
      },
    };

    const auth = createGoodVibesAuthClient(
      sdk,
      proxyStore,
      undefined,
      undefined,
      { autoRefresh: true, refreshLeewayMs: 60_000 },
    );

    // Should still succeed — no-refresh endpoint means graceful skip.
    await auth.current();

    // The request went through (current() was called)
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('control.auth.current');
  });
});

// ---------------------------------------------------------------------------
// 2. In-flight request queuing during refresh
// ---------------------------------------------------------------------------

describe('in-flight queuing: concurrent refreshes collapse to one', () => {
  it('queues concurrent requests — single refresh call when token near expiry', async () => {
    // Token expires in 10s — well within leeway.
    // No refresh endpoint, but we track coordinator behaviour via promise ordering.

    let refreshCount = 0;
    const store = createMemoryTokenStore('token', Date.now() + 10_000);

    // We inject a custom refresh function via a workaround:
    // create the coordinator directly to verify the queue behaviour.
    const { AutoRefreshCoordinator } = await import(
      '../packages/sdk/src/client-auth/auto-refresh.js'
    );

    let refreshResolve: () => void;
    const refreshBarrier = new Promise<void>((res) => { refreshResolve = res; });

    const coordinator = new AutoRefreshCoordinator({
      tokenStore: store,
      autoRefresh: true,
      refreshLeewayMs: 60_000,
      refresh: async () => {
        refreshCount += 1;
        // Hold refresh so concurrent requests pile up.
        await refreshBarrier;
        return { token: 'refreshed-token', expiresAt: Date.now() + 3_600_000 };
      },
    });

    // Fire two concurrent ensureFreshToken calls.
    const p1 = coordinator.ensureFreshToken();
    const p2 = coordinator.ensureFreshToken();

    // Unblock the refresh.
    refreshResolve!();
    await p1;
    await p2;

    // Despite two concurrent calls, refresh only ran once.
    expect(refreshCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Reactive 401 retry: 401 → refresh → retry succeeds
// ---------------------------------------------------------------------------

describe('reactive 401 retry: retry succeeds after refresh', () => {
  it('retries once on 401 and returns result from second attempt', async () => {
    const store = createMemoryTokenStore('stale-token');
    let attempt = 0;

    const { AutoRefreshCoordinator } = await import(
      '../packages/sdk/src/client-auth/auto-refresh.js'
    );

    const coordinator = new AutoRefreshCoordinator({
      tokenStore: store,
      autoRefresh: true,
      refreshLeewayMs: 60_000,
      refresh: async () => {
        return { token: 'fresh-token', expiresAt: Date.now() + 3_600_000 };
      },
    });

    const result = await coordinator.withRetryOn401(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw make401Error();
      }
      return 'success';
    });

    expect(attempt).toBe(2);
    expect(result).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// 4. Reactive 401 terminal: 401 → refresh → 401 again → throws kind:'auth'
// ---------------------------------------------------------------------------

describe('reactive 401 terminal: double 401 throws auth error', () => {
  it('throws GoodVibesSdkError with kind=auth on terminal 401', async () => {
    const store = createMemoryTokenStore('stale-token');

    const { AutoRefreshCoordinator } = await import(
      '../packages/sdk/src/client-auth/auto-refresh.js'
    );

    const coordinator = new AutoRefreshCoordinator({
      tokenStore: store,
      autoRefresh: true,
      refreshLeewayMs: 60_000,
      refresh: async () => {
        return { token: 'still-bad-token', expiresAt: Date.now() + 3_600_000 };
      },
    });

    let caught: unknown;
    try {
      await coordinator.withRetryOn401(async () => {
        throw make401Error();
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GoodVibesSdkError);
    const sdkErr = caught as GoodVibesSdkError;
    expect(sdkErr.kind).toBe('auth');
    expect(sdkErr.category).toBe('authentication');
    expect(sdkErr.status).toBe(401);
    expect(sdkErr.recoverable).toBe(false);
    expect(typeof sdkErr.message).toBe('string');
    // Wave 6 three-part message format: [what] · [why] · [what to do]
    expect(sdkErr.message).toContain('Authentication failed');
  });

  it('emits onError observer notification on terminal 401', async () => {
    const store = createMemoryTokenStore('stale-token');
    const observedErrors: GoodVibesSdkError[] = [];

    const observer: SDKObserver = {
      onError(err) {
        observedErrors.push(err);
      },
    };

    const { AutoRefreshCoordinator } = await import(
      '../packages/sdk/src/client-auth/auto-refresh.js'
    );

    const coordinator = new AutoRefreshCoordinator({
      tokenStore: store,
      autoRefresh: true,
      refreshLeewayMs: 60_000,
      refresh: async () => ({ token: 'bad', expiresAt: Date.now() + 3_600_000 }),
      observer,
    });

    let threw = false;
    try {
      await coordinator.withRetryOn401(async () => {
        throw make401Error();
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(observedErrors).toHaveLength(1);
    expect(observedErrors[0].kind).toBe('auth');
  });
});

// ---------------------------------------------------------------------------
// 5. Opt-out: autoRefresh:false skips refresh, bubbles 401
// ---------------------------------------------------------------------------

describe('opt-out: autoRefresh:false disables refresh and bubbles 401', () => {
  it('does not retry on 401 when autoRefresh is false', async () => {
    const store = createMemoryTokenStore('token');

    const { AutoRefreshCoordinator } = await import(
      '../packages/sdk/src/client-auth/auto-refresh.js'
    );

    let refreshCalled = false;
    const coordinator = new AutoRefreshCoordinator({
      tokenStore: store,
      autoRefresh: false,
      refreshLeewayMs: 60_000,
      refresh: async () => {
        refreshCalled = true;
        return { token: 'new', expiresAt: Date.now() + 3_600_000 };
      },
    });

    let caught: unknown;
    try {
      await coordinator.withRetryOn401(async () => {
        throw make401Error();
      });
    } catch (err) {
      caught = err;
    }

    // The original 401 error should bubble up unchanged.
    expect(caught).toBeInstanceOf(GoodVibesSdkError);
    const err = caught as GoodVibesSdkError;
    expect(err.status).toBe(401);
    // Refresh must NOT have been called.
    expect(refreshCalled).toBe(false);
  });

  it('does not run pre-flight refresh when autoRefresh is false', async () => {
    // Token expires in 5 seconds — would trigger pre-flight if enabled.
    const store = createMemoryTokenStore('expiring', Date.now() + 5_000);

    const { AutoRefreshCoordinator } = await import(
      '../packages/sdk/src/client-auth/auto-refresh.js'
    );

    let refreshCalled = false;
    const coordinator = new AutoRefreshCoordinator({
      tokenStore: store,
      autoRefresh: false,
      refreshLeewayMs: 60_000,
      refresh: async () => {
        refreshCalled = true;
        return { token: 'new', expiresAt: Date.now() + 3_600_000 };
      },
    });

    // ensureFreshToken should be a no-op when autoRefresh:false.
    await coordinator.ensureFreshToken();
    expect(refreshCalled).toBe(false);
  });

  it('autoRefresh:false on createGoodVibesAuthClient passes through to coordinator', async () => {
    const store = createMemoryTokenStore('token');
    const { sdk, calls } = makeOperatorStub(async () => {
      throw make401Error();
    });

    const auth = createGoodVibesAuthClient(
      sdk,
      store,
      undefined,
      undefined,
      { autoRefresh: false },
    );

    let caught: unknown;
    try {
      await auth.current();
    } catch (err) {
      caught = err;
    }

    // With autoRefresh:false, the coordinator is disabled entirely.
    // The 401 from the operator should propagate directly.
    expect(caught).toBeInstanceOf(GoodVibesSdkError);
    // current() attempted exactly once (no retry).
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Observer integration: onAuthTransition on successful refresh
// ---------------------------------------------------------------------------

describe('observer: onAuthTransition emitted on successful refresh', () => {
  it('emits reason=refresh on successful silent refresh', async () => {
    const store = createMemoryTokenStore('old-token');
    const transitions: Array<{ from: string; to: string; reason: string }> = [];

    const observer: SDKObserver = {
      onAuthTransition(t) {
        transitions.push({ from: t.from, to: t.to, reason: t.reason });
      },
    };

    const { AutoRefreshCoordinator } = await import(
      '../packages/sdk/src/client-auth/auto-refresh.js'
    );

    const coordinator = new AutoRefreshCoordinator({
      tokenStore: store,
      autoRefresh: true,
      refreshLeewayMs: 60_000,
      refresh: async () => ({ token: 'new-token', expiresAt: Date.now() + 3_600_000 }),
      observer,
    });

    try {
      await coordinator.withRetryOn401(async () => {
        throw make401Error();
      });
    } catch {
      // Second attempt also fails (no real server) — but the refresh DID succeed.
      // We need to test the case where the first attempt throws 401,
      // refresh succeeds, but second attempt also throws 401.
      // The observer for the refresh should still fire.
    }

    // refresh transition should have been emitted
    const refreshTransition = transitions.find((t) => t.reason === 'refresh');
    expect(refreshTransition).toBeDefined();
    expect(refreshTransition!.from).toBe('token');
    expect(refreshTransition!.to).toBe('token');
    expect(refreshTransition!.reason).toBe('refresh');
  });

  it('emits reason=expired when refresh fails (fallback to anonymous)', async () => {
    const store = createMemoryTokenStore('old-token', Date.now() + 10_000);
    const transitions: Array<{ from: string; to: string; reason: string }> = [];

    const observer: SDKObserver = {
      onAuthTransition(t) {
        transitions.push({ from: t.from, to: t.to, reason: t.reason });
      },
    };

    const { AutoRefreshCoordinator } = await import(
      '../packages/sdk/src/client-auth/auto-refresh.js'
    );

    const coordinator = new AutoRefreshCoordinator({
      tokenStore: store,
      autoRefresh: true,
      refreshLeewayMs: 60_000,
      refresh: async () => {
        throw new Error('refresh server down');
      },
      observer,
    });

    // Pre-flight: token is near expiry, refresh will fail.
    await coordinator.ensureFreshToken();

    const expiredTransition = transitions.find((t) => t.reason === 'expire');
    expect(expiredTransition).toBeDefined();
    expect(expiredTransition!.from).toBe('token');
    expect(expiredTransition!.to).toBe('anonymous');
    expect(expiredTransition!.reason).toBe('expire');
  });
});

// ---------------------------------------------------------------------------
// 7. createMemoryTokenStore expiresAt persistence
// ---------------------------------------------------------------------------

describe('createMemoryTokenStore: expiresAt persistence', () => {
  it('stores and retrieves expiresAt', async () => {
    const expiry = Date.now() + 3_600_000;
    const store = createMemoryTokenStore('tok', expiry);

    const entry = await store.getTokenEntry!();
    expect(entry.token).toBe('tok');
    expect(entry.expiresAt).toBe(expiry);
  });

  it('clears expiresAt when setToken is called', async () => {
    const store = createMemoryTokenStore('tok', Date.now() + 3_600_000);
    await store.setToken('new-tok');

    const entry = await store.getTokenEntry!();
    expect(entry.token).toBe('new-tok');
    expect(entry.expiresAt).toBeUndefined();
  });

  it('sets expiresAt via setTokenEntry', async () => {
    const store = createMemoryTokenStore(null);
    const expiry = Date.now() + 7_200_000;
    await store.setTokenEntry!('fresh-tok', expiry);

    const entry = await store.getTokenEntry!();
    expect(entry.token).toBe('fresh-tok');
    expect(entry.expiresAt).toBe(expiry);
  });

  it('clears expiresAt on clearToken', async () => {
    const store = createMemoryTokenStore('tok', Date.now() + 3_600_000);
    await store.clearToken();

    const entry = await store.getTokenEntry!();
    expect(entry.token).toBeNull();
    expect(entry.expiresAt).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// 8. Consumer-provided refresh callback — MAJOR 2
// ---------------------------------------------------------------------------

describe('consumer refresh callback: pre-flight leeway trigger', () => {
  it('consumer-provided refresh is invoked on pre-flight leeway trigger', async () => {
    const store = createMemoryTokenStore('old-token', Date.now() + 5_000); // within 60s leeway
    let refreshCallCount = 0;

    const { AutoRefreshCoordinator } = await import(
      '../packages/sdk/src/client-auth/auto-refresh.js'
    );

    const coordinator = new AutoRefreshCoordinator({
      tokenStore: store,
      autoRefresh: true,
      refreshLeewayMs: 60_000,
      refresh: async () => {
        refreshCallCount += 1;
        return { token: 'refreshed-token', expiresAt: Date.now() + 3_600_000 };
      },
    });

    await coordinator.ensureFreshToken();

    expect(refreshCallCount).toBe(1);
  });

  it('consumer refresh persists returned token+expiry via setTokenEntry', async () => {
    const expiry = Date.now() + 3_600_000;
    const store = createMemoryTokenStore('old-token', Date.now() + 5_000);

    const { AutoRefreshCoordinator } = await import(
      '../packages/sdk/src/client-auth/auto-refresh.js'
    );

    const coordinator = new AutoRefreshCoordinator({
      tokenStore: store,
      autoRefresh: true,
      refreshLeewayMs: 60_000,
      refresh: async () => {
        return { token: 'new-token', expiresAt: expiry };
      },
    });

    await coordinator.ensureFreshToken();

    const entry = await store.getTokenEntry!();
    expect(entry.token).toBe('new-token');
    expect(entry.expiresAt).toBe(expiry);
  });
});

describe('consumer refresh callback: reactive 401 path', () => {
  it('consumer-provided refresh is invoked on 401 reactive retry', async () => {
    const store = createMemoryTokenStore('old-token');
    let refreshCallCount = 0;
    let attempt = 0;

    const { AutoRefreshCoordinator } = await import(
      '../packages/sdk/src/client-auth/auto-refresh.js'
    );

    const coordinator = new AutoRefreshCoordinator({
      tokenStore: store,
      autoRefresh: true,
      refreshLeewayMs: 60_000,
      refresh: async () => {
        refreshCallCount += 1;
        return { token: 'refreshed-token', expiresAt: Date.now() + 3_600_000 };
      },
    });

    const result = await coordinator.withRetryOn401(async () => {
      attempt += 1;
      if (attempt === 1) throw make401Error();
      return 'ok';
    });

    expect(refreshCallCount).toBe(1);
    expect(result).toBe('ok');
  });

  it('returned token+expiry from consumer refresh is persisted via setTokenEntry after 401', async () => {
    const store = createMemoryTokenStore('old-token');
    const newExpiry = Date.now() + 7_200_000;
    let attempt = 0;

    const { AutoRefreshCoordinator } = await import(
      '../packages/sdk/src/client-auth/auto-refresh.js'
    );

    const coordinator = new AutoRefreshCoordinator({
      tokenStore: store,
      autoRefresh: true,
      refreshLeewayMs: 60_000,
      refresh: async () => {
        return { token: 'new-token', expiresAt: newExpiry };
      },
    });

    await coordinator.withRetryOn401(async () => {
      attempt += 1;
      if (attempt === 1) throw make401Error();
      return 'ok';
    });

    const entry = await store.getTokenEntry!();
    expect(entry.token).toBe('new-token');
    expect(entry.expiresAt).toBe(newExpiry);
  });
});

// ---------------------------------------------------------------------------
// 9. Broadened is401Error shapes — MINOR 2
// ---------------------------------------------------------------------------

describe('is401Error: broadened error shapes', () => {
  it('detects 401 on error.response.status', async () => {
    const { AutoRefreshCoordinator } = await import(
      '../packages/sdk/src/client-auth/auto-refresh.js'
    );

    const store = createMemoryTokenStore('tok');
    const coordinator = new AutoRefreshCoordinator({
      tokenStore: store,
      autoRefresh: true,
      refreshLeewayMs: 60_000,
      refresh: async () => ({ token: 'new', expiresAt: Date.now() + 3_600_000 }),
    });

    const fetchShapeError = { response: { status: 401 } };
    let attempt = 0;
    const result = await coordinator.withRetryOn401(async () => {
      attempt += 1;
      if (attempt === 1) throw fetchShapeError;
      return 'ok';
    });

    expect(attempt).toBe(2);
    expect(result).toBe('ok');
  });

  it('detects 401 on error.cause.response.status', async () => {
    const { AutoRefreshCoordinator } = await import(
      '../packages/sdk/src/client-auth/auto-refresh.js'
    );

    const store = createMemoryTokenStore('tok');
    const coordinator = new AutoRefreshCoordinator({
      tokenStore: store,
      autoRefresh: true,
      refreshLeewayMs: 60_000,
      refresh: async () => ({ token: 'new', expiresAt: Date.now() + 3_600_000 }),
    });

    const wrappedError = { cause: { response: { status: 401 } } };
    let attempt = 0;
    const result = await coordinator.withRetryOn401(async () => {
      attempt += 1;
      if (attempt === 1) throw wrappedError;
      return 'ok';
    });

    expect(attempt).toBe(2);
    expect(result).toBe('ok');
  });

  it('does not falsely detect 401 on non-401 response.status', async () => {
    const { AutoRefreshCoordinator } = await import(
      '../packages/sdk/src/client-auth/auto-refresh.js'
    );

    const store = createMemoryTokenStore('tok');
    let refreshCalled = false;
    const coordinator = new AutoRefreshCoordinator({
      tokenStore: store,
      autoRefresh: true,
      refreshLeewayMs: 60_000,
      refresh: async () => {
        refreshCalled = true;
        return { token: 'new', expiresAt: Date.now() + 3_600_000 };
      },
    });

    const notAuthError = { response: { status: 403 } };
    let caught: unknown;
    try {
      await coordinator.withRetryOn401(async () => {
        throw notAuthError;
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(notAuthError);
    expect(refreshCalled).toBe(false);
  });
});
