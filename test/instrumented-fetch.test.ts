import { describe, expect, test } from 'bun:test';

/**
 * instrumentedFetch migration, verifies instrumentedFetch has the same
 * call signature as the native fetch and is reachable from the platform utils.
 */
describe('instrumentedFetch migration', () => {
  // N-2: URL redaction, sensitive params are replaced with [redacted] in logged URL
  test('sanitizeUrlForLog redacts sensitive query params', async () => {
    const { sanitizeUrlForLog } = await import('../packages/sdk/src/platform/utils/fetch-with-timeout.js');
    const input = 'https://api.example.com/v1/chat?api_key=SECRET&token=TOKEN&foo=bar';
    const safe = sanitizeUrlForLog(input);
    expect(safe).toContain('api_key=%5Bredacted%5D');
    expect(safe).toContain('token=%5Bredacted%5D');
    expect(safe).toContain('foo=bar');
    expect(safe).not.toContain('SECRET');
    expect(safe).not.toContain('TOKEN');
  });

  test('sanitizeUrlForLog preserves non-sensitive query params', async () => {
    const { sanitizeUrlForLog } = await import('../packages/sdk/src/platform/utils/fetch-with-timeout.js');
    const input = 'https://api.example.com/v1/models?version=2&stream=true';
    const safe = sanitizeUrlForLog(input);
    expect(safe).toContain('version=2');
    expect(safe).toContain('stream=true');
  });

  test('sanitizeUrlForLog handles URL with no query params', async () => {
    const { sanitizeUrlForLog } = await import('../packages/sdk/src/platform/utils/fetch-with-timeout.js');
    const input = 'https://api.example.com/v1/models';
    const safe = sanitizeUrlForLog(input);
    expect(safe).toBe('https://api.example.com/v1/models');
  });
});
