import { logger } from './logger.js';

/**
 * Sensitive query-parameter keys to strip from logged URLs.
 * Values are replaced with "[redacted]" in OUTBOUND_HTTP log entries.
 */
const SENSITIVE_PARAMS = new Set([
  'key', 'api_key', 'apikey', 'token', 'secret',
  'access_token', 'apiToken', 'api-key',
]);

/**
 * Sanitize a URL for logging: strip query params that might contain secrets.
 */
export function sanitizeUrlForLog(url: string | URL | Request): string {
  try {
    const raw = url instanceof Request ? url.url : String(url);
    const parsed = new URL(raw);
    for (const key of parsed.searchParams.keys()) {
      if (SENSITIVE_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, '[redacted]');
      }
    }
    return `${parsed.origin}${parsed.pathname}${parsed.search ? parsed.search : ''}`;
  } catch {
    return '[unparseable-url]';
  }
}

/**
 * instrumentedFetch — wraps the global fetch with structured OUTBOUND_HTTP logging.
 *
 * Use this in place of bare `fetch()` for non-streaming outbound HTTP calls where
 * observability is required. For streaming calls (SSE/chat completions) where the
 * caller already manages an AbortController, use fetch() directly — those streams
 * manage their own lifecycle and do not benefit from this wrapper.
 *
 * @param url    - The URL or Request to fetch.
 * @param init   - Standard RequestInit (optional).
 */
export async function instrumentedFetch(
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const startMs = Date.now();
  const method = init?.method ?? 'GET';
  const safeUrl = sanitizeUrlForLog(url);
  let status = -1;
  try {
    const res = await fetch(url, init);
    status = res.status;
    return res;
  } finally {
    logger.info('OUTBOUND_HTTP', {
      type: 'OUTBOUND_HTTP',
      method,
      url: safeUrl,
      status,
      latencyMs: Date.now() - startMs,
    });
  }
}

/**
 * fetchWithTimeout — wraps the global fetch with an AbortController timeout.
 *
 * If the caller passes a signal that is already aborted, the request is
 * rejected immediately. When both a caller signal and the internal timeout
 * controller are present, they are merged via AbortSignal.any so that
 * whichever fires first wins.
 *
 * Streaming fetches (SSE, chat completions) where the caller already manages
 * an AbortController via ChatRequest.signal should NOT use this helper —
 * pass the signal directly to fetch() as they already do.
 *
 * @param url       - The URL or Request to fetch.
 * @param init      - Standard RequestInit (optional).
 * @param timeoutMs - Milliseconds before aborting. Default: 30 000.
 */
export async function fetchWithTimeout(
  url: string | URL | Request,
  init?: RequestInit,
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  timer.unref?.();

  let signal: AbortSignal;
  const callerSignal = init?.signal;
  if (callerSignal) {
    // Merge caller signal + our timeout: first one to fire wins
    signal = AbortSignal.any([callerSignal, controller.signal]);
  } else {
    signal = controller.signal;
  }

  try {
    return await fetch(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}
