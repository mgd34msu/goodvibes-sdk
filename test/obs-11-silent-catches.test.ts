import { describe, expect, test } from 'bun:test';

/**
 * OBS-11: Silent catches — verifies that normalizeError and summarizeError never
 * swallow exceptions silently and always return usable output.
 */
describe('obs-11 silent catches', () => {
  test('normalizeError handles non-Error throwables (string)', async () => {
    const { normalizeError } = await import('../packages/sdk/src/platform/utils/error-display.js');
    const result = normalizeError('raw string error');
    expect(result.name).toBe('Error');
    expect(result.message).toBe('raw string error');
  });

  test('normalizeError handles null throwable', async () => {
    const { normalizeError } = await import('../packages/sdk/src/platform/utils/error-display.js');
    const result = normalizeError(null);
    expect(typeof result.message).toBe('string');
  });

  test('normalizeError handles undefined throwable', async () => {
    const { normalizeError } = await import('../packages/sdk/src/platform/utils/error-display.js');
    const result = normalizeError(undefined);
    expect(typeof result.message).toBe('string');
  });

  test('normalizeError extracts statusCode from plain object with statusCode', async () => {
    const { normalizeError } = await import('../packages/sdk/src/platform/utils/error-display.js');
    const result = normalizeError({ statusCode: 503, message: 'Service Unavailable' });
    // statusCode is extracted but recoverable=false for non-AppError objects
    expect(result.statusCode).toBe(503);
    expect(typeof result.recoverable).toBe('boolean');
  });

  test('summarizeError never throws for any input type', async () => {
    const { summarizeError } = await import('../packages/sdk/src/platform/utils/error-display.js');
    const inputs = [null, undefined, '', 0, false, [], {}, new Error('x'), 'string error', { code: 'E_FAIL' }];
    for (const input of inputs) {
      expect(() => summarizeError(input)).not.toThrow();
    }
  });
});
