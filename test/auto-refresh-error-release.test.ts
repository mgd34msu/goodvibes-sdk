/**
 * auto-refresh-error-release.test.ts
 *
 * WeakRef proof that the reactive-401 retry path releases the original 401
 * error during the refresh+retry await window. The transport's end-of-chain
 * catch sets ctx.error to the SAME object innerFetch threw, so clearing only
 * the middleware's local variable was a no-op — the error (which transitively
 * retains the failed request, whose headers carry the operator-token
 * Authorization header) stayed pinned via ctx.error for the whole window.
 * Mirrors the reviewer's probe: real composeMiddleware + real
 * createAutoRefreshMiddleware, a coordinator parked mid-refresh, WeakRef on the
 * 401, forced GC.
 */
import { describe, expect, test } from 'bun:test';
import { composeMiddleware } from '../packages/transport-core/src/middleware.ts';
import type { TransportContext } from '../packages/transport-core/src/middleware.ts';
import { createAutoRefreshMiddleware } from '../packages/sdk/src/client-auth/auto-refresh-middleware.ts';
import { AutoRefreshCoordinator } from '../packages/sdk/src/client-auth/auto-refresh.ts';
import { createMemoryTokenStore } from '../packages/sdk/src/auth.ts';

function gc(): void {
  (globalThis as { Bun?: { gc?: (f: boolean) => void } }).Bun?.gc?.(true);
}

class Err401 extends Error {
  status = 401;
  /** Simulates the transitive retention: the failed request + auth header. */
  requestContext = { headers: { Authorization: `Bearer operator-token-${'x'.repeat(1024)}` } };
}

describe('auto-refresh reactive-401 error release', () => {
  test('ctx.error is released (WeakRef-collectable) during the parked refresh window', async () => {
    const tokenStore = createMemoryTokenStore('stale-token');
    let releaseRefresh: () => void = () => {};
    const parked = new Promise<void>((r) => { releaseRefresh = r; });
    let refreshEntered: () => void = () => {};
    const entered = new Promise<void>((r) => { refreshEntered = r; });
    const coordinator = new AutoRefreshCoordinator({
      tokenStore,
      autoRefresh: true,
      refreshLeewayMs: 0,
      refresh: async () => {
        refreshEntered();
        await parked; // park mid-refresh — the exact window the error was pinned across
        return { token: 'fresh-token' };
      },
    });

    const transport = { requestJson: async () => ({ ok: true }) };
    const mw = createAutoRefreshMiddleware(coordinator, transport as never, tokenStore);

    let errRef: WeakRef<Err401> | null = null;
    const ctx: TransportContext = {
      url: 'http://daemon.local/api/approvals',
      method: 'GET',
      headers: { Authorization: 'Bearer stale-token' },
      options: {},
    } as unknown as TransportContext;

    // innerFetch throws a 401 in a nested scope so no test frame retains it.
    const innerFetch = async (): Promise<Response> => {
      const err = new Err401('HTTP 401');
      errRef = new WeakRef(err);
      throw err;
    };

    const chain = composeMiddleware([mw], innerFetch as never);
    const run = chain(ctx);
    await entered; // middleware is now parked inside refreshAndRetryOnce
    // The load-bearing assertions: ctx no longer pins the 401 during the window.
    expect(ctx.error).toBeUndefined();
    // WeakRef proof (the reviewer's technique): after forced GC the error is gone.
    let collected = false;
    for (let i = 0; i < 5 && !collected; i++) {
      gc();
      await new Promise((r) => setTimeout(r, 10));
      collected = errRef!.deref() === undefined;
    }
    expect(collected).toBe(true);

    releaseRefresh();
    await run;
    // Post-retry semantics preserved: successful retry leaves ctx.error clear
    // and ctx.response populated.
    expect(ctx.error).toBeUndefined();
    expect(ctx.response).toBeDefined();
  });
});
