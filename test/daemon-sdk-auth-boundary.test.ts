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
      serviceManager: { install: async () => ({ ok: true }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }), restart: async () => ({ ok: true }), uninstall: async () => ({ ok: true }), getStatus: async () => ({ running: false }) },
      watcherRegistry: { list: () => [], get: () => null, create: async () => ({ id: 'w1' }), update: async () => ({ id: 'w1' }), delete: async () => {}, runAction: async () => {} },
      routeBindingManager: { list: () => [], get: () => null, create: async () => ({ id: 'b1' }), update: async () => ({ id: 'b1' }), delete: async () => {} },
      configManager: { get: () => ({}), set: async () => {} },
      parseJsonBody: async () => ({}),
      parseOptionalJsonBody: async () => null,
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
});

// ---------------------------------------------------------------------------
// createDaemonIntegrationRouteHandlers — C3 regression
// ---------------------------------------------------------------------------

describe('createDaemonIntegrationRouteHandlers per-request auth (C3)', () => {
  function makeContext(): DaemonIntegrationRouteContext {
    return {
      requireAdmin: makeRequireAdmin(ADMIN_TOKEN),
      userAuthManager: { list: async () => [], getUser: async () => null, deleteUser: async () => {}, deleteSession: async () => {}, createUser: async () => ({ username: 'u' }), setPassword: async () => {} },
      parseJsonBody: async () => ({}),
      parseOptionalJsonBody: async () => null,
      deleteBootstrapFile: async () => {},
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
