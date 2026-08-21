import { describe, expect, test, afterEach } from 'bun:test';

/**
 * Provider-level STREAM_RETRY wiring, verifies that ChatRequest.onRetry (threaded
 * through withRetry at the provider's own transport retry point) fires with the
 * right (attempt, maxAttempts, delayMs, error) shape when a retryable transport
 * error is followed by a successful attempt, and that non-retryable errors never
 * invoke it. Uses AnthropicCompatProvider since its chat() talks to `fetch`
 * directly, so failures/successes can be simulated without a real network call.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SSE_BODY = [
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
  '',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
  '',
  '',
].join('\n');

/**
 * Install a fake `globalThis.fetch` that answers, and counts, ONLY requests
 * aimed at `baseURL`.
 *
 * `globalThis.fetch` is process-wide, and this suite runs every file in ONE
 * process. Other files leave background work running (reconnect loops, pollers,
 * schedulers) that keeps calling fetch, and a fake that counts every call
 * counts theirs too. Observed in a loaded full-suite run: this file's
 * `expect(callCount).toBe(2)` reported `Received: 4962`. The number is not a
 * property of the provider under test at all, it is a property of what else
 * happened to be running.
 *
 * Scoping by URL keeps the assertions exact (they still pin the provider to an
 * exact call count) while making them independent of the rest of the process.
 * Anything aimed elsewhere gets a non-retryable 404 rather than this file's
 * canned response, so a stray caller fails immediately instead of being handed
 * a body meant for someone else and looping on it.
 */
function installScopedFetch(
  baseURL: string,
  respond: (attempt: number) => Response,
): { readonly count: () => number } {
  let callCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(baseURL)) {
      return new Response('not this test\'s request', { status: 404 });
    }
    callCount += 1;
    return respond(callCount);
  }) as typeof fetch;
  return { count: () => callCount };
}

describe('provider chat onRetry wiring', () => {
  test('AnthropicCompatProvider.chat calls onRetry once on a 503 then succeeds', async () => {
    const { AnthropicCompatProvider } = await import('../packages/sdk/src/platform/providers/anthropic-compat.js');

    const BASE_URL = 'https://example.invalid/v1';
    const fetched = installScopedFetch(BASE_URL, (attempt) =>
      attempt === 1
        ? new Response('service unavailable', { status: 503 })
        : new Response(SSE_BODY, { status: 200 }));

    const provider = new AnthropicCompatProvider({
      name: 'test-compat',
      baseURL: BASE_URL,
      apiKey: 'test-key',
      defaultModel: 'claude-test',
      models: ['claude-test'],
      // Deterministic clock: zero the backoff so the retry fires immediately.
      // maxRetries is left at DEFAULT_CONFIG (3), which the maxAttempts assertion
      // below still depends on, only the wall-clock delay is removed.
      retryConfig: { initialDelayMs: 0, maxDelayMs: 0 },
    });

    const retryCalls: Array<{ attempt: number; maxAttempts: number; delayMs: number; error: Error }> = [];
    const response = await provider.chat({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hello' }],
      onRetry: (attempt, maxAttempts, delayMs, error) => {
        retryCalls.push({ attempt, maxAttempts, delayMs, error });
      },
    });

    expect(fetched.count()).toBe(2);
    expect(response.content).toBe('hi');
    expect(retryCalls.length).toBe(1);
    expect(retryCalls[0]!.attempt).toBe(1);
    expect(retryCalls[0]!.maxAttempts).toBe(3); // withRetry DEFAULT_CONFIG.maxRetries
    expect(retryCalls[0]!.error.message).toContain('503');
  });

  test('AnthropicCompatProvider.chat does not call onRetry on a non-retryable 400', async () => {
    const { AnthropicCompatProvider } = await import('../packages/sdk/src/platform/providers/anthropic-compat.js');

    const BASE_URL = 'https://example.invalid/v1';
    const fetched = installScopedFetch(BASE_URL, () => new Response('bad request', { status: 400 }));

    const provider = new AnthropicCompatProvider({
      name: 'test-compat-400',
      baseURL: BASE_URL,
      apiKey: 'test-key',
      defaultModel: 'claude-test',
      models: ['claude-test'],
    });

    let onRetryCalls = 0;
    const promise = provider.chat({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hello' }],
      onRetry: () => { onRetryCalls++; },
    });

    await expect(promise).rejects.toThrow();
    expect(fetched.count()).toBe(1);
    expect(onRetryCalls).toBe(0);
  });
});
