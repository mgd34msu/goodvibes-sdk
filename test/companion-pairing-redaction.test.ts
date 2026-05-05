import { describe, expect, test } from 'bun:test';

/**
 * Error normalize/summarize redaction smoke — verifies that the
 * normalizeError and summarizeError pipeline handles errors without leaking
 * sensitive tokens in output. Tests use companion/pairing-style error messages.
 *
 * NOTE: This file does NOT test pairing.request / pairing.verify flows.
 * COVERAGE.md has been updated to reflect the actual scope.
 */
describe('normalize/summarize redaction smoke', () => {
  test('normalizeError does not expose Bearer token in summary', async () => {
    const { normalizeError } = await import('../packages/sdk/src/platform/utils/error-display.js');
    const err = new Error('Auth failed: Bearer sk-ant-abc123xyz Bearer sk-prod-999 is invalid');
    const result = normalizeError(err);
    expect(result.summary).not.toContain('sk-ant-abc123xyz');
    expect(result.summary).not.toContain('sk-prod-999');
  });

  test('normalizeError infers network category for ECONNREFUSED errors', async () => {
    const { normalizeError } = await import('../packages/sdk/src/platform/utils/error-display.js');
    // Must match NETWORK_ERROR_PATTERNS (ECONNREFUSED pattern)
    // Port 3000 used deliberately (not the daemon default) — the ECONNREFUSED
    // pattern match does not depend on the port number.
    const err = new Error('ECONNREFUSED 127.0.0.1:3000');
    const result = normalizeError(err);
    expect(result.category).toBe('network');
  });

  test('summarizeError for pairing timeout produces user-facing message', async () => {
    const { summarizeError } = await import('../packages/sdk/src/platform/utils/error-display.js');
    const err = new Error('ETIMEDOUT: companion pairing handshake');
    const result = summarizeError(err);
    expect(result).toContain('timed out');
  });
});
