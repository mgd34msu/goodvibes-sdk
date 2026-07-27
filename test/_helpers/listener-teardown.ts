/**
 * Quiesce an `HttpListener` without going through its async `stop()`.
 *
 * `HttpListener`'s constructor builds two `RateLimiter`s, and each one starts a
 * sweep `setInterval` immediately (packages/sdk/src/platform/daemon/http/rate-limiter.ts:29),
 * so a listener that was constructed for a constructor-behaviour assertion and
 * never started still has two sweeps running.
 *
 * `stop()` now releases those whether or not a socket was ever bound — it is
 * gated on "already torn down", not on `server === null` — so `disposeListener`
 * below is the complete answer and this helper is no longer the only one. It
 * stays because it is SYNCHRONOUS: a `trackDisposables()` registration that
 * cannot await still needs a way to put those two sweeps down.
 *
 * The limiters expose `stop()` publicly, so a test can shut them down directly.
 * This helper is the single documented place that reaches for those fields, so
 * the cast lives here instead of being repeated in every test that needs it.
 *
 * Pair it with `trackDisposables()`:
 *
 *   const listener = disposables.add(new HttpListener({...}), stopListenerTimers);
 */
interface RateLimiterLike {
  stop?(): void;
}

interface ListenerInternals {
  rateLimiter?: RateLimiterLike;
  loginRateLimiter?: RateLimiterLike;
}

export function stopListenerTimers(listener: unknown): void {
  if (listener === null || typeof listener !== 'object') return;
  const internals = listener as ListenerInternals;
  internals.rateLimiter?.stop?.();
  internals.loginRateLimiter?.stop?.();
}

/**
 * Full teardown for a listener that may or may not have been started.
 *
 * `stop()` closes the server when one was bound and clears the sweeps either
 * way; `stopListenerTimers` afterwards is belt-and-braces for a listener whose
 * stop() threw partway. Both are idempotent, so this is correct either way and
 * safe to call twice.
 */
export async function disposeListener(listener: unknown): Promise<void> {
  if (listener === null || typeof listener !== 'object') return;
  const stoppable = listener as { stop?(): Promise<void> | void };
  try {
    await stoppable.stop?.();
  } finally {
    stopListenerTimers(listener);
  }
}
