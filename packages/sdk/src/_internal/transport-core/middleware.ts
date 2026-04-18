// Synced from packages/transport-core/src/middleware.ts
/**
 * Transport middleware (Koa-style) for the HTTP transport layer.
 *
 * Middleware functions wrap the real fetch call and receive a mutable context
 * object. Calling `next()` executes the next middleware in the chain (or the
 * real fetch at the end). After `await next()` returns, `ctx.response` and
 * `ctx.durationMs` are populated; `ctx.error` is set if the fetch threw.
 *
 * @example
 * sdk.use(async (ctx, next) => {
 *   console.log('->', ctx.method, ctx.url);
 *   await next();
 *   console.log('<-', ctx.response?.status, ctx.durationMs, 'ms');
 * });
 */

/**
 * Mutable context object passed through the middleware chain.
 * Fields are populated progressively: request fields are set before the chain
 * runs; response fields are set after the real fetch resolves.
 */
export interface TransportContext {
  /** HTTP method (uppercased). */
  method: string;
  /** Fully-qualified request URL. */
  url: string;
  /** Request headers (mutable — middleware may add/override). */
  headers: Record<string, string>;
  /** Request body (undefined for GET/HEAD). */
  body: unknown;
  /** Per-request options forwarded from the caller. */
  options: {
    readonly signal?: AbortSignal;
    readonly retry?: unknown;
    [key: string]: unknown;
  };
  /** AbortSignal for the request. Propagated from caller options. */
  signal?: AbortSignal;
  /** The HTTP response object — set after `next()` resolves successfully. */
  response?: Response;
  /** Round-trip duration in milliseconds — set after `next()` resolves. */
  durationMs?: number;
  /** Error thrown by the fetch or a downstream middleware — set on failure. */
  error?: unknown;
  /**
   * Set to `true` when the error originated from within the middleware chain
   * (as opposed to from the real fetch). Used by the transport to wrap
   * middleware errors as `SDKError{kind:'unknown'}`.
   */
  middlewareError?: boolean;
  /**
   * Name (or index) of the middleware that was active when the error occurred.
   * Set alongside `middlewareError` for error identity in cause objects.
   */
  activeMiddlewareName?: string;
}

/**
 * A transport middleware function.
 *
 * @param ctx  - Shared mutable context for the request/response cycle.
 * @param next - Calls the next middleware (or the real fetch at the end).
 */
export type TransportMiddleware = (
  ctx: TransportContext,
  next: () => Promise<void>,
) => Promise<void>;

/**
 * Build a composed middleware executor from an ordered array of middleware.
 * The last item in the chain calls the real fetch via `innerFetch`.
 *
 * Returns a function that:
 *  1. Mutates `ctx.headers` with any header overrides from middleware.
 *  2. Calls through the chain.
 *  3. Sets `ctx.response`, `ctx.durationMs`, or `ctx.error` on the context.
 *
 * @param middleware - Ordered list of middleware functions.
 * @param innerFetch - The real fetch call wrapped at the end of the chain.
 */
export function composeMiddleware(
  middleware: readonly TransportMiddleware[],
  innerFetch: (ctx: TransportContext) => Promise<Response>,
): (ctx: TransportContext) => Promise<void> {
  return async (ctx: TransportContext): Promise<void> => {
    let index = -1;

    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) {
        throw new Error('next() called multiple times in transport middleware');
      }
      index = i;

      if (i < middleware.length) {
        const mw = middleware[i];
        const mwName = mw.name || String(i);
        ctx.activeMiddlewareName = mwName;
        try {
          await mw(ctx, () => dispatch(i + 1));
        } catch (err) {
          // Mark that the error originated from this middleware (not the real fetch).
          ctx.middlewareError = true;
          ctx.activeMiddlewareName = mwName;
          throw err;
        }
      } else {
        // End of chain — execute the real fetch.
        const sendAt = Date.now();
        try {
          ctx.response = await innerFetch(ctx);
          ctx.durationMs = Date.now() - sendAt;
        } catch (err) {
          ctx.error = err;
          ctx.durationMs = Date.now() - sendAt;
          throw err;
        }
      }
    };

    await dispatch(0);
  };
}
