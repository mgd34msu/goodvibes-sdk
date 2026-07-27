/**
 * gateway-self-dispatch-loop.test.ts
 *
 * The gate for the defect that shipped in 1.18.0.
 *
 * `invokeGatewayMethodCall` has two arms: run the attached handler in process,
 * or — when there is no handler but the descriptor advertises an `http` binding
 * — synthesize a request to that path and feed it back into the real router.
 * The second arm exists for verbs whose implementation is a genuine HTTP route
 * living elsewhere in the chain.
 *
 * It stopped being safe when GATEWAY_REST_ROUTES gained rows for the
 * handler-backed families, because those rows map the advertised path straight
 * back to the SAME methodId. For a verb with no handler the synthesized request
 * re-entered the same arm and synthesized again. Before the rows existed the
 * synthesized request 404'd and the loop ended in one hop; adding them closed
 * the cycle.
 *
 * Measured on a 1.18.0 daemon composed without mail deps: ONE
 * `GET /api/email/inbox` produced 256 nested dispatches and then answered
 * `503 ws-call-overloaded — Daemon is at its concurrent WS-call cap (256)`.
 * Both halves of that were wrong. The capability was not wired, which is fixed
 * and terminal, not a transient capacity problem that might clear on retry —
 * anyone reading it would have gone looking at load, and load was never
 * involved. And a single request consumed the daemon's entire concurrent
 * WS-call budget, so a handful of them would starve every other caller.
 *
 * These tests fail if either half comes back.
 */
import { describe, expect, test } from 'bun:test';
import { GATEWAY_REST_ROUTES } from '../packages/daemon-sdk/src/gateway-rest-routes.ts';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import {
  DaemonControlPlaneHelper,
  type DaemonControlPlaneContext,
} from '../packages/sdk/src/platform/daemon/control-plane.ts';
import { SDKErrorCodes } from '../packages/errors/src/index.ts';

/**
 * A helper whose router would faithfully reproduce the loop: anything it is
 * handed comes straight back through `invokeGatewayMethodCall` for the methodId
 * that owns the path. If the guard ever regresses, this recurses — so the
 * dispatch counter below is the assertion, not decoration.
 */
function loopingHelper(catalog: GatewayMethodCatalog): {
  helper: DaemonControlPlaneHelper;
  dispatches: () => number;
} {
  let dispatches = 0;
  const context = {
    gatewayMethods: catalog,
    host: '127.0.0.1',
    port: 1,
    authToken: () => 'test-token',
    dispatchApiRoutes: async (req: Request): Promise<Response | null> => {
      dispatches += 1;
      // Hard stop so a regression fails the test instead of hanging the suite.
      if (dispatches > 8) return Response.json({ error: 'runaway' }, { status: 599 });
      const { pathname } = new URL(req.url);
      const entry = GATEWAY_REST_ROUTES.find(
        (row) => row.method === req.method && row.regex.test(pathname),
      );
      if (!entry) return Response.json({ error: 'Not found' }, { status: 404 });
      const result = await helper.invokeGatewayMethodCall({
        authToken: 'test-token',
        methodId: entry.methodId,
        synthesizedDepth: Number.parseInt(
          req.headers.get('x-goodvibes-synthesized-dispatch') ?? '0', 10,
        ) || 0,
      });
      return Response.json(result.body, { status: result.status });
    },
  } as unknown as DaemonControlPlaneContext;
  const helper = new DaemonControlPlaneHelper(context);
  return { helper, dispatches: () => dispatches };
}

/**
 * Every descriptor whose advertised binding is served by a gateway REST row
 * bound to its own methodId. These are exactly the verbs that can loop, and the
 * list is read from the real table rather than hand-maintained so a family
 * added later is covered without anyone remembering to add it here.
 */
function selfRoutedMethodIds(): string[] {
  const catalog = new GatewayMethodCatalog();
  const ids: string[] = [];
  for (const entry of GATEWAY_REST_ROUTES) {
    const descriptor = catalog.get(entry.methodId);
    if (!descriptor?.http) continue;
    // Skip templated paths: resolving them needs params the probe has no
    // business inventing, and the untemplated siblings cover the same arm.
    if (descriptor.http.path.includes('{')) continue;
    ids.push(entry.methodId);
  }
  return [...new Set(ids)];
}

describe('an advertised binding that routes back to its own methodId cannot loop', () => {
  const ids = selfRoutedMethodIds();

  test('the probe set is not empty (the table would otherwise vacuously pass)', () => {
    expect(ids.length).toBeGreaterThan(10);
    // The family that found this. If mail ever stops being self-routed the
    // assertion should be re-derived deliberately, not silently lost.
    expect(ids).toContain('email.inbox.list');
  });

  for (const methodId of ids) {
    test(`${methodId} with no handler answers terminally, without recursing`, async () => {
      // includeBuiltins gives the descriptor; nothing attaches a handler, which
      // is the supported "this composition did not wire that capability" state.
      const catalog = new GatewayMethodCatalog();
      const { helper, dispatches } = loopingHelper(catalog);

      const result = await helper.invokeGatewayMethodCall({
        authToken: 'test-token',
        methodId,
        // Admin AND the verb's own scopes, so the access gate does not answer
        // first and hide the arm this test exists to exercise — without the
        // scopes most of these stop at a 403 and the sweep proves nothing.
        // Verbs that still refuse earlier for their own reasons (a required
        // confirm, a missing body) satisfy the two invariants below anyway,
        // which are the ones that matter for a loop.
        context: {
          admin: true,
          principalKind: 'user',
          scopes: catalog.get(methodId)?.scopes ?? [],
        },
      });

      const body = result.body as Record<string, unknown>;
      // Never reported as capacity: retrying will not change this answer.
      expect(body.error).not.toBe('ws-call-overloaded');
      expect(result.status).not.toBe(503);
      // The point of the whole gate: it never re-entered the router at all.
      expect(dispatches()).toBe(0);
    });
  }

  // The concrete family the defect was found on: these reach the dispatch arm
  // with nothing in their way, so they must produce the honest terminal answer
  // rather than merely failing to loop.
  for (const methodId of ['email.inbox.list', 'browser.status', 'browser.sessions.list']) {
    test(`${methodId} answers 501 NOT_INVOKABLE naming the unwired capability`, async () => {
      const catalog = new GatewayMethodCatalog();
      const { helper, dispatches } = loopingHelper(catalog);

      const result = await helper.invokeGatewayMethodCall({
        authToken: 'test-token',
        methodId,
        // The verb's own scopes, so the access gate passes and the dispatch arm
        // is what answers — the whole point of these three.
        context: {
          admin: true,
          principalKind: 'user',
          scopes: catalog.get(methodId)?.scopes ?? [],
        },
      });

      const body = result.body as Record<string, unknown>;
      expect(result.status).toBe(501);
      expect(body.code).toBe(SDKErrorCodes.NOT_INVOKABLE);
      expect(String(body.error)).toContain(methodId);
      expect(String(body.error)).toContain('not wired up');
      expect(dispatches()).toBe(0);
    });
  }
});

describe('the depth guard refuses a re-entered synthesized request as a loop', () => {
  test('a call already past the synthesis depth is refused, not dispatched', async () => {
    const catalog = new GatewayMethodCatalog();
    const { helper, dispatches } = loopingHelper(catalog);

    const result = await helper.invokeWebSocketControlPlaneCall({
      authToken: 'test-token',
      method: 'GET',
      path: '/api/email/inbox',
      synthesizedDepth: 2,
    });

    expect(result.status).toBe(500);
    const body = result.body as Record<string, unknown>;
    expect(body.code).toBe(SDKErrorCodes.INTERNAL_ERROR);
    expect(String(body.error)).toContain('dispatch loop');
    // Refused before it could consume any of the concurrent-call budget.
    expect(dispatches()).toBe(0);
    expect(helper.wsCallStats().inFlight).toBe(0);
  });

  test('a first synthesis is still allowed — the guard is not a blanket ban', async () => {
    const catalog = new GatewayMethodCatalog();
    const { helper, dispatches } = loopingHelper(catalog);

    // A path no gateway REST row owns: the synthesizing arm is legitimate here,
    // and must still run exactly once.
    await helper.invokeWebSocketControlPlaneCall({
      authToken: 'test-token',
      method: 'GET',
      path: '/api/definitely-not-a-gateway-rest-route',
      synthesizedDepth: 0,
    });

    expect(dispatches()).toBe(1);
  });
});
