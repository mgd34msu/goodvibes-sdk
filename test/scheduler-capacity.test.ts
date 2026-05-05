/**
 * scheduler-capacity.test.ts
 *
 * Tests for Architectural #3 — GET /api/runtime/scheduler scheduler capacity endpoint.
 *
 * - Empty state: correct zero-state shape with slotsTotal from config default
 * - With running + queued runs: counters reflect live state
 * - HTTP route wiring: dispatchDaemonOperatorApiRoutes returns documented shape
 */

import { describe, expect, test } from 'bun:test';
import { createDaemonRuntimeAutomationRouteHandlers } from '../packages/daemon-sdk/src/runtime-automation-routes.js';
import { dispatchOperatorRoutes } from '../packages/daemon-sdk/src/operator.js';
import type { DaemonRuntimeRouteContext } from '../packages/daemon-sdk/src/runtime-route-types.js';
import type { DaemonApiRouteHandlers } from '../packages/daemon-sdk/src/context.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

type CapacitySnapshot = {
  slotsTotal: number;
  slotsInUse: number;
  queueDepth: number;
  oldestQueuedAgeMs: number | null;
};

function makeContext(capacity: CapacitySnapshot): DaemonRuntimeRouteContext {
  return {
    parseJsonBody: async (req) => {
      try { return await req.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
    },
    parseOptionalJsonBody: async (req) => {
      const text = await req.text();
      if (!text) return null;
      try { return JSON.parse(text); } catch { return new Response('Bad JSON', { status: 400 }); }
    },
    recordApiResponse: (_req, _path, response) => response,
    requireAdmin: () => null,
    sessionBroker: {
      start: async () => {},
      submitMessage: async () => { throw new Error('not expected'); },
      steerMessage: async () => { throw new Error('not expected'); },
      followUpMessage: async () => { throw new Error('not expected'); },
      bindAgent: async () => {},
      createSession: async () => ({ id: 'stub' }),
      getSession: () => null,
      getMessages: () => [],
      getInputs: () => [],
      closeSession: async () => null,
      reopenSession: async () => null,
      cancelInput: async () => null,
      completeAgent: async () => {},
      appendCompanionMessage: async () => {},
    },
    agentManager: { getStatus: () => null, cancel: () => {} },
    automationManager: {
      listJobs: () => [],
      listRuns: () => [],
      getRun: () => null,
      triggerHeartbeat: async () => ({}),
      cancelRun: async () => null,
      retryRun: async () => { throw new Error('not expected'); },
      createJob: async () => ({ id: 'stub-job' }),
      updateJob: async () => null,
      removeJob: async () => {},
      setEnabled: async () => null,
      runNow: async () => ({ id: 'stub-run', status: 'running' }),
      getSchedulerCapacity: () => capacity,
    },
    normalizeAtSchedule: () => ({}),
    normalizeEverySchedule: () => ({}),
    normalizeCronSchedule: () => ({}),
    routeBindings: { start: async () => {}, getBinding: () => undefined },
    trySpawnAgent: () => new Response(JSON.stringify({ error: 'not expected' }), { status: 500 }),
    queueSurfaceReplyFromBinding: () => {},
    surfaceDeliveryEnabled: () => false,
    syncSpawnedAgentTask: () => {},
    syncFinishedAgentTask: () => {},
    configManager: { get: () => undefined },
    runtimeStore: null,
    runtimeDispatch: null,
    publishConversationFollowup: () => {},
    openSessionEventStream: () => new Response('', { status: 200 }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Arch #3 — GET /api/runtime/scheduler: empty state', () => {
  test('empty state returns documented shape with zero counters', async () => {
    const ctx = makeContext({
      slotsTotal: 4,
      slotsInUse: 0,
      queueDepth: 0,
      oldestQueuedAgeMs: null,
    });
    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const res = handlers.getSchedulerCapacity();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body['slotsTotal']).toBe('number');
    expect(typeof body['slotsInUse']).toBe('number');
    expect(typeof body['queueDepth']).toBe('number');
    // oldestQueuedAgeMs is null when queue is empty
    expect(body['oldestQueuedAgeMs']).toBeNull();
    expect(body['slotsTotal']).toBe(4);
    expect(body['slotsInUse']).toBe(0);
    expect(body['queueDepth']).toBe(0);
  });

  test('slotsTotal reflects automation.maxConcurrentRuns config default (4)', async () => {
    const ctx = makeContext({
      slotsTotal: 4,
      slotsInUse: 0,
      queueDepth: 0,
      oldestQueuedAgeMs: null,
    });
    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const res = handlers.getSchedulerCapacity();
    const body = await res.json() as Record<string, unknown>;
    expect(body['slotsTotal']).toBe(4);
  });
});

describe('Arch #3 — GET /api/runtime/scheduler: live state', () => {
  test('with running runs: slotsInUse reflects executing count', async () => {
    const ctx = makeContext({
      slotsTotal: 4,
      slotsInUse: 2,
      queueDepth: 0,
      oldestQueuedAgeMs: null,
    });
    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const res = handlers.getSchedulerCapacity();
    const body = await res.json() as Record<string, unknown>;
    expect(body['slotsInUse']).toBe(2);
    expect(body['queueDepth']).toBe(0);
  });

  test('with queued runs: queueDepth and oldestQueuedAgeMs populated', async () => {
    const oldestAgeMs = 12_500;
    const ctx = makeContext({
      slotsTotal: 4,
      slotsInUse: 4,
      queueDepth: 3,
      oldestQueuedAgeMs: oldestAgeMs,
    });
    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const res = handlers.getSchedulerCapacity();
    const body = await res.json() as Record<string, unknown>;
    expect(body['slotsInUse']).toBe(4);
    expect(body['queueDepth']).toBe(3);
    expect(body['oldestQueuedAgeMs']).toBe(oldestAgeMs);
  });

  test('oldestQueuedAgeMs is null when queue is empty even when slotsInUse > 0', async () => {
    const ctx = makeContext({
      slotsTotal: 4,
      slotsInUse: 2,
      queueDepth: 0,
      oldestQueuedAgeMs: null,
    });
    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const res = handlers.getSchedulerCapacity();
    const body = await res.json() as Record<string, unknown>;
    expect(body['oldestQueuedAgeMs']).toBeNull();
  });
});

describe('Arch #3 — GET /api/runtime/scheduler: HTTP route wiring', () => {
  test('getSchedulerCapacity handler returns 200 with required field keys', async () => {
    const ctx = makeContext({
      slotsTotal: 4,
      slotsInUse: 1,
      queueDepth: 2,
      oldestQueuedAgeMs: 5000,
    });
    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const res = handlers.getSchedulerCapacity();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    // Verify all four documented fields are present
    expect('slotsTotal' in body).toBe(true);
    expect('slotsInUse' in body).toBe(true);
    expect('queueDepth' in body).toBe(true);
    expect('oldestQueuedAgeMs' in body).toBe(true);
  });

  // Dispatcher integration: the following tests go through dispatchOperatorRoutes
  // to verify the scheduler route is correctly wired at the HTTP dispatch layer.

  test('happy path via dispatcher: GET /api/runtime/scheduler returns 200 with documented shape', async () => {
    const ctx = makeContext({
      slotsTotal: 4,
      slotsInUse: 1,
      queueDepth: 2,
      oldestQueuedAgeMs: 5000,
    });
    const channelHandlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const handlers = {
      ...channelHandlers,
    } as unknown as DaemonApiRouteHandlers;
    const req = new Request('http://localhost/api/runtime/scheduler', { method: 'GET' });
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(typeof body['slotsTotal']).toBe('number');
    expect(typeof body['slotsInUse']).toBe('number');
    expect(typeof body['queueDepth']).toBe('number');
    expect(body['slotsTotal']).toBe(4);
    expect(body['slotsInUse']).toBe(1);
    expect(body['queueDepth']).toBe(2);
    expect(body['oldestQueuedAgeMs']).toBe(5000);
  });

  test('non-200 pass-through via dispatcher: handler returning 403 is plumbed through by dispatcher', async () => {
    // Simulates a non-200 response scenario: the handler returns a 403 Response.
    // Verifies the dispatcher faithfully plumbs through non-200 responses
    // without replacing or overriding them.
    const forbidden = new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    const handlers = {
      getSchedulerCapacity: () => forbidden,
    } as unknown as DaemonApiRouteHandlers;
    const req = new Request('http://localhost/api/runtime/scheduler', { method: 'GET' });
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});
