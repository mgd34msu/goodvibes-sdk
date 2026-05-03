import { describe, expect, test } from 'bun:test';

/**
 * OBS-22: Telemetry label allowlist — verifies that METRIC_LABEL_ALLOWLIST exists
 * and that filterMetricLabels strips non-allowlisted keys.
 */
describe('obs-22 label allowlist', () => {
  test('METRIC_LABEL_ALLOWLIST is exported and is a Set', async () => {
    const { METRIC_LABEL_ALLOWLIST } = await import('../packages/sdk/src/platform/runtime/telemetry/api-helpers.js');
    expect(METRIC_LABEL_ALLOWLIST).toBeInstanceOf(Set);
    expect(METRIC_LABEL_ALLOWLIST.size).toBe(21);
  });

  test('METRIC_LABEL_ALLOWLIST contains expected low-cardinality keys', async () => {
    const { METRIC_LABEL_ALLOWLIST } = await import('../packages/sdk/src/platform/runtime/telemetry/api-helpers.js');
    expect(METRIC_LABEL_ALLOWLIST.has('domain')).toBe(true);
    expect(METRIC_LABEL_ALLOWLIST.has('provider')).toBe(true);
    expect(METRIC_LABEL_ALLOWLIST.has('status_class')).toBe(true);
    expect(METRIC_LABEL_ALLOWLIST.has('method')).toBe(true);
  });

  test('METRIC_LABEL_ALLOWLIST does not contain high-cardinality keys', async () => {
    const { METRIC_LABEL_ALLOWLIST } = await import('../packages/sdk/src/platform/runtime/telemetry/api-helpers.js');
    // These would cause cardinality explosion in metrics backends
    expect(METRIC_LABEL_ALLOWLIST.has('sessionId')).toBe(false);
    expect(METRIC_LABEL_ALLOWLIST.has('traceId')).toBe(false);
    expect(METRIC_LABEL_ALLOWLIST.has('turnId')).toBe(false);
    expect(METRIC_LABEL_ALLOWLIST.has('agentId')).toBe(false);
    expect(METRIC_LABEL_ALLOWLIST.has('taskId')).toBe(false);
  });

  test('filterMetricLabels strips non-allowlisted keys', async () => {
    const { filterMetricLabels } = await import('../packages/sdk/src/platform/runtime/telemetry/api-helpers.js');
    const input = { domain: 'turn', traceId: 'abc-123', provider: 'openai', taskId: 'task-999' };
    const filtered = filterMetricLabels(input);
    expect(filtered.domain).toBe('turn');
    expect(filtered.provider).toBe('openai');
    expect(filtered.traceId).toBeUndefined();
    expect(filtered.taskId).toBeUndefined();
  });

  test('filterMetricLabels passes all allowlisted keys through', async () => {
    const { filterMetricLabels, METRIC_LABEL_ALLOWLIST } = await import('../packages/sdk/src/platform/runtime/telemetry/api-helpers.js');
    const input: Record<string, string> = {};
    for (const key of METRIC_LABEL_ALLOWLIST) {
      input[key] = 'value';
    }
    const filtered = filterMetricLabels(input);
    for (const key of METRIC_LABEL_ALLOWLIST) {
      expect(filtered[key]).toBe('value');
    }
  });
});
