/**
 * Regression test: Phase 1 — Daemon authorization boundary
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
} from '../packages/daemon-sdk/dist/index.js';
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

// ---------------------------------------------------------------------------
// createDaemonSystemRouteHandlers — C3 regression
// ---------------------------------------------------------------------------

describe('createDaemonSystemRouteHandlers per-request auth (C3)', () => {
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

  test('identity-of-request: installService passes each call-site request to requireAdmin (C3 closure-capture proof)', async () => {
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
// createDaemonIntegrationRouteHandlers — C3 regression
// ---------------------------------------------------------------------------

describe('createDaemonIntegrationRouteHandlers per-request auth (C3)', () => {
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

  test('identity-of-request: deleteBootstrapFile passes each call-site request to requireAdmin (C3 closure-capture proof)', async () => {
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
});

// ---------------------------------------------------------------------------
// createDaemonRuntimeSessionRouteHandlers — C4 regression (getSharedSessionEvents)
// ---------------------------------------------------------------------------

describe('createDaemonRuntimeSessionRouteHandlers getSharedSessionEvents auth (C4)', () => {
  function makeContext(): DaemonRuntimeRouteContext {
    return {
      requireAdmin: makeRequireAdmin(ADMIN_TOKEN),
      sessionBroker: {
        start: async () => {},
        getSession: () => ({ id: 'sess-1' }),
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
});
