/**
 * router-e2e-control.test.ts
 *
 * Router-level E2E tests for the control-plane route family.
 * Exercises dispatchOperatorRoutes which handles:
 *   GET /status
 *   GET /api/control-plane
 *   GET /api/control-plane/contract
 *   GET /api/control-plane/recent-events
 *   GET /api/control-plane/clients
 *
 * Uses the operator routes dispatch function directly, injecting a minimal
 * DaemonApiRouteHandlers stub — no full DaemonHttpRouter construction needed.
 */

import { describe, expect, test } from 'bun:test';
import { dispatchDaemonApiRoutes } from '../packages/daemon-sdk/src/api-router.js';
import { createDaemonControlRouteHandlers } from '../packages/daemon-sdk/src/control-routes.js';
import { dispatchOperatorRoutes } from '../packages/daemon-sdk/src/operator.js';
import { makeDefaultDaemonHandlerStub } from './_helpers/daemon-stub-handlers.js';
import { makeRequest } from './_helpers/router-requests.js';

// ---------------------------------------------------------------------------
// describe: control routes — happy paths
// ---------------------------------------------------------------------------

describe('router-e2e control — GET /status (happy path)', () => {
  test('standalone daemon dispatches /login to the control handler', async () => {
    const loginRequest = makeRequest('POST', 'http://localhost/login');
    let capturedRequest: Request | null = null;

    const res = await dispatchDaemonApiRoutes(loginRequest, makeDefaultDaemonHandlerStub({
      postLogin: (req) => {
        capturedRequest = req;
        return Response.json({ authenticated: true });
      },
    }));

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(capturedRequest).toBe(loginRequest);
    expect(await res!.json()).toEqual({ authenticated: true });
  });

  test('standalone daemon dispatches /status with request-scoped auth', async () => {
    const statusRequests: Request[] = [];
    const handlers = createDaemonControlRouteHandlers({
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
      resolveAuthenticatedPrincipal: (req) => {
        statusRequests.push(req);
        return req.headers.get('authorization') === 'Bearer session-token'
          ? {
              principalId: 'tester',
              principalKind: 'user',
              admin: false,
              scopes: ['read:status'],
            }
          : null;
      },
      gatewayMethods: {
        list: () => [],
        listEvents: () => [],
        get: () => null,
      },
      getOperatorContract: () => ({}),
      invokeGatewayMethodCall: async () => ({ status: 404, ok: false, body: {} }),
      parseOptionalJsonBody: async () => null,
      requireAdmin: () => new Response('', { status: 403 }),
      requireAuthenticatedSession: () => null,
    });

    const unauthenticatedRequest = makeRequest('GET', 'http://localhost/status');
    const unauthenticated = await dispatchDaemonApiRoutes(unauthenticatedRequest, handlers as never);
    expect(unauthenticated).not.toBeNull();
    expect(unauthenticated!.status).toBe(401);
    expect(statusRequests[0]).toBe(unauthenticatedRequest);

    const authenticatedRequest = new Request('http://localhost/status', {
      method: 'GET',
      headers: { Authorization: 'Bearer session-token' },
    });
    const authenticated = await dispatchDaemonApiRoutes(authenticatedRequest, handlers as never);
    expect(authenticated).not.toBeNull();
    expect(authenticated!.status).toBe(200);
    expect(statusRequests[1]).toBe(authenticatedRequest);
    expect(await authenticated!.json()).toEqual({
      status: 'running',
      version: '0.0.0-test',
    });
  });

  test('returns the control.status response shape', async () => {
    const handlers = makeDefaultDaemonHandlerStub();
    const req = makeRequest('GET', 'http://localhost/status');
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.status).toBe('running');
    expect(body.version).toBe('0.0.0-test');
  });

  test('delegates to getControlPlaneSnapshot for GET /api/control-plane', async () => {
    const handlers = makeDefaultDaemonHandlerStub();
    const req = makeRequest('GET', 'http://localhost/api/control-plane');
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body).toHaveProperty('totals');
    const totals = body.totals as Record<string, number>;
    expect(typeof totals.clients).toBe('number');
  });

  test('getControlPlaneRecentEvents returns events array and respects limit param', async () => {
    let capturedLimit = -1;
    const handlers = makeDefaultDaemonHandlerStub({
      getControlPlaneRecentEvents: (limit) => {
        capturedLimit = limit;
        return Response.json({ events: [], limit });
      },
    });
    const req = makeRequest('GET', 'http://localhost/api/control-plane/recent-events?limit=25');
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.events).toBeInstanceOf(Array);
    expect(capturedLimit).toBe(25);
  });

  test('getControlPlaneClients returns clients list', async () => {
    const handlers = makeDefaultDaemonHandlerStub({
      getControlPlaneClients: () =>
        Response.json({ clients: [{ id: 'cl-1', kind: 'tui' }] }),
    });
    const req = makeRequest('GET', 'http://localhost/api/control-plane/clients');
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as { clients: unknown[] };
    expect(body.clients).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// describe: control routes — failure / unmatched paths
// ---------------------------------------------------------------------------

describe('router-e2e control — failure paths', () => {
  test('returns null for unmatched route (passes through to next dispatcher)', async () => {
    const handlers = makeDefaultDaemonHandlerStub();
    const req = makeRequest('GET', 'http://localhost/api/no-such-control-route');
    const res = await dispatchOperatorRoutes(req, handlers);
    // dispatchOperatorRoutes returns null when no route matches
    expect(res).toBeNull();
  });

  test('returns null for POST /status (method not registered)', async () => {
    const handlers = makeDefaultDaemonHandlerStub();
    const req = makeRequest('POST', 'http://localhost/status');
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).toBeNull();
  });
});
