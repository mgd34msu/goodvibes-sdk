import { describe, expect, test } from 'bun:test';

/**
 * OBS-02: Auth events — verifies that auth-related metric counters exist and
 * that the RuntimeMeter Counter instruments use the correct API.
 */
describe('obs-02 auth events', () => {
  test('authSuccessTotal and authFailureTotal counters are exported from metrics', async () => {
    const mod = await import('../packages/sdk/src/_internal/platform/runtime/metrics.js');
    expect(mod.authSuccessTotal).toBeDefined();
    expect(mod.authFailureTotal).toBeDefined();
  });

  test('authSuccessTotal counter supports add()', async () => {
    const { authSuccessTotal } = await import('../packages/sdk/src/_internal/platform/runtime/metrics.js');
    const before = authSuccessTotal.value();
    authSuccessTotal.add(1);
    expect(authSuccessTotal.value()).toBe(before + 1);
  });

  test('authFailureTotal counter supports add()', async () => {
    const { authFailureTotal } = await import('../packages/sdk/src/_internal/platform/runtime/metrics.js');
    const before = authFailureTotal.value();
    authFailureTotal.add(1);
    expect(authFailureTotal.value()).toBe(before + 1);
  });

  test('counter value() returns 0 for unknown labels', async () => {
    const { authSuccessTotal } = await import('../packages/sdk/src/_internal/platform/runtime/metrics.js');
    // An unlabeled key that was never set returns 0
    expect(authSuccessTotal.value({ auth_method: 'never-used-label-xyz' })).toBe(0);
  });
});
