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
