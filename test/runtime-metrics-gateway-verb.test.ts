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
  DaemonControlPlaneHelper,
  type DaemonControlPlaneContext,
} from '../packages/sdk/src/platform/daemon/control-plane.js';
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

// ── scope enforcement on the generic HTTP/WS invoke gate ────────────────────
//
// runtime.metrics.get is cataloged with scopes: ['read:telemetry']
// (method-catalog-runtime.ts). Scope checking is NOT re-implemented per
// method — it is enforced once, generically, by
// DaemonControlPlaneHelper.validateGatewayInvocation (daemon/control-plane.ts),
// which every invoke path (invokeGatewayMethodCall, the WS method+path call)
// runs before GatewayMethodCatalog.invoke() is ever reached. These tests pin
// that this method's declared scope is actually enforced there, mirroring the
// invokable:false coverage in gateway-method-not-invokable.test.ts.

describe('runtime.metrics.get scope enforcement (generic invoke gate)', () => {
  function helperWithCatalog(catalog: GatewayMethodCatalog): DaemonControlPlaneHelper {
    // validateGatewayInvocation/invokeGatewayMethodCall's scope-check path only
    // touches context.gatewayMethods, so a minimal stub is sufficient and honest.
    const context = { gatewayMethods: catalog } as unknown as DaemonControlPlaneContext;
    return new DaemonControlPlaneHelper(context);
  }

  test('the descriptor declares scopes: [read:telemetry]', () => {
    const catalog = new GatewayMethodCatalog();
    registerRuntimeMetricsGatewayMethods(catalog);
    const descriptor = catalog.get('runtime.metrics.get');
    expect(descriptor?.scopes).toEqual(['read:telemetry']);
  });

  test('validateGatewayInvocation denies a principal without read:telemetry with a 403 naming the missing scope', () => {
    const catalog = new GatewayMethodCatalog();
    registerRuntimeMetricsGatewayMethods(catalog);
    const helper = helperWithCatalog(catalog);
    const descriptor = catalog.get('runtime.metrics.get')!;

    const denied = helper.validateGatewayInvocation(descriptor, { scopes: ['read:sessions'], admin: false });
    expect(denied).not.toBeNull();
    expect(denied?.status).toBe(403);
    expect(denied?.body.missingScopes).toEqual(['read:telemetry']);
  });

  test('validateGatewayInvocation allows a principal that carries read:telemetry', () => {
    const catalog = new GatewayMethodCatalog();
    registerRuntimeMetricsGatewayMethods(catalog);
    const helper = helperWithCatalog(catalog);
    const descriptor = catalog.get('runtime.metrics.get')!;

    const allowed = helper.validateGatewayInvocation(descriptor, { scopes: ['read:telemetry'], admin: false });
    expect(allowed).toBeNull();
  });

  test('invokeGatewayMethodCall end-to-end: an unauthorized invoke (no read:telemetry) is refused before the handler runs', async () => {
    const catalog = new GatewayMethodCatalog();
    registerRuntimeMetricsGatewayMethods(catalog);
    const helper = helperWithCatalog(catalog);

    const result = await helper.invokeGatewayMethodCall({
      authToken: 'irrelevant',
      methodId: 'runtime.metrics.get',
      context: { scopes: [], admin: false },
    });
    expect(result.status).toBe(403);
    expect(result.ok).toBe(false);
    expect((result.body as Record<string, unknown>).missingScopes).toEqual(['read:telemetry']);
  });

  test('invokeGatewayMethodCall end-to-end: an authorized invoke (read:telemetry) returns the live snapshot', async () => {
    httpRequestsTotal.add(1, { status_class: '2xx' });
    const catalog = new GatewayMethodCatalog();
    registerRuntimeMetricsGatewayMethods(catalog);
    const helper = helperWithCatalog(catalog);

    const result = await helper.invokeGatewayMethodCall({
      authToken: 'irrelevant',
      methodId: 'runtime.metrics.get',
      context: { scopes: ['read:telemetry'], admin: false },
    });
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.body).toEqual(snapshotMetrics());
  });
});
