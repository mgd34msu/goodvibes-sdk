import { describe, expect, test } from 'bun:test';

/**
 * OBS-21: Companion pairing — verifies that the normalizeError pipeline handles
 * companion/pairing errors without leaking sensitive tokens in output.
 */
describe('obs-21 companion pairing', () => {
  test('normalizeError does not expose Bearer token in summary', async () => {
    const { normalizeError } = await import('../packages/sdk/src/_internal/platform/utils/error-display.js');
    const err = new Error('Auth failed: Bearer sk-ant-abc123xyz Bearer sk-prod-999 is invalid');
    const result = normalizeError(err);
    expect(result.summary).not.toContain('sk-ant-abc123xyz');
    expect(result.summary).not.toContain('sk-prod-999');
  });

  test('normalizeError infers network category for ECONNREFUSED errors', async () => {
    const { normalizeError } = await import('../packages/sdk/src/_internal/platform/utils/error-display.js');
    // Must match NETWORK_ERROR_PATTERNS (ECONNREFUSED pattern)
    const err = new Error('ECONNREFUSED 127.0.0.1:3210');
    const result = normalizeError(err);
    expect(result.category).toBe('network');
  });

  test('summarizeError for pairing timeout produces user-facing message', async () => {
    const { summarizeError } = await import('../packages/sdk/src/_internal/platform/utils/error-display.js');
    const err = new Error('ETIMEDOUT: companion pairing handshake');
    const result = summarizeError(err);
    expect(result).toContain('timed out');
  });
});
