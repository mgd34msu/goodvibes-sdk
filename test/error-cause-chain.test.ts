import { describe, expect, test } from 'bun:test';
import { GoodVibesSdkError } from '../packages/errors/src/index.js';
import { AppError } from '../packages/sdk/src/platform/types/errors.js';
import {
  buildErrorResponseBody,
  normalizeError,
} from '../packages/sdk/src/platform/utils/error-display.js';

/**
 * Error cause chain — verifies that NormalizedError preserves all
 * error metadata fields and that normalizeError correctly maps AppError cause chains.
 * AppError constructor: (message: string, code: string, recoverable: boolean, options?: AppErrorOptions)
 */
describe('error cause chain', () => {
  test('NormalizedError interface fields are present on normalizeError output', async () => {
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
    // AppError(message, code, recoverable, options)
    const err = new AppError('Rate limited', 'RATE_LIMITED', true, { statusCode: 429 });
    const result = normalizeError(err);
    expect(result.recoverable).toBe(true);
    expect(result.statusCode).toBe(429);
  });

  test('normalizeError maps AppError with provider and operation metadata', async () => {
    const err = new AppError('Provider timeout', 'PROVIDER_TIMEOUT', false, { provider: 'openai', operation: 'chat' });
    const result = normalizeError(err);
    expect(result.provider).toBe('openai');
    expect(result.operation).toBe('chat');
    expect(result.recoverable).toBe(false);
  });

  test('buildErrorResponseBody includes all standard fields', async () => {
    const result = buildErrorResponseBody(new Error('downstream fail'));
    expect(typeof result.error).toBe('string');
    expect(typeof result.category).toBe('string');
    expect(typeof result.source).toBe('string');
    expect(typeof result.recoverable).toBe('boolean');
  });

  test('GoodVibesSdkError infers a better category from nested causes without an HTTP status', async () => {
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
    type RecursiveCause = { cause?: RecursiveCause };
    const loop: RecursiveCause = {};
    loop.cause = loop;
    const wrapped = new GoodVibesSdkError('cyclic wrapper', { cause: loop });

    expect(wrapped.category).toBe('unknown');
    expect(wrapped.kind).toBe('unknown');
  });
});
