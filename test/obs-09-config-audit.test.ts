import { describe, expect, test } from 'bun:test';

/**
 * OBS-09: Config audit — verifies that the telemetry configuration surface
 * (SERVICE_NAME, limits) is correctly exposed for audit.
 */
describe('obs-09 config audit', () => {
  test('SERVICE_NAME is goodvibes-sdk', async () => {
    const { SERVICE_NAME } = await import('../packages/sdk/src/platform/runtime/telemetry/api-helpers.js');
    expect(SERVICE_NAME).toBe('goodvibes-sdk');
  });

  test('DEFAULT_EVENT_LIMIT is a positive integer', async () => {
    const { DEFAULT_EVENT_LIMIT } = await import('../packages/sdk/src/platform/runtime/telemetry/api-helpers.js');
    expect(Number.isInteger(DEFAULT_EVENT_LIMIT)).toBe(true);
    expect(DEFAULT_EVENT_LIMIT).toBe(500);
  });

  test('DEFAULT_ERROR_LIMIT is a positive integer', async () => {
    const { DEFAULT_ERROR_LIMIT } = await import('../packages/sdk/src/platform/runtime/telemetry/api-helpers.js');
    expect(Number.isInteger(DEFAULT_ERROR_LIMIT)).toBe(true);
    expect(DEFAULT_ERROR_LIMIT).toBe(250);
  });

  test('ALL_DOMAINS array includes transport and turn', async () => {
    const { ALL_DOMAINS } = await import('../packages/sdk/src/platform/runtime/telemetry/api-helpers.js');
    expect(ALL_DOMAINS).toContain('transport');
    expect(ALL_DOMAINS).toContain('turn');
  });
});
