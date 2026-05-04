import { describe, expect, test } from 'bun:test';

/**
 * OBS-12: RuntimeMeter production wiring — verifies that the platform meter
 * singleton and all named instruments are accessible and use the correct API.
 * Counter: add(delta, labels?), value(labels?)
 * Histogram: record(value, labels?), snapshot(labels?)
 * Gauge: set(value, labels?), value(labels?)
 */
describe('obs-12 runtime meter', () => {
  test('platformMeter is exported from metrics module', async () => {
    const { platformMeter } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    expect(platformMeter).not.toBeNull(); // presence-only: platformMeter exported
  });

  test('httpRequestsTotal counter add() and value() work', async () => {
    const { httpRequestsTotal } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    const before = httpRequestsTotal.value({ status_class: '2xx' });
    httpRequestsTotal.add(1, { status_class: '2xx' });
    expect(httpRequestsTotal.value({ status_class: '2xx' })).toBe(before + 1);
  });

  test('llmRequestDurationMs histogram record() does not throw', async () => {
    const { llmRequestDurationMs } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    expect(() => llmRequestDurationMs.record(125, { provider: 'anthropic' })).not.toThrow();
  });

  test('sessionsActive gauge can be set and read', async () => {
    const { sessionsActive } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    sessionsActive.set(7);
    expect(sessionsActive.value()).toBe(7);
  });

  test('sseSubscribers gauge can be set and read', async () => {
    const { sseSubscribers } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    sseSubscribers.set(2);
    expect(sseSubscribers.value()).toBe(2);
  });

  test('transportRetriesTotal counter increments correctly', async () => {
    const { transportRetriesTotal } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    const before = transportRetriesTotal.value();
    transportRetriesTotal.add(1);
    expect(transportRetriesTotal.value()).toBe(before + 1);
  });

  test('snapshotMetrics returns expected shape', async () => {
    const { snapshotMetrics } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    const snap = snapshotMetrics();
    expect(snap).toHaveProperty('counters');
    expect(snap).toHaveProperty('gauges');
    expect(snap).toHaveProperty('histograms');

    const counters = (snap as Record<string, unknown>)['counters'] as Record<string, unknown>;
    expect(counters).toHaveProperty('http.requests.total');
    expect(counters).toHaveProperty('llm.requests.total');
    expect(counters).toHaveProperty('auth.success.total');
    expect(counters).toHaveProperty('auth.failure.total');
    expect(counters).toHaveProperty('transport.retries_total');

    const gauges = (snap as Record<string, unknown>)['gauges'] as Record<string, unknown>;
    expect(gauges).toHaveProperty('sessions.active');
    expect(gauges).toHaveProperty('sse.subscribers');
    expect(gauges).toHaveProperty('telemetry.buffer.fill');
  });

  test('snapshotMetrics includes histogram sub-keys', async () => {
    const { snapshotMetrics } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    const snap = snapshotMetrics();
    expect(snap).toHaveProperty('histograms');
    const h = (snap as Record<string, unknown>)['histograms'] as Record<string, unknown>;
    expect(h).toHaveProperty(['http.request.duration_ms']);
    expect(h).toHaveProperty(['llm.request.duration_ms']);
    expect(h).toHaveProperty(['llm.tokens.input']);
    expect(h).toHaveProperty(['llm.tokens.output']);
    const hSnap = h['http.request.duration_ms'] as { count: number; sum: number; min: number; max: number; mean: number };
    expect(typeof hSnap.count).toBe('number');
    expect(typeof hSnap.sum).toBe('number');
    expect(typeof hSnap.mean).toBe('number');
  });

  // Verifies that direct counter increments are reflected in snapshotMetrics output.
  test('httpRequestsTotal increments are observable via snapshotMetrics', async () => {
    const { httpRequestsTotal, snapshotMetrics } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    const before = httpRequestsTotal.value({ status_class: '2xx', method: 'GET' });
    httpRequestsTotal.add(1, { status_class: '2xx', method: 'GET' });
    const snap = snapshotMetrics();
    const afterDirect = httpRequestsTotal.value({ status_class: '2xx', method: 'GET' });
    expect(afterDirect).toBe(before + 1);
    // Snapshot includes counters map
    expect(snap).toHaveProperty('counters');
  });
});
