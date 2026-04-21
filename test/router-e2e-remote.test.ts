/**
 * router-e2e-remote.test.ts
 *
 * Router-level E2E tests for the remote route family.
 * Exercises dispatchRemoteRoutes which handles:
 *   GET  /api/remote
 *   GET  /api/remote/pair/requests
 *   POST /api/remote/pair/requests/:id/approve
 *   POST /api/remote/pair/requests/:id/reject
 *   GET  /api/remote/peers
 *   POST /api/remote/peers/:id/token/rotate
 *   POST /api/remote/peers/:id/token/revoke
 *   POST /api/remote/peers/:id/disconnect
 *   POST /api/remote/peers/:id/invoke
 *   GET  /api/remote/work
 *   POST /api/remote/work/:id/cancel
 *
 * Uses dispatchRemoteRoutes directly with makeDefaultDaemonHandlerStub.
 */

import { describe, expect, test } from 'bun:test';
import { dispatchRemoteRoutes } from '../packages/sdk/src/_internal/daemon/remote.js';
import { makeDefaultDaemonHandlerStub } from './_helpers/daemon-stub-handlers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(method: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// describe: remote routes — happy paths
// ---------------------------------------------------------------------------

describe('router-e2e remote — GET /api/remote (happy path)', () => {
  test('returns 200 with peers list', async () => {
    const handlers = makeDefaultDaemonHandlerStub({
      getRemote: () => Response.json({ peers: [{ id: 'peer-1', status: 'connected' }] }),
    });
    const req = makeRequest('GET', 'http://localhost/api/remote');
    const res = await dispatchRemoteRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(Array.isArray(body.peers)).toBe(true);
  });

  test('GET /api/remote/pair/requests returns request list', async () => {
    const handlers = makeDefaultDaemonHandlerStub({
      getRemotePairRequests: () => Response.json({ requests: [{ id: 'req-1', peerId: 'peer-x' }] }),
    });
    const req = makeRequest('GET', 'http://localhost/api/remote/pair/requests');
    const res = await dispatchRemoteRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(Array.isArray(body.requests)).toBe(true);
  });

  test('GET /api/remote/peers returns peers list', async () => {
    const handlers = makeDefaultDaemonHandlerStub({
      getRemotePeers: () => Response.json({ peers: [{ id: 'peer-1' }] }),
    });
    const req = makeRequest('GET', 'http://localhost/api/remote/peers');
    const res = await dispatchRemoteRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as { peers: unknown[] };
    expect(body.peers).toHaveLength(1);
  });

  test('POST /api/remote/pair/requests/:id/approve delegates with correct id', async () => {
    let capturedId: string | null = null;
    const handlers = makeDefaultDaemonHandlerStub({
      approveRemotePairRequest: (id, _req) => {
        capturedId = id;
        return Response.json({ ok: true, id });
      },
    });
    const req = makeRequest('POST', 'http://localhost/api/remote/pair/requests/req-abc/approve');
    const res = await dispatchRemoteRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(capturedId).toBe('req-abc');
  });

  test('POST /api/remote/pair/requests/:id/reject delegates with correct id', async () => {
    let capturedId: string | null = null;
    const handlers = makeDefaultDaemonHandlerStub({
      rejectRemotePairRequest: (id, _req) => {
        capturedId = id;
        return Response.json({ ok: true, id });
      },
    });
    const req = makeRequest('POST', 'http://localhost/api/remote/pair/requests/req-xyz/reject');
    const res = await dispatchRemoteRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(capturedId).toBe('req-xyz');
  });

  test('POST /api/remote/peers/:id/token/rotate delegates with correct peer id', async () => {
    let capturedPeerId: string | null = null;
    const handlers = makeDefaultDaemonHandlerStub({
      rotateRemotePeerToken: (peerId, _req) => {
        capturedPeerId = peerId;
        return Response.json({ token: 'rotated-token' });
      },
    });
    const req = makeRequest('POST', 'http://localhost/api/remote/peers/peer-1/token/rotate');
    const res = await dispatchRemoteRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.token).toBe('rotated-token');
    expect(capturedPeerId).toBe('peer-1');
  });

  test('GET /api/remote/work returns work list', async () => {
    const handlers = makeDefaultDaemonHandlerStub({
      getRemoteWork: () => Response.json({ work: [{ id: 'work-1', status: 'running' }] }),
    });
    const req = makeRequest('GET', 'http://localhost/api/remote/work');
    const res = await dispatchRemoteRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(Array.isArray(body.work)).toBe(true);
  });

  test('POST /api/remote/work/:id/cancel cancels work item', async () => {
    let capturedId: string | null = null;
    const handlers = makeDefaultDaemonHandlerStub({
      cancelRemoteWork: (id, _req) => {
        capturedId = id;
        return Response.json({ ok: true, id });
      },
    });
    const req = makeRequest('POST', 'http://localhost/api/remote/work/work-99/cancel');
    const res = await dispatchRemoteRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(capturedId).toBe('work-99');
  });
});

// ---------------------------------------------------------------------------
// describe: remote routes — failure paths
// ---------------------------------------------------------------------------

describe('router-e2e remote — failure paths', () => {
  test('returns null for unmatched route', async () => {
    const handlers = makeDefaultDaemonHandlerStub();
    const req = makeRequest('GET', 'http://localhost/api/no-such-remote-route');
    const res = await dispatchRemoteRoutes(req, handlers);
    expect(res).toBeNull();
  });

  test('returns null for GET /api/remote/peers/:id/token/rotate (wrong method — GET not POST)', async () => {
    const handlers = makeDefaultDaemonHandlerStub();
    const req = makeRequest('GET', 'http://localhost/api/remote/peers/peer-1/token/rotate');
    const res = await dispatchRemoteRoutes(req, handlers);
    expect(res).toBeNull();
  });

  test('returns null for POST /api/remote (method not registered)', async () => {
    const handlers = makeDefaultDaemonHandlerStub();
    const req = makeRequest('POST', 'http://localhost/api/remote');
    const res = await dispatchRemoteRoutes(req, handlers);
    expect(res).toBeNull();
  });
});
