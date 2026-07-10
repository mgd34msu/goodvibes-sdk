/**
 * gateway-rest-parity.test.ts
 *
 * Proves the gateway-hoisted verb families (skills.*, principals.*, checkin.*,
 * ci.*, channels.profiles.*, sessions.permissionMode/contextUsage) are genuinely
 * served over their advertised REST paths — not merely that the capability-route
 * reconcile can see a route match. A real request flows through
 * dispatchDaemonApiRoutes → dispatchGatewayRestRoutes → invokeGatewayRestVerb and
 * lands on the same invokeGatewayMethodCall the methodId-invoke endpoint uses,
 * with the path parameters folded into both the query and the body.
 */
import { describe, expect, test } from 'bun:test';
import { dispatchDaemonApiRoutes } from '../packages/daemon-sdk/src/api-router.js';
import { createDaemonControlRouteHandlers } from '../packages/daemon-sdk/src/control-routes.js';
import { makeDefaultDaemonHandlerStub } from './_helpers/daemon-stub-handlers.js';
import { makeRequest } from './_helpers/router-requests.js';

interface InvokeCall {
  methodId: string;
  query?: Record<string, unknown> | undefined;
  body?: unknown;
  admin?: boolean | undefined;
}

function buildHarness(options?: {
  access?: 'public' | 'authenticated' | 'admin' | 'remote-peer';
  admin?: boolean;
  denyAdmin?: boolean;
}) {
  const calls: InvokeCall[] = [];
  const access = options?.access ?? 'admin';
  const controlHandlers = createDaemonControlRouteHandlers({
    authToken: 'shared-token',
    version: '0.0.0-test',
    sessionCookieName: 'goodvibes_session',
    controlPlaneGateway: {
      getSnapshot: () => ({}),
      renderWebUi: () => new Response('', { status: 200 }),
      listRecentEvents: () => [],
      listSurfaceMessages: () => [],
      listClients: () => [],
      createEventStream: () => new Response('', { status: 200 }),
    },
    extractAuthToken: (req) => req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '',
    resolveAuthenticatedPrincipal: () => ({
      principalId: 'tester',
      principalKind: 'user',
      admin: options?.admin ?? true,
      scopes: ['read:sessions', 'write:sessions'],
    }),
    gatewayMethods: {
      list: () => [],
      listEvents: () => [],
      get: () => ({ access }),
    },
    getOperatorContract: () => ({}),
    invokeGatewayMethodCall: async (input) => {
      calls.push({ methodId: input.methodId, query: input.query, body: input.body, admin: input.context?.admin });
      return { status: 200, ok: true, body: { methodId: input.methodId } };
    },
    parseOptionalJsonBody: async (req) => {
      const text = await req.text();
      if (!text) return null;
      return JSON.parse(text) as Record<string, unknown>;
    },
    requireAdmin: () => (options?.denyAdmin ? Response.json({ error: 'admin required' }, { status: 403 }) : null),
    requireAuthenticatedSession: () => null,
  });
  const handlers = makeDefaultDaemonHandlerStub({ invokeGatewayRestVerb: controlHandlers.invokeGatewayRestVerb });
  return { calls, handlers };
}

describe('gateway REST parity — advertised paths reach the gateway handler', () => {
  test('GET /api/skills routes to skills.list', async () => {
    const { calls, handlers } = buildHarness();
    const res = await dispatchDaemonApiRoutes(makeRequest('GET', 'http://localhost/api/skills'), handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.methodId).toBe('skills.list');
  });

  test('GET /api/skills/{name} folds the path param into query and body', async () => {
    const { calls, handlers } = buildHarness();
    await dispatchDaemonApiRoutes(makeRequest('GET', 'http://localhost/api/skills/my-skill'), handlers);
    expect(calls[0]!.methodId).toBe('skills.get');
    expect((calls[0]!.query as Record<string, unknown>).name).toBe('my-skill');
    expect((calls[0]!.body as Record<string, unknown>).name).toBe('my-skill');
  });

  test('POST /api/sessions/{sessionId}/permission-mode folds the path id into the body next to the JSON body', async () => {
    const { calls, handlers } = buildHarness();
    await dispatchDaemonApiRoutes(
      makeRequest('POST', 'http://localhost/api/sessions/sess-1/permission-mode', { mode: 'plan' }),
      handlers,
    );
    expect(calls[0]!.methodId).toBe('sessions.permissionMode.set');
    expect(calls[0]!.body).toEqual({ sessionId: 'sess-1', mode: 'plan' });
  });

  test('DELETE /api/ci/watches/{watchId} routes to ci.watches.delete with the id', async () => {
    const { calls, handlers } = buildHarness();
    await dispatchDaemonApiRoutes(makeRequest('DELETE', 'http://localhost/api/ci/watches/w-9'), handlers);
    expect(calls[0]!.methodId).toBe('ci.watches.delete');
    expect((calls[0]!.query as Record<string, unknown>).watchId).toBe('w-9');
  });

  test('an admin-gated verb denied by requireAdmin returns 403 and never invokes the handler', async () => {
    const { calls, handlers } = buildHarness({ access: 'admin', denyAdmin: true });
    const res = await dispatchDaemonApiRoutes(makeRequest('GET', 'http://localhost/api/principals'), handlers);
    expect(res!.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test('a path outside the gateway REST table is not claimed by this dispatcher', async () => {
    const { calls, handlers } = buildHarness();
    // /api/skills/{name}/update is POST-only; a GET must not match it, and no
    // other gateway-rest entry claims it — so this GET falls through (the default
    // stub has no such route, so the dispatch returns null).
    const res = await dispatchDaemonApiRoutes(makeRequest('GET', 'http://localhost/api/skills/x/update'), handlers);
    expect(res).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
