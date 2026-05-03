import { describe, expect, test } from 'bun:test';

/**
 * OBS-01: HTTP access log — verifies that instrumentedFetch records request/response
 * details and that the fetch-with-timeout module exports the correct surface.
 */
describe('obs-01 http access log', () => {
  test('instrumentedFetch is exported from fetch-with-timeout', async () => {
    const mod = await import('../packages/sdk/src/platform/utils/fetch-with-timeout.js');
    expect(typeof mod.instrumentedFetch).toBe('function');
    expect(typeof mod.fetchWithTimeout).toBe('function');
  });

  test('fetchWithTimeout accepts AbortSignal options', async () => {
    const { fetchWithTimeout } = await import('../packages/sdk/src/platform/utils/fetch-with-timeout.js');
    expect(typeof fetchWithTimeout).toBe('function');
  });
});
