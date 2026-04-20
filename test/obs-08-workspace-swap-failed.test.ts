import { describe, expect, test } from 'bun:test';

/**
 * OBS-08: Workspace swap failed event — verifies that the normalizeError path
 * correctly handles workspace-swap-related errors through the error display pipeline.
 */
describe('obs-08 workspace swap failed', () => {
  test('normalizeError handles workspace errors without throwing', async () => {
    const { normalizeError } = await import('../packages/sdk/src/_internal/platform/utils/error-display.js');
    const err = new Error('Workspace swap failed: target directory not found');
    const result = normalizeError(err);
    expect(result.name).toBe('Error');
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
  });

  test('normalizeError infers recoverable=false for unknown errors', async () => {
    const { normalizeError } = await import('../packages/sdk/src/_internal/platform/utils/error-display.js');
    const err = new Error('Unexpected swap state');
    const result = normalizeError(err);
    expect(result.recoverable).toBe(false);
  });

  test('summarizeError returns a non-empty string', async () => {
    const { summarizeError } = await import('../packages/sdk/src/_internal/platform/utils/error-display.js');
    const result = summarizeError(new Error('workspace gone'));
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
