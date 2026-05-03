/**
 * Auto-refresh transport middleware.
 *
 * Integrates `AutoRefreshCoordinator` at the transport boundary so that ALL
 * typed operator/peer SDK calls benefit from silent token refresh — not only
 * `auth.current()`.
 *
 * Responsibilities:
 *   1. Pre-flight: call `coordinator.ensureFreshToken()` before dispatching the
 *      request. Updates `ctx.headers.Authorization` with the fresh token so
 *      consumer middleware (which runs after this one) sees the current token.
 *   2. Reactive 401: if `next()` throws a 401-shaped error, trigger a refresh
 *      via `coordinator.refreshAndRetryOnce()` and set `ctx.response` to the
 *      retry result so the transport can return it to the caller.
 *   3. Loop prevention: retry requests carry `__gv_ar_attempted: true` in their
 *      options. The middleware recognises this flag and passes through without
 *      additional refresh logic, preventing infinite recursion.
 *   4. Error passthrough: terminal auth errors from the coordinator are placed
 *      directly onto `ctx.error` rather than thrown, so the transport's
 *      middleware-error-wrapping instrumentation does not re-wrap them as
 *      `kind:'unknown'`.
 */

import type { TransportContext, TransportMiddleware } from '@pellux/goodvibes-transport-core';
import type { HttpJsonTransport } from '@pellux/goodvibes-transport-http/http-core';
import type { GoodVibesTokenStore } from './types.js';
import type { AutoRefreshCoordinator } from './auto-refresh.js';

/** Internal flag key — never conflicts with public HttpJsonRequestOptions fields. */
const ATTEMPTED_FLAG = '__gv_ar_attempted';

/**
 * Create a transport middleware that integrates the `AutoRefreshCoordinator`
 * into every HTTP request.
 *
 * @param coordinator - The auto-refresh coordinator managing token lifecycle.
 * @param transport   - The HTTP JSON transport used to re-issue the request on
 *                      reactive 401 retry. Must be the same transport instance
 *                      whose middleware chain contains this middleware, so that
 *                      the retry benefits from other middleware (e.g. logging,
 *                      tracing) except for another auto-refresh cycle.
 * @param tokenStore  - The token store from which to read the fresh token after
 *                      pre-flight refresh, so `ctx.headers.Authorization` can
 *                      be updated before consumer middleware runs.
 *
 * @example
 * const mw = createAutoRefreshMiddleware(coordinator, transport, tokenStore);
 * transport.use(mw);
 */
export function createAutoRefreshMiddleware(
  coordinator: AutoRefreshCoordinator,
  transport: Pick<HttpJsonTransport, 'requestJson'>,
  tokenStore: GoodVibesTokenStore,
): TransportMiddleware {
  return async function autoRefreshMiddleware(
    ctx: TransportContext,
    next: () => Promise<void>,
  ): Promise<void> {
    // ── Loop-prevention guard ────────────────────────────────────────────────
    // Retry requests issued by this middleware carry the flag. When we see it,
    // simply forward the request without any refresh logic.
    // We catch and re-place errors onto ctx.error so they are NOT tagged as
    // "middleware errors" by the transport's instrumented-chain wrapper — which
    // would re-wrap them as GoodVibesSdkError{kind:'unknown'} and hide the
    // original 401 status that refreshAndRetryOnce needs to detect.
    if (ctx.options[ATTEMPTED_FLAG] === true) {
      try {
        await next();
      } catch (passthroughErr) {
        ctx.error = passthroughErr;
      }
      return;
    }

    // ── Pre-flight refresh ───────────────────────────────────────────────────
    // Silently refreshes the token when it is within the leeway window.
    // After refresh, update ctx.headers.Authorization with the fresh token so
    // consumer middleware (which runs after this one in the chain) sees the
    // current Bearer token, not the stale one that was set when ctx was built.
    await coordinator.ensureFreshToken();
    const freshToken = await tokenStore.getToken();
    if (freshToken) {
      ctx.headers['Authorization'] = `Bearer ${freshToken}`;
    }

    // ── Dispatch request ─────────────────────────────────────────────────────
    // We catch ALL errors from next() rather than re-throwing them directly.
    // Re-throwing from within a middleware causes the transport's instrumented-
    // chain wrapper to tag the error as "from this middleware" and re-wrap it
    // as GoodVibesSdkError{kind:'unknown'}, even when the error originated
    // from the real fetch (innerFetch). By placing non-401 errors onto
    // ctx.error instead, they bypass the middleware-wrapping path and propagate
    // with their original type and kind intact.
    let caughtErr: unknown;
    let nextSucceeded = false;
    try {
      await next();
      nextSucceeded = true;
    } catch (err) {
      caughtErr = err;
    }

    if (nextSucceeded) {
      return; // success — nothing more to do
    }

    if (!is401Error(caughtErr)) {
      // Non-401 error (e.g. 5xx, network) — place on ctx.error so it exits
      // the middleware chain without triggering middleware-error wrapping.
      ctx.error = caughtErr;
      return;
    }

    // ── Reactive 401 retry ─────────────────────────────────────────────────
    // Build retry options that preserve the original request attributes and
    // carry the loop-prevention flag so the next pass through this middleware
    // just calls next() without re-entering the refresh logic.
    const retryOptions: Record<string, unknown> = {
      method: ctx.method,
      body: ctx.body,
      signal: ctx.signal,
      [ATTEMPTED_FLAG]: true,
    };

    // Delegate to coordinator.refreshAndRetryOnce — this refreshes the token
    // exactly once and executes the retry fn once. If the retry also returns
    // 401, it throws GoodVibesSdkError{kind:'auth'} (Wave 6 three-part message).
    //
    // IMPORTANT: we place terminal errors onto ctx.error instead of re-throwing
    // them. This bypasses the transport's middleware-error-wrapping path
    // (which would re-label them as kind:'unknown') and lets the transport's
    // outer `if (ctx.error) throw ctx.error` propagate them cleanly.
    let retryResult: unknown;
    try {
      retryResult = await coordinator.refreshAndRetryOnce(async () => {
        // transport.requestJson goes through the full middleware chain; the
        // ATTEMPTED_FLAG ensures this middleware is a passthrough on that call.
        return transport.requestJson<unknown>(ctx.url, retryOptions as never);
      });
    } catch (retryErr) {
      // Place onto ctx.error — transport's post-chain check will rethrow it
      // without the middleware-wrapping treatment.
      ctx.error = retryErr;
      return;
    }

    // Put the retry result back onto ctx.response so the transport's outer
    // requestJson can resolve it via `await ctx.response.json()`.
    // Also clear ctx.error: the innerFetch path sets it when it throws (before
    // re-throwing), so it reflects the original 401. Since we handled the 401
    // successfully, we must clear it so the transport's `if (ctx.error) throw`
    // guard does not re-raise the already-resolved error.
    ctx.error = undefined;
    ctx.response = new Response(JSON.stringify(retryResult), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect a 401 response across the various error shapes the SDK produces. */
function is401Error(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as {
    status?: unknown;
    transport?: { status?: unknown };
    response?: { status?: unknown };
    cause?: { response?: { status?: unknown } };
  };
  const status =
    e.status ??
    e.transport?.status ??
    e.response?.status ??
    e.cause?.response?.status;
  return status === 401;
}
