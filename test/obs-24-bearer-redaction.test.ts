import { describe, expect, test } from 'bun:test';

/**
 * OBS-24: Bearer/token redaction — verifies that redactSensitiveData strips
 * Bearer tokens and API keys from error strings before they appear in logs.
 */
describe('obs-24 bearer redaction', () => {
  test('redactSensitiveData removes Bearer tokens', async () => {
    const { redactSensitiveData } = await import('../packages/sdk/src/platform/utils/redaction.js');
    const input = 'Authorization: Bearer sk-ant-abc123def456';
    const result = redactSensitiveData(input);
    expect(result).not.toContain('sk-ant-abc123def456');
    expect(result).toContain('[REDACTED_TOKEN]');
  });

  test('redactSensitiveData is case-insensitive for Bearer prefix', async () => {
    const { redactSensitiveData } = await import('../packages/sdk/src/platform/utils/redaction.js');
    const input = 'auth header: bearer MYTOKEN12345';
    const result = redactSensitiveData(input);
    expect(result).not.toContain('MYTOKEN12345');
  });

  test('normalizeError redacts Bearer tokens in error message (OBS-24 wiring)', async () => {
    const { normalizeError } = await import('../packages/sdk/src/platform/utils/error-display.js');
    const err = new Error('HTTP 401: Authorization: Bearer sk-secret-key-99 is not valid');
    const result = normalizeError(err);
    expect(result.message).not.toContain('sk-secret-key-99');
    expect(result.summary).not.toContain('sk-secret-key-99');
  });

  test('summarizeError redacts tokens for safe logging', async () => {
    const { summarizeError } = await import('../packages/sdk/src/platform/utils/error-display.js');
    const err = new Error('Auth failed: Bearer token123abc is expired');
    const result = summarizeError(err);
    expect(result).not.toContain('token123abc');
  });

  test('redactSensitiveData preserves non-sensitive content', async () => {
    const { redactSensitiveData } = await import('../packages/sdk/src/platform/utils/redaction.js');
    const input = 'Connection refused to localhost:3000';
    const result = redactSensitiveData(input);
    expect(result).toBe(input);
  });
});
