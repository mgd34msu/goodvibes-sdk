/**
 * safe-serve.ts — a port-conflict-honest `Bun.serve` wrapper.
 *
 * Wraps ONLY the request-handler (`fetch`) callback in a try/catch that turns
 * a thrown handler failure into a bounded, stack-free JSON 500 instead of an
 * unhandled rejection or a process crash. It deliberately does NOT wrap the
 * outer `Bun.serve(options)` call itself: a bind-time failure (most commonly
 * `EADDRINUSE`, a real port conflict) must propagate to the caller unchanged
 * so the daemon's own port-conflict handling (`isPortAvailable` /
 * `requirePortAvailable` in `./port-check.ts`) sees the real error rather than
 * a wrapper's synthesized one. "Safe" here means "a request handler bug can
 * never take the whole server down"; it does not mean "swallows bind
 * failures" — those stay honest.
 *
 * Lives in the SDK so every daemon host — the standalone daemon binary, its
 * embedded-runtime callers, and the SDK's own `platform/daemon` CLI — shares
 * one implementation instead of each maintaining its own copy of the same
 * wrapper.
 */
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

type HostServeFetch = (
  request: Request,
  server: unknown,
) => Response | undefined | Promise<Response | undefined>;

type HostServeOptions = Parameters<typeof Bun.serve>[0] & {
  fetch?: HostServeFetch;
};

function requestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return request.url;
  }
}

/**
 * Build the bounded, stack-free 500 response for a request handler failure —
 * a real message (for operator diagnosis) with no source snippets or stack
 * frames leaked onto the wire, and the failure logged with method/path.
 */
export function createHostRequestFailureResponse(
  surface: string,
  request: Request,
  error: unknown,
): Response {
  const message = summarizeError(error);
  logger.error(`${surface}: request handler failed`, {
    method: request.method,
    path: requestPath(request),
    error: message,
  });
  return Response.json({
    error: message,
    code: 'HOST_REQUEST_HANDLER_FAILED',
  }, { status: 500 });
}

/**
 * Build a `Bun.serve`-shaped factory that wraps only the `fetch` callback in
 * the failure boundary above. `surface` names the host in log lines and
 * failure responses (e.g. "Daemon HTTP listener", "Control-plane listener") so a
 * multi-listener process can tell which one failed.
 */
export function createSafeHostServeFactory(
  surface: string,
  baseServeFactory: typeof Bun.serve = Bun.serve,
): typeof Bun.serve {
  return ((options: HostServeOptions) => {
    const originalFetch = options.fetch;
    if (typeof originalFetch !== 'function') {
      return baseServeFactory(options as Parameters<typeof Bun.serve>[0]);
    }

    const wrappedFetch: HostServeFetch = async (request, server) => {
      try {
        return await originalFetch(request, server);
      } catch (error) {
        return createHostRequestFailureResponse(surface, request, error);
      }
    };

    return baseServeFactory({
      ...options,
      fetch: wrappedFetch,
    } as Parameters<typeof Bun.serve>[0]);
  }) as typeof Bun.serve;
}
