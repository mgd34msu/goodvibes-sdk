/**
 * Quiesce an `HttpListener` that a test constructed but never started.
 *
 * `HttpListener`'s constructor builds two `RateLimiter`s, and each one starts a
 * sweep `setInterval` immediately (packages/sdk/src/platform/daemon/http/rate-limiter.ts:29).
 * `HttpListener.stop()` does clear them — but only after
 * `if (this.server === null) return;` (http-listener.ts:371), so a listener that
 * was constructed for a constructor-behaviour assertion and never `start()`ed
 * never reaches that code and leaves both sweeps running for the rest of the
 * shared test process.
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
 * `stop()` closes the server and clears the sweeps when the listener was
 * started, and is a harmless early-return when it was not; `stopListenerTimers`
 * then covers the never-started case. Both are idempotent, so this is correct
 * either way and safe to call twice.
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
