/**
 * ws-call-context-retention.test.ts
 *
 * Regression guard for the ordinary-daemon (LAN) retained-context leak: the WS
 * control-plane 'call' path synthesizes operator-token Requests, and before the
 * fix it had no in-flight cap and buffered response bodies via text() — a
 * streaming (SSE) response pinned the Request + Response + a growing buffer
 * forever, and a parked burst retained one context per call without bound (the
 * ~206k-context shape from the 2026-07-14 OOM core).
 *
 * Mirrors the reviewer's probe: pump call frames through the REAL
 * DaemonControlPlaneHelper with a mock wire, take WeakRefs on every synthesized
 * Request, and assert the caps hold and nothing stays pinned after Bun.gc(true).
 */
import { describe, expect, test } from 'bun:test';
import { DaemonControlPlaneHelper } from '../packages/sdk/src/platform/daemon/control-plane.ts';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';

function gc(): void {
  (globalThis as { Bun?: { gc?: (f: boolean) => void } }).Bun?.gc?.(true);
}

function makeHelper(dispatch: (req: Request) => Promise<Response | null>): DaemonControlPlaneHelper {
  return new DaemonControlPlaneHelper({
    authToken: () => 'operator-token-xyz',
    userAuth: {} as never,
    agentManager: {} as never,
    controlPlaneGateway: {} as never,
    gatewayMethods: new GatewayMethodCatalog(),
    distributedRuntime: {} as never,
    host: '127.0.0.1',
    port: 4483,
    trustProxyEnabled: () => false,
    dispatchApiRoutes: dispatch,
    parseJsonBody: async () => ({}),
    requireAuthenticatedSession: () => null,
  });
}

describe('WS call path retained-context caps', () => {
  test('a parked burst is capped in flight; overflow refused with 503; everything releases on drain', async () => {
    const refs: WeakRef<Request>[] = [];
    let inDispatch = 0;
    let peak = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const helper = makeHelper(async (req) => {
      refs.push(new WeakRef(req));
      inDispatch += 1;
      peak = Math.max(peak, inDispatch);
      await gate;
      inDispatch -= 1;
      return Response.json({ ok: true });
    });

    const N = 5000;
    const calls: Promise<{ status: number }>[] = [];
    for (let i = 0; i < N; i++) {
      calls.push(helper.invokeWebSocketControlPlaneCall({ authToken: 'operator-token-xyz', method: 'GET', path: `/probe/${i}` }));
    }
    await new Promise((r) => setTimeout(r, 50));
    gc();
    const liveParked = refs.filter((r) => r.deref() !== undefined).length;
    // In-flight retention bounded by the cap (256), not by N.
    expect(peak).toBeLessThanOrEqual(256);
    expect(liveParked).toBeLessThanOrEqual(256);
    expect(helper.wsCallStats().inFlight).toBeLessThanOrEqual(256);

    release();
    const settled = await Promise.all(calls);
    const refused = settled.filter((s) => s.status === 503).length;
    expect(refused).toBe(N - refs.length); // every over-cap call refused honestly
    expect(helper.wsCallStats().refused).toBe(refused);
    expect(helper.wsCallStats().inFlight).toBe(0);

    // Nothing stays pinned after the drain.
    await new Promise((r) => setTimeout(r, 20));
    gc();
    expect(refs.filter((r) => r.deref() !== undefined).length).toBe(0);
  });

  test('a streaming (SSE) response is refused and torn down, never pinned by text()', async () => {
    const refs: WeakRef<Request>[] = [];
    let producerCancelled = false;
    const helper = makeHelper(async (req) => {
      refs.push(new WeakRef(req));
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const t = setInterval(() => {
            try { controller.enqueue(enc.encode('data: {}\n\n')); } catch { clearInterval(t); }
          }, 5);
          (t as unknown as { unref?: () => void }).unref?.();
          // Producer teardown rides the request signal, as the daemon's SSE endpoints do.
          req.signal.addEventListener('abort', () => { producerCancelled = true; clearInterval(t); try { controller.close(); } catch { /* closed */ } }, { once: true });
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    });

    const results = await Promise.all(
      Array.from({ length: 200 }, () => helper.invokeWebSocketControlPlaneCall({ authToken: 'operator-token-xyz', method: 'GET', path: '/probe/events' })),
    );
    // Every call RESOLVES (before the fix they pended forever) with the honest refusal.
    for (const r of results) {
      expect(r.status).toBe(501);
      expect((r.body as { error: string }).error).toBe('streaming-not-supported');
    }
    expect(producerCancelled).toBe(true);
    expect(helper.wsCallStats().inFlight).toBe(0);
    // GC is not single-pass deterministic — poll a few collections.
    let live = refs.length;
    for (let i = 0; i < 10 && live > 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      gc();
      live = refs.filter((r) => r.deref() !== undefined).length;
    }
    expect(live).toBe(0);
  });

  test('an oversized response body is aborted with a structured 502, not buffered without bound', async () => {
    const chunk = new Uint8Array(1024 * 1024); // 1MB chunks, endless
    const helper = makeHelper(async (req) => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (req.signal.aborted) { try { controller.close(); } catch { /* closed */ } return; }
          controller.enqueue(chunk);
        },
      });
      return new Response(stream, { headers: { 'content-type': 'application/octet-stream' } });
    });
    const result = await helper.invokeWebSocketControlPlaneCall({ authToken: 't', method: 'GET', path: '/probe/huge' });
    expect(result.status).toBe(502);
    expect((result.body as { error: string }).error).toBe('response-too-large');
    expect(helper.wsCallStats().inFlight).toBe(0);
  });

  test('a stalled WS consumer gets events dropped past the buffered ceiling instead of unbounded native growth', () => {
    let sent = 0;
    let buffered = 0;
    const gateway = {
      openWebSocketClient: (_opts: unknown, send: (event: string, payload: unknown) => void) => {
        // Fire 1000 events at a consumer whose buffered amount reports stalled.
        buffered = 8 * 1024 * 1024; // above the 4MB ceiling
        for (let i = 0; i < 1000; i++) send('ops', { i });
        return { clientId: 'c1', domains: [] };
      },
    };
    const helper = new DaemonControlPlaneHelper({
      authToken: () => 't',
      userAuth: {} as never,
      agentManager: {} as never,
      controlPlaneGateway: gateway as never,
      gatewayMethods: new GatewayMethodCatalog(),
      distributedRuntime: {} as never,
      host: 'h', port: 1,
      trustProxyEnabled: () => false,
      dispatchApiRoutes: async () => null,
      parseJsonBody: async () => ({}),
      requireAuthenticatedSession: () => null,
    });
    helper.handleControlPlaneWebSocketOpen({
      data: { channel: 'control-plane', authToken: 't', principalId: null, principalKind: null, admin: false, scopes: [], domains: [], clientKind: 'web', authenticated: true } as never,
      send: () => { sent += 1; },
      getBufferedAmount: () => buffered,
    });
    expect(sent).toBe(0); // all dropped — never queued onto a stalled socket
    expect(helper.wsCallStats().eventsDropped).toBe(1000);
  });
});

describe('methodId arm shares the in-flight cap (no unbounded handler concurrency)', () => {
  test('a 5,000-frame methodId burst is capped at 256 concurrent handler invocations, refused with 503, visible in stats', async () => {
    // Mirror of the reviewer's probe: a registered-handler verb invoked via the
    // WS call frame's methodId arm (previously uncapped and invisible).
    const { GatewayMethodCatalog: Catalog } = await import('../packages/sdk/src/platform/control-plane/method-catalog.ts');
    const { methodDescriptor, objectSchema } = await import('../packages/sdk/src/platform/control-plane/method-catalog-shared.ts');
    const catalog = new Catalog();
    let inHandler = 0;
    let peak = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    catalog.register(
      methodDescriptor({
        id: 'ops.memory.get', // reuse a cataloged shape; handler replaces it for the probe
        title: 'probe', description: 'probe handler', category: 'health',
        scopes: ['read:health'],
        inputSchema: objectSchema({}, []),
        outputSchema: objectSchema({}, []),
      }),
      async () => {
        inHandler += 1;
        peak = Math.max(peak, inHandler);
        await gate;
        inHandler -= 1;
        return { ok: true };
      },
      { replace: true },
    );
    const helper = new DaemonControlPlaneHelper({
      authToken: () => 'operator-token-xyz',
      userAuth: {} as never,
      agentManager: {} as never,
      controlPlaneGateway: {} as never,
      gatewayMethods: catalog,
      distributedRuntime: {} as never,
      host: '127.0.0.1', port: 4483,
      trustProxyEnabled: () => false,
      dispatchApiRoutes: async () => null,
      parseJsonBody: async () => ({}),
      requireAuthenticatedSession: () => null,
    });

    const N = 5000;
    const calls: Promise<{ status: number }>[] = [];
    for (let i = 0; i < N; i++) {
      calls.push(helper.invokeGatewayMethodCall({
        authToken: 'operator-token-xyz',
        methodId: 'ops.memory.get',
        context: { principalId: 'p', principalKind: 'user', admin: true, scopes: ['read:health'] },
      }));
    }
    await new Promise((r) => setTimeout(r, 50));
    // The handler arm is bounded by the SAME cap and VISIBLE in the stats.
    expect(peak).toBeLessThanOrEqual(256);
    expect(helper.wsCallStats().inFlight).toBeLessThanOrEqual(256);
    expect(helper.wsCallStats().inFlight).toBeGreaterThan(0); // no longer invisible

    release();
    const settled = await Promise.all(calls);
    const refused = settled.filter((s) => s.status === 503).length;
    const served = settled.filter((s) => s.status === 200).length;
    expect(refused).toBe(N - served);
    expect(refused).toBeGreaterThan(0); // over-cap calls got the honest 503
    expect(helper.wsCallStats().refused).toBe(refused);
    expect(helper.wsCallStats().inFlight).toBe(0); // fully drained
  });
});
