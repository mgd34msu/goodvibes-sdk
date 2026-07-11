/**
 * runtime-metrics-gateway-verb.test.ts
 *
 * Pins runtime.metrics.get as a genuinely handler-backed operator method (the
 * 501 defect class: a descriptor cataloged with no attached handler answers
 * "Gateway method is not invokable" over both websocket and HTTP invoke).
 * Proves the descriptor and its handler are registered together on a composed
 * catalog, and that invoking it returns the SAME live data snapshotMetrics()
 * returns directly — not a stub.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.js';
import { registerRuntimeMetricsGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/runtime-metrics.js';
import {
  httpRequestsTotal,
  resetMetrics,
  snapshotMetrics,
  type RuntimeMetricsSnapshot,
} from '../packages/sdk/src/platform/runtime/metrics.js';

afterEach(() => {
  resetMetrics();
});

// ── descriptor + handler register together (the 501 defect class) ───────────

describe('runtime.metrics.get gateway registration', () => {
  function makeCatalog() {
    const catalog = new GatewayMethodCatalog();
    registerRuntimeMetricsGatewayMethods(catalog);
    return catalog;
  }

  test('the verb is cataloged with a handler attached', () => {
    const catalog = makeCatalog();
    const descriptor = catalog.get('runtime.metrics.get');
    expect(descriptor).not.toBeNull();
    expect(descriptor?.http).toEqual({ method: 'GET', path: '/api/runtime/metrics' });
    expect(catalog.hasHandler('runtime.metrics.get')).toBe(true);
  });

  test('it round-trips through catalog.invoke with the real live snapshot', async () => {
    httpRequestsTotal.add(1, { status_class: '2xx' });
    const catalog = makeCatalog();
    const got = await catalog.invoke('runtime.metrics.get', { context: {} }) as RuntimeMetricsSnapshot;
    expect(got).toEqual(snapshotMetrics());
    expect(got.counters.http.requests.total['2xx']).toBeGreaterThanOrEqual(1);
    expect(got.toolFormat).toEqual({ byModel: {}, byClass: {} });
  });

  test('an unregistered catalog (no registerRuntimeMetricsGatewayMethods call) answers the 501 defect', async () => {
    const catalog = new GatewayMethodCatalog();
    expect(catalog.hasHandler('runtime.metrics.get')).toBe(false);
    await expect(catalog.invoke('runtime.metrics.get', { context: {} })).rejects.toThrow(
      /no internal handler/,
    );
  });
});
