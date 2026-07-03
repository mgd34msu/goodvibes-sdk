import { describe, expect, test } from 'bun:test';

/**
 * withRetry / isRetryableError — verifies the onRetry callback fires with the
 * (attempt, maxAttempts, delayMs, error) argument order that ChatRequest.onRetry
 * expects (providers pass it straight through with no adapter), that
 * non-retryable errors skip the callback and rethrow immediately, and that the
 * callback fires exactly maxRetries times before the final rejection.
 */
describe('withRetry', () => {
  test('onRetry fires with (attempt, maxAttempts, delayMs, error) on a retryable error', async () => {
    const { withRetry } = await import('../packages/sdk/src/platform/utils/retry.js');
    const { AppError } = await import('../packages/sdk/src/platform/types/errors.js');
    const calls: Array<{ attempt: number; maxAttempts: number; delayMs: number; error: Error }> = [];
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 2) throw new AppError('transient failure', 'TEST_TRANSIENT', true);
        return 'ok';
      },
      { maxRetries: 3, initialDelayMs: 0, maxDelayMs: 0 },
      (attempt, maxAttempts, delayMs, error) => {
        calls.push({ attempt, maxAttempts, delayMs, error });
      },
    );
    expect(result).toBe('ok');
    expect(calls.length).toBe(1);
    expect(calls[0]!.attempt).toBe(1);
    expect(calls[0]!.maxAttempts).toBe(3);
    expect(calls[0]!.delayMs).toBe(0);
    expect(calls[0]!.error.message).toBe('transient failure');
  });

  test('does NOT call onRetry and rethrows immediately on a non-retryable error', async () => {
    const { withRetry } = await import('../packages/sdk/src/platform/utils/retry.js');
    const { AppError } = await import('../packages/sdk/src/platform/types/errors.js');
    let attempts = 0;
    let onRetryCalls = 0;
    const promise = withRetry(
      async () => {
        attempts++;
        throw new AppError('permanent failure', 'TEST_FATAL', false);
      },
      { maxRetries: 3, initialDelayMs: 0, maxDelayMs: 0 },
      () => { onRetryCalls++; },
    );
    await expect(promise).rejects.toThrow('permanent failure');
    expect(attempts).toBe(1);
    expect(onRetryCalls).toBe(0);
  });

  test('fires onRetry maxRetries times before giving up', async () => {
    const { withRetry } = await import('../packages/sdk/src/platform/utils/retry.js');
    const { AppError } = await import('../packages/sdk/src/platform/types/errors.js');
    let attempts = 0;
    let onRetryCalls = 0;
    const promise = withRetry(
      async () => {
        attempts++;
        throw new AppError('always fails', 'TEST_ALWAYS', true);
      },
      { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0 },
      () => { onRetryCalls++; },
    );
    await expect(promise).rejects.toThrow('always fails');
    expect(attempts).toBe(3); // initial attempt + 2 retries
    expect(onRetryCalls).toBe(2);
  });
});
