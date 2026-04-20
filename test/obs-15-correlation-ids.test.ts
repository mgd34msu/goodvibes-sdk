import { describe, expect, test } from 'bun:test';

/**
 * OBS-15: Correlation IDs — verifies AsyncLocalStorage-based correlation context
 * propagation across synchronous and asynchronous boundaries.
 */
describe('obs-15 correlation ids', () => {
  test('getCorrelationContext returns empty object when no context is active', async () => {
    const { getCorrelationContext } = await import('../packages/sdk/src/_internal/platform/runtime/correlation.js');
    const ctx = getCorrelationContext();
    expect(ctx).toBeDefined();
    expect(typeof ctx).toBe('object');
  });

  test('withCorrelation provides context within the callback', async () => {
    const { withCorrelation, getCorrelationContext } = await import('../packages/sdk/src/_internal/platform/runtime/correlation.js');
    let captured: ReturnType<typeof getCorrelationContext> = {};
    withCorrelation({ requestId: 'req-abc' }, () => {
      captured = getCorrelationContext();
    });
    expect(captured.requestId).toBe('req-abc');
  });

  test('withCorrelationAsync propagates context through await', async () => {
    const { withCorrelationAsync, getCorrelationContext } = await import('../packages/sdk/src/_internal/platform/runtime/correlation.js');
    let captured: ReturnType<typeof getCorrelationContext> = {};
    await withCorrelationAsync({ sessionId: 'sess-xyz' }, async () => {
      await Promise.resolve();
      captured = getCorrelationContext();
    });
    expect(captured.sessionId).toBe('sess-xyz');
  });

  test('nested withCorrelation merges parent context', async () => {
    const { withCorrelation, getCorrelationContext } = await import('../packages/sdk/src/_internal/platform/runtime/correlation.js');
    let captured: ReturnType<typeof getCorrelationContext> = {};
    withCorrelation({ requestId: 'outer' }, () => {
      withCorrelation({ sessionId: 'inner-sess' }, () => {
        captured = getCorrelationContext();
      });
    });
    expect(captured.requestId).toBe('outer');
    expect(captured.sessionId).toBe('inner-sess');
  });

  test('context does not leak outside the callback', async () => {
    const { withCorrelation, getCorrelationContext } = await import('../packages/sdk/src/_internal/platform/runtime/correlation.js');
    withCorrelation({ requestId: 'ephemeral' }, () => { /* nothing */ });
    const ctx = getCorrelationContext();
    expect(ctx.requestId).toBeUndefined();
  });

  // Integration: buildAttributes in api-helpers merges correlation context into event attributes
  test('buildAttributes includes requestId from active correlation context', async () => {
    const { withCorrelation } = await import('../packages/sdk/src/_internal/platform/runtime/correlation.js');
    const { buildAttributes } = await import('../packages/sdk/src/_internal/platform/runtime/telemetry/api-helpers.js');
    let captured: Record<string, unknown> = {};
    withCorrelation({ requestId: 'integ-req-001' }, () => {
      captured = buildAttributes('session', {
        type: 'SESSION_STARTED',
        source: 'test',
        traceId: 'trace-1',
        sessionId: 'sess-1',
      } as Parameters<typeof buildAttributes>[1], {});
    });
    expect(captured['requestId']).toBe('integ-req-001');
  });

  // Integration: two concurrent correlation contexts carry independent requestIds
  test('concurrent withCorrelationAsync contexts have independent requestIds', async () => {
    const { withCorrelationAsync, getCorrelationContext } = await import('../packages/sdk/src/_internal/platform/runtime/correlation.js');
    const ids: string[] = [];
    await Promise.all([
      withCorrelationAsync({ requestId: 'req-A' }, async () => {
        await Promise.resolve();
        ids.push(getCorrelationContext().requestId ?? 'missing');
      }),
      withCorrelationAsync({ requestId: 'req-B' }, async () => {
        await Promise.resolve();
        ids.push(getCorrelationContext().requestId ?? 'missing');
      }),
    ]);
    expect(ids).toContain('req-A');
    expect(ids).toContain('req-B');
    expect(ids.length).toBe(2);
  });
});
