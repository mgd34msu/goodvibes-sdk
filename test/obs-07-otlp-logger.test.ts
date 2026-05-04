import { describe, expect, test } from 'bun:test';

/**
 * OBS-07: OTLP logger — verifies that OTLP log/trace/metric document builders
 * produce structurally valid output.
 */
describe('obs-07 otlp logger', () => {
  test('buildOtlpLogDocumentFromRecords returns empty resourceLogs for empty array', async () => {
    const { buildOtlpLogDocumentFromRecords } = await import('../packages/sdk/src/platform/runtime/telemetry/api-helpers.js');
    const doc = buildOtlpLogDocumentFromRecords([]);
    expect(doc).toEqual({ resourceLogs: [] });
  });

  test('buildOtlpTraceDocumentFromSpans returns empty resourceSpans for empty array', async () => {
    const { buildOtlpTraceDocumentFromSpans } = await import('../packages/sdk/src/platform/runtime/telemetry/api-helpers.js');
    const doc = buildOtlpTraceDocumentFromSpans([]);
    expect(doc).toEqual({ resourceSpans: [] });
  });

  test('buildOtlpMetricDocumentFromState returns resourceMetrics array', async () => {
    const { buildOtlpMetricDocumentFromState } = await import('../packages/sdk/src/platform/runtime/telemetry/api-helpers.js');
    // Minimal state/aggregates stub
    const state = {
      session: { startedAt: Date.now() },
      tasks: { runningIds: [] },
      agents: { activeAgentIds: [] },
      telemetry: { sessionMetrics: { inputTokens: 0, outputTokens: 0 } },
    } as Parameters<typeof buildOtlpMetricDocumentFromState>[0];
    const aggregates = {
      totalEvents: 0,
      totalSpans: 0,
      byDomain: {},
      errorsByCategory: {},
    } as Parameters<typeof buildOtlpMetricDocumentFromState>[1];
    const doc = buildOtlpMetricDocumentFromState(state, aggregates);
    expect((doc as { resourceMetrics: unknown[] }).resourceMetrics).toBeInstanceOf(Array);
  });
});
