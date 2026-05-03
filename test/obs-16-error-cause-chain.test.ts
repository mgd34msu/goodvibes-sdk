import { describe, expect, test } from 'bun:test';

/**
 * OBS-16: Error cause chain — verifies that NormalizedError preserves all
 * error metadata fields and that normalizeError correctly maps AppError cause chains.
 * AppError constructor: (message: string, code: string, recoverable: boolean, options?: AppErrorOptions)
 */
describe('obs-16 error cause chain', () => {
  test('NormalizedError interface fields are present on normalizeError output', async () => {
    const { normalizeError } = await import('../packages/sdk/src/_internal/platform/utils/error-display.js');
    const err = new Error('base error');
    const result = normalizeError(err);
    expect('name' in result).toBe(true);
    expect('message' in result).toBe(true);
    expect('summary' in result).toBe(true);
    expect('category' in result).toBe(true);
    expect('source' in result).toBe(true);
    expect('recoverable' in result).toBe(true);
  });

  test('normalizeError maps AppError with recoverable=true and statusCode', async () => {
    const { normalizeError } = await import('../packages/sdk/src/_internal/platform/utils/error-display.js');
    const { AppError } = await import('../packages/sdk/src/_internal/platform/types/errors.js');
    // AppError(message, code, recoverable, options)
    const err = new AppError('Rate limited', 'RATE_LIMITED', true, { statusCode: 429 });
    const result = normalizeError(err);
    expect(result.recoverable).toBe(true);
    expect(result.statusCode).toBe(429);
  });

  test('normalizeError maps AppError with provider and operation metadata', async () => {
    const { normalizeError } = await import('../packages/sdk/src/_internal/platform/utils/error-display.js');
    const { AppError } = await import('../packages/sdk/src/_internal/platform/types/errors.js');
    const err = new AppError('Provider timeout', 'PROVIDER_TIMEOUT', false, { provider: 'openai', operation: 'chat' });
    const result = normalizeError(err);
    expect(result.provider).toBe('openai');
    expect(result.operation).toBe('chat');
    expect(result.recoverable).toBe(false);
  });

  test('buildErrorResponseBody includes all standard fields', async () => {
    const { buildErrorResponseBody } = await import('../packages/sdk/src/_internal/platform/utils/error-display.js');
    const result = buildErrorResponseBody(new Error('downstream fail'));
    expect(typeof result.error).toBe('string');
    expect(typeof result.category).toBe('string');
    expect(typeof result.source).toBe('string');
    expect(typeof result.recoverable).toBe('boolean');
  });

  test('GoodVibesSdkError infers a better category from nested causes without an HTTP status', async () => {
    const { GoodVibesSdkError } = await import('../packages/errors/src/index.js');
    const wrapped = new GoodVibesSdkError('middleware wrapper', {
      cause: {
        originalError: {
          category: 'rate_limit',
          message: 'provider throttled the request',
        },
      },
    });

    expect(wrapped.category).toBe('rate_limit');
    expect(wrapped.kind).toBe('rate-limit');
  });

  test('GoodVibesSdkError cause category inference is cycle-safe', async () => {
    const { GoodVibesSdkError } = await import('../packages/errors/src/index.js');
    const loop: Record<string, unknown> = {};
    loop.cause = loop;
    const wrapped = new GoodVibesSdkError('cyclic wrapper', { cause: loop });

    expect(wrapped.category).toBe('unknown');
    expect(wrapped.kind).toBe('unknown');
  });
});
