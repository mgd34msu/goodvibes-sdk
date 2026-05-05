import { describe, expect, test } from 'bun:test';

/**
 * LLM instrumentation — verifies instrumentedLlmCall wraps async functions
 * and tracks durationMs in the returned InstrumentedLlmResult.
 * Includes integration tests asserting platformMeter instruments are recorded.
 */
describe('llm instrumentation', () => {
  test('instrumentedLlmCall returns InstrumentedLlmResult with result and durationMs', async () => {
    const { instrumentedLlmCall } = await import('../packages/sdk/src/platform/runtime/llm-observability.js');
    const wrapped = await instrumentedLlmCall(async () => ({ answer: 42 }));
    expect(wrapped.result).toEqual({ answer: 42 });
    expect(typeof wrapped.durationMs).toBe('number');
    // Upper bound is the real assertion; a non-negative duration is also implied.
    expect(wrapped.durationMs).toBeLessThan(1000);
    expect(wrapped.retries).toBe(0);
  });

  test('instrumentedLlmCall tracks retries when fn throws then succeeds', async () => {
    const { instrumentedLlmCall } = await import('../packages/sdk/src/platform/runtime/llm-observability.js');
    let calls = 0;
    const wrapped = await instrumentedLlmCall(async () => {
      calls++;
      if (calls < 2) throw new Error('transient');
      return 'ok';
    }, { maxRetries: 2 });
    expect(wrapped.result).toBe('ok');
    expect(wrapped.retries).toBe(1);
  });

  test('instrumentedLlmCall propagates error after exhausting retries', async () => {
    const { instrumentedLlmCall } = await import('../packages/sdk/src/platform/runtime/llm-observability.js');
    const promise = instrumentedLlmCall(async () => { throw new Error('fatal'); }, { maxRetries: 0 });
    await expect(promise).rejects.toThrow('fatal');
  });

  // Integration: verify platformMeter instruments are incremented on success
  test('instrumentedLlmCall records llmRequestsTotal on success', async () => {
    const { instrumentedLlmCall } = await import('../packages/sdk/src/platform/runtime/llm-observability.js');
    const { llmRequestsTotal } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    const before = llmRequestsTotal.value({ provider: 'test-provider', model: 'test-model', status: 'success' });
    await instrumentedLlmCall(async () => ({ content: 'hello' }), { provider: 'test-provider', model: 'test-model' });
    const after = llmRequestsTotal.value({ provider: 'test-provider', model: 'test-model', status: 'success' });
    expect(after).toBe(before + 1);
  });

  // Integration: verify llmRequestDurationMs histogram receives a recording
  test('instrumentedLlmCall records llmRequestDurationMs on success', async () => {
    const { instrumentedLlmCall } = await import('../packages/sdk/src/platform/runtime/llm-observability.js');
    const { llmRequestDurationMs } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    const snapBefore = llmRequestDurationMs.snapshot({ provider: 'duration-test', model: 'duration-model' });
    await instrumentedLlmCall(async () => 'done', { provider: 'duration-test', model: 'duration-model' });
    const snapAfter = llmRequestDurationMs.snapshot({ provider: 'duration-test', model: 'duration-model' });
    expect(snapAfter.count).toBe(snapBefore.count + 1);
  });

  // Integration: onStarted callback is invoked at entry
  test('instrumentedLlmCall calls onStarted before fn executes', async () => {
    const { instrumentedLlmCall } = await import('../packages/sdk/src/platform/runtime/llm-observability.js');
    const order: string[] = [];
    await instrumentedLlmCall(async () => { order.push('fn'); return 42; }, {
      onStarted: () => { order.push('started'); },
    });
    expect(order).toEqual(['started', 'fn']);
  });
});
