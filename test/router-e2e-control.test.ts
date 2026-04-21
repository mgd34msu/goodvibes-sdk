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
import { dispatchOperatorRoutes } from '../packages/sdk/src/_internal/daemon/operator.js';
import { makeDefaultDaemonHandlerStub } from './_helpers/daemon-stub-handlers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(method: string, url: string): Request {
  return new Request(url, { method });
}

// ---------------------------------------------------------------------------
// describe: control routes — happy paths
// ---------------------------------------------------------------------------

describe('router-e2e control — GET /status (happy path)', () => {
  test('returns 200 with ok:true', async () => {
    const handlers = makeDefaultDaemonHandlerStub();
    const req = makeRequest('GET', 'http://localhost/status');
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
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
    expect(Array.isArray(body.events)).toBe(true);
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
