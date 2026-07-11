/**
 * Daemon authorization boundary.
 *
 * Verifies that each handler derives authorization from the per-call
 * request, not from a closure-captured factory-time request. An admin
 * request must be permitted; a non-admin request to the same handler
 * must be denied — even when the factory was initialized with a
 * different request object.
 */
import { describe, expect, test } from 'bun:test';
import {
  createDaemonSystemRouteHandlers,
  createDaemonIntegrationRouteHandlers,
  createDaemonRuntimeSessionRouteHandlers,
  dispatchGatewayRestRoutes,
  dispatchDaemonApiRoutes,
  GATEWAY_REST_ROUTES,
} from '../packages/daemon-sdk/dist/index.js';
import { AccountsSnapshotResponseSchema } from '../packages/contracts/dist/index.js';
import type {
  DaemonSystemRouteContext,
  DaemonIntegrationRouteContext,
  DaemonRuntimeRouteContext,
} from '../packages/daemon-sdk/dist/index.js';

// ---------------------------------------------------------------------------
// Minimal stub builders
// ---------------------------------------------------------------------------

function makeRequireAdmin(adminToken: string) {
  return (req: Request): Response | null => {
    const auth = req.headers.get('authorization') ?? '';
    if (auth === `Bearer ${adminToken}`) return null; // allowed
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
  };
}

const ADMIN_TOKEN = 'admin-secret';
const OTHER_TOKEN = 'non-admin-token';

const adminReq = new Request('http://localhost/', {
  headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
});
const nonAdminReq = new Request('http://localhost/', {
  headers: { authorization: `Bearer ${OTHER_TOKEN}` },
});

function makeValidAccountsSnapshot() {
  return {
    capturedAt: 1_800_000_000_000,
    providers: [{
      providerId: 'test-provider',
      active: true,
      modelCount: 2,
      configured: true,
      oauthReady: true,
      pendingLogin: false,
      availableRoutes: ['service-oauth'],
      preferredRoute: 'service-oauth',
      activeRoute: 'service-oauth',
      activeRouteReason: 'Service OAuth is the current usable route.',
      authFreshness: 'healthy',
      notes: ['provider note'],
      usageWindows: [{ label: 'daily', detail: 'Daily usage window.' }],
      issues: [],
      recommendedActions: [],
      routeRecords: [{
        route: 'service-oauth',
        usable: true,
        freshness: 'healthy',
        detail: 'Service OAuth credential is available for this provider.',
        issues: [],
      }],
    }],
    configuredCount: 1,
    issueCount: 0,
  };
}

// ---------------------------------------------------------------------------
// createDaemonSystemRouteHandlers
// ---------------------------------------------------------------------------

describe('createDaemonSystemRouteHandlers per-request auth', () => {
  function makeContext(): DaemonSystemRouteContext {
    return {
      requireAdmin: makeRequireAdmin(ADMIN_TOKEN),
      // platformServiceManager — matches production field name
      platformServiceManager: {
        status: () => ({ installed: false, running: false }),
        install: () => ({ ok: true }),
        start: () => ({ ok: true }),
        stop: () => ({ ok: true }),
        restart: () => ({ ok: true }),
        uninstall: () => ({ ok: true }),
      },
      watcherRegistry: {
        list: () => [],
        getWatcher: () => null,
        registerWatcher: (w: unknown) => w,
        removeWatcher: () => null,
        startWatcher: () => null,
        stopWatcher: () => null,
        runWatcherNow: async () => null,
      },
      routeBindings: {
        listBindings: () => [],
        upsertBinding: async (b: unknown) => b,
        patchBinding: async () => null,
        removeBinding: async () => false,
      },
      // configManager — getAll() needed by getConfig handler
      configManager: {
        get: () => null,
        getAll: () => ({}),
        setDynamic: () => {},
      },
      parseJsonBody: async () => ({}),
      parseOptionalJsonBody: async () => null,
      isValidConfigKey: () => true,
      inspectInboundTls: () => null,
      inspectOutboundTls: () => null,
      requireAuthenticatedSession: () => null,
      recordApiResponse: (_req: unknown, _path: unknown, res: Response) => res,
    } as unknown as DaemonSystemRouteContext;
  }

  test('factory built with no args — installService allows admin, denies non-admin', async () => {
    const handlers = createDaemonSystemRouteHandlers(makeContext());

    const allowed = await handlers.installService(adminReq);
    // May succeed (200) or service-unavailable (5xx) depending on stub, but must NOT be 403
    expect(allowed.status).not.toBe(403);

    const denied = await handlers.installService(nonAdminReq);
    expect(denied.status).toBe(403);
  });

  test('getConfig allows admin, denies non-admin', async () => {
    const handlers = createDaemonSystemRouteHandlers(makeContext());

    const allowed = await handlers.getConfig(adminReq);
    expect(allowed.status).not.toBe(403);

    const denied = await handlers.getConfig(nonAdminReq);
    expect(denied.status).toBe(403);
  });

  test('identity-of-request: installService passes each call-site request to requireAdmin', async () => {
    const seen: Request[] = [];
    const requireAdmin = (req: Request): Response | null => {
      seen.push(req);
      return req.headers.get('authorization') === `Bearer ${ADMIN_TOKEN}` ? null : new Response('', { status: 403 });
    };
    const ctx = makeContext();
    const handlers = createDaemonSystemRouteHandlers({ ...ctx, requireAdmin });
    await handlers.installService(adminReq);
    await handlers.installService(nonAdminReq);
    expect(seen[0]).toBe(adminReq);
    expect(seen[1]).toBe(nonAdminReq);
  });
});

// ---------------------------------------------------------------------------
// createDaemonIntegrationRouteHandlers
// ---------------------------------------------------------------------------

describe('createDaemonIntegrationRouteHandlers per-request auth', () => {
  function makeContext(): DaemonIntegrationRouteContext {
    return {
      requireAdmin: makeRequireAdmin(ADMIN_TOKEN),
      // userAuth — matches production field name (not userAuthManager)
      userAuth: {
        addUser: () => ({ username: 'u' }),
        deleteUser: () => true,
        rotatePassword: () => {},
        revokeSession: () => true,
        clearBootstrapCredentialFile: () => true,
      },
      integrationHelpers: {
        getLocalAuthSnapshot: () => ({ users: [] }),
        buildReview: () => ({}),
        getSessionSnapshot: () => ({}),
        getTaskSnapshot: () => ({}),
        getAutomationSnapshot: () => ({}),
        getSessionBrokerSnapshot: () => ({}),
        getDeliverySnapshot: () => ({}),
        getRouteSnapshot: () => ({}),
        getRemoteSnapshot: () => ({}),
        getHealthSnapshot: () => ({}),
        getAccountsSnapshot: async () => ({}),
        getSettingsSnapshot: () => ({}),
        getSecuritySettingsReport: () => ({}),
        getContinuitySnapshot: () => ({}),
        getWorktreeSnapshot: () => ({}),
        getIntelligenceSnapshot: () => ({}),
        getApprovalSnapshot: () => ({}),
        listPanels: () => [],
        openPanel: () => false,
        createEventStream: () => new Response('', { status: 200 }),
        getRuntimeStore: () => null,
      },
      memoryRegistry: {
        doctor: async () => ({}),
        vectorStats: () => ({}),
        rebuildVectorsAsync: async () => ({}),
      },
      memoryEmbeddingRegistry: {
        setDefaultProvider: () => {},
      },
      channelPlugins: {
        listAccounts: async () => [],
      },
      providerRuntime: {
        listSnapshots: async () => [],
        getSnapshot: async () => null,
        getUsageSnapshot: async () => null,
      },
      parseJsonBody: async () => ({}),
      parseOptionalJsonBody: async () => null,
    } as unknown as DaemonIntegrationRouteContext;
  }

  test('getLocalAuth allows admin, denies non-admin', async () => {
    const handlers = createDaemonIntegrationRouteHandlers(makeContext());

    const allowed = await handlers.getLocalAuth(adminReq);
    expect(allowed.status).not.toBe(403);

    const denied = await handlers.getLocalAuth(nonAdminReq);
    expect(denied.status).toBe(403);
  });

  test('deleteBootstrapFile allows admin, denies non-admin', async () => {
    const handlers = createDaemonIntegrationRouteHandlers(makeContext());

    const allowed = await handlers.deleteBootstrapFile(adminReq);
    expect(allowed.status).not.toBe(403);

    const denied = await handlers.deleteBootstrapFile(nonAdminReq);
    expect(denied.status).toBe(403);
  });

  test('identity-of-request: deleteBootstrapFile passes each call-site request to requireAdmin', async () => {
    const seen: Request[] = [];
    const requireAdmin = (req: Request): Response | null => {
      seen.push(req);
      return req.headers.get('authorization') === `Bearer ${ADMIN_TOKEN}` ? null : new Response('', { status: 403 });
    };
    const ctx = makeContext();
    const handlers = createDaemonIntegrationRouteHandlers({ ...ctx, requireAdmin });
    await handlers.deleteBootstrapFile(adminReq);
    await handlers.deleteBootstrapFile(nonAdminReq);
    expect(seen[0]).toBe(adminReq);
    expect(seen[1]).toBe(nonAdminReq);
  });

  test('getAccounts returns the strict accounts.snapshot contract shape', async () => {
    const snapshot = makeValidAccountsSnapshot();
    const ctx = makeContext();
    const handlers = createDaemonIntegrationRouteHandlers({
      ...ctx,
      integrationHelpers: {
        ...ctx.integrationHelpers!,
        getAccountsSnapshot: async () => snapshot,
      },
      channelPlugins: {
        listAccounts: async () => [{ surface: 'test-channel' }],
      },
    });

    const response = await handlers.getAccounts();
    const body = await response.json();

    expect(body).toEqual(snapshot);
    expect(Object.hasOwn(body, 'channels')).toBe(false);
    expect(Object.hasOwn(body, 'channelCount')).toBe(false);
    expect(() => AccountsSnapshotResponseSchema.parse(body)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createDaemonRuntimeSessionRouteHandlers getSharedSessionEvents
// ---------------------------------------------------------------------------

describe('createDaemonRuntimeSessionRouteHandlers getSharedSessionEvents auth', () => {
  function makeContext(): DaemonRuntimeRouteContext {
    return {
      requireAdmin: makeRequireAdmin(ADMIN_TOKEN),
      sessionBroker: {
        start: async () => {},
        getSession: () => ({ id: 'sess-1' }),
        getMessages: () => [],
      },
      openSessionEventStream: () => new Response('stream', { status: 200 }),
      parseJsonBody: async () => ({}),
      parseOptionalJsonBody: async () => null,
    } as unknown as DaemonRuntimeRouteContext;
  }

  test('getSharedSessionEvents allows admin, denies non-admin', async () => {
    const handlers = createDaemonRuntimeSessionRouteHandlers(makeContext());

    const allowed = await handlers.getSharedSessionEvents('sess-1', adminReq);
    expect(allowed.status).not.toBe(403);

    const denied = await handlers.getSharedSessionEvents('sess-1', nonAdminReq);
    expect(denied.status).toBe(403);
  });

  test('getSharedSessionMessages returns the current shared-session response contract', async () => {
    const handlers = createDaemonRuntimeSessionRouteHandlers(makeContext());
    const response = await handlers.getSharedSessionMessages('sess-1', new URL('http://localhost/api/sessions/sess-1/messages?limit=25'));
    const body = await response.json() as {
      session: {
        id: string;
        kind: string;
        status: string;
        lastActivityAt: number;
        messageCount: number;
        pendingInputCount: number;
        routeIds: unknown[];
        surfaceKinds: unknown[];
        participants: unknown[];
        metadata: Record<string, unknown>;
      };
      messages: unknown[];
    };

    expect(response.status).toBe(200);
    expect(body.session.id).toBe('sess-1');
    expect(body.session.kind).toBe('tui');
    expect(body.session.status).toBe('active');
    expect(typeof body.session.lastActivityAt).toBe('number');
    expect(body.session.messageCount).toBe(0);
    expect(body.session.pendingInputCount).toBe(0);
    expect(body.session.routeIds).toEqual([]);
    expect(body.session.surfaceKinds).toEqual([]);
    expect(body.session.participants).toEqual([]);
    expect(body.session.metadata).toEqual({});
    expect(body.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/runtime/metrics — consolidated on the gateway verb (runtime.metrics.get)
//
// The daemon-sdk raw getRuntimeMetrics handler was removed; the URL is now
// served solely by the gateway-REST parity table, which dispatchDaemonApiRoutes
// tries ahead of the operator dispatcher. That table routes the path to
// invokeGatewayRestVerb for methodId 'runtime.metrics.get', whose read:telemetry
// scope gate is enforced by the SDK's invokeGatewayMethodCall (pinned in
// runtime-metrics-gateway-verb.test.ts). These tests pin the surviving daemon-sdk
// surface: the URL keeps answering, and it answers by delegating to the single
// gateway-verb gate rather than any bypassing raw handler.
// ---------------------------------------------------------------------------

describe('GET /api/runtime/metrics gateway-REST consolidation', () => {
  const metricsReq = (): Request => new Request('http://localhost/api/runtime/metrics', { method: 'GET' });

  test('the gateway-REST table maps GET /api/runtime/metrics to runtime.metrics.get', () => {
    const entry = GATEWAY_REST_ROUTES.find(
      (r) => r.method === 'GET' && r.methodId === 'runtime.metrics.get',
    );
    expect(entry).toBeDefined();
    expect(entry!.regex.test('/api/runtime/metrics')).toBe(true);
  });

  test('dispatchGatewayRestRoutes routes the URL through invokeGatewayRestVerb (single gateway gate)', async () => {
    const seen: Array<{ methodId: string; req: Request }> = [];
    const response = await dispatchGatewayRestRoutes(metricsReq(), {
      invokeGatewayRestVerb: (invocation) => {
        seen.push({ methodId: invocation.methodId, req: invocation.req });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.methodId).toBe('runtime.metrics.get');
  });

  test('dispatchDaemonApiRoutes serves the URL from the gateway-REST leg, not any raw runtime handler', async () => {
    let restVerbCalled = false;
    const handlers = {
      invokeGatewayRestVerb: (invocation: { methodId: string }) => {
        restVerbCalled = invocation.methodId === 'runtime.metrics.get';
        return new Response(JSON.stringify({ served: 'gateway' }), { status: 200 });
      },
    } as unknown as Parameters<typeof dispatchDaemonApiRoutes>[1];
    const response = await dispatchDaemonApiRoutes(metricsReq(), handlers);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(restVerbCalled).toBe(true);
    expect(await response!.json()).toEqual({ served: 'gateway' });
  });

  test('when the daemon has not wired invokeGatewayRestVerb, the URL degrades to unrouted (null)', async () => {
    const response = await dispatchGatewayRestRoutes(metricsReq(), {});
    expect(response).toBeNull();
  });
});
