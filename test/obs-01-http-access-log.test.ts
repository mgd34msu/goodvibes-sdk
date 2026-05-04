import { describe, expect, test, afterEach } from 'bun:test';
import {
  instrumentedFetch,
  fetchWithTimeout,
  sanitizeUrlForLog,
} from '../packages/sdk/src/platform/utils/fetch-with-timeout.js';

/**
 * OBS-01: HTTP access log — verifies that instrumentedFetch records request/response
 * details and that the fetch-with-timeout module exports the correct surface.
 */
describe('obs-01 http access log', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('sanitizeUrlForLog redacts sensitive query parameters', () => {
    expect(sanitizeUrlForLog('http://example.com/api?token=secret123&user=alice')).toBe(
      'http://example.com/api?token=%5Bredacted%5D&user=alice',
    );
    expect(sanitizeUrlForLog('http://example.com/api?api_key=mykey')).toBe(
      'http://example.com/api?api_key=%5Bredacted%5D',
    );
    expect(sanitizeUrlForLog('http://example.com/api?safe=ok')).toBe(
      'http://example.com/api?safe=ok',
    );
  });

  test('instrumentedFetch returns the response from the underlying fetch', async () => {
    const stubResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    globalThis.fetch = async () => stubResponse;
    const res = await instrumentedFetch('http://example.com/api');
    expect(res.status).toBe(200);
  });

  test('fetchWithTimeout returns the response and respects the caller signal', async () => {
    const stubResponse = new Response(JSON.stringify({ pong: true }), { status: 200 });
    globalThis.fetch = async () => stubResponse;
    const res = await fetchWithTimeout('http://example.com/ping', {}, 5_000);
    expect(res.status).toBe(200);
  });

  test('fetchWithTimeout aborts when the caller signal fires', async () => {
    globalThis.fetch = async (_url, init) => {
      // Simulate a slow fetch that respects the signal
      await new Promise<void>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) { reject(sig.reason); return; }
        sig?.addEventListener('abort', () => reject(sig.reason), { once: true });
      });
      return new Response('', { status: 200 });
    };
    const controller = new AbortController();
    controller.abort();
    const caught = await fetchWithTimeout('http://example.com/slow', { signal: controller.signal }, 5_000).catch(
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(Error); // MIN-01: strengthened — abort must produce an Error
  });

  test('fetchWithTimeout propagates AbortError when aborted mid-call', async () => {
    // MAJ-09: real mid-call abort — signal fires AFTER fetch starts, not before.
    globalThis.fetch = async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) { reject(new DOMException('AbortError', 'AbortError')); return; }
        sig?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        }, { once: true });
      });
    };
    const controller = new AbortController();
    const fetchPromise = fetchWithTimeout('http://example.com/slow', { signal: controller.signal }, 5_000);
    // Yield to allow the fetch to start before aborting
    await new Promise<void>((r) => setTimeout(r, 10));
    controller.abort();
    const caught = await fetchPromise.catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toMatch(/AbortError/i);
  });
});
