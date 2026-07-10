import { describe, expect, test, afterEach } from 'bun:test';

/**
 * Provider-level STREAM_RETRY wiring — verifies that ChatRequest.onRetry (threaded
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

describe('provider chat onRetry wiring', () => {
  test('AnthropicCompatProvider.chat calls onRetry once on a 503 then succeeds', async () => {
    const { AnthropicCompatProvider } = await import('../packages/sdk/src/platform/providers/anthropic-compat.js');

    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('service unavailable', { status: 503 });
      }
      return new Response(SSE_BODY, { status: 200 });
    }) as typeof fetch;

    const provider = new AnthropicCompatProvider({
      name: 'test-compat',
      baseURL: 'https://example.invalid/v1',
      apiKey: 'test-key',
      defaultModel: 'claude-test',
      models: ['claude-test'],
      // Deterministic clock: zero the backoff so the retry fires immediately.
      // maxRetries is left at DEFAULT_CONFIG (3), which the maxAttempts assertion
      // below still depends on — only the wall-clock delay is removed.
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

    expect(callCount).toBe(2);
    expect(response.content).toBe('hi');
    expect(retryCalls.length).toBe(1);
    expect(retryCalls[0]!.attempt).toBe(1);
    expect(retryCalls[0]!.maxAttempts).toBe(3); // withRetry DEFAULT_CONFIG.maxRetries
    expect(retryCalls[0]!.error.message).toContain('503');
  });

  test('AnthropicCompatProvider.chat does not call onRetry on a non-retryable 400', async () => {
    const { AnthropicCompatProvider } = await import('../packages/sdk/src/platform/providers/anthropic-compat.js');

    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response('bad request', { status: 400 });
    }) as typeof fetch;

    const provider = new AnthropicCompatProvider({
      name: 'test-compat-400',
      baseURL: 'https://example.invalid/v1',
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
    expect(callCount).toBe(1);
    expect(onRetryCalls).toBe(0);
  });
});
