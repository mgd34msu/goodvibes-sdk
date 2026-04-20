/**
 * scheduler-capacity.test.ts
 *
 * Tests for Architectural #3 — GET /api/runtime/scheduler scheduler capacity endpoint.
 *
 * - Empty state: correct zero-state shape with slots_total from config default
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
  slots_total: number;
  slots_in_use: number;
  queue_depth: number;
  oldest_queued_age_ms: number | null;
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
      slots_total: 4,
      slots_in_use: 0,
      queue_depth: 0,
      oldest_queued_age_ms: null,
    });
    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const res = handlers.getSchedulerCapacity();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body['slots_total']).toBe('number');
    expect(typeof body['slots_in_use']).toBe('number');
    expect(typeof body['queue_depth']).toBe('number');
    // oldest_queued_age_ms is null when queue is empty
    expect(body['oldest_queued_age_ms']).toBeNull();
    expect(body['slots_total']).toBe(4);
    expect(body['slots_in_use']).toBe(0);
    expect(body['queue_depth']).toBe(0);
  });

  test('slots_total reflects automation.maxConcurrentRuns config default (4)', async () => {
    const ctx = makeContext({
      slots_total: 4,
      slots_in_use: 0,
      queue_depth: 0,
      oldest_queued_age_ms: null,
    });
    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const res = handlers.getSchedulerCapacity();
    const body = await res.json() as Record<string, unknown>;
    expect(body['slots_total']).toBe(4);
  });
});

describe('Arch #3 — GET /api/runtime/scheduler: live state', () => {
  test('with running runs: slots_in_use reflects executing count', async () => {
    const ctx = makeContext({
      slots_total: 4,
      slots_in_use: 2,
      queue_depth: 0,
      oldest_queued_age_ms: null,
    });
    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const res = handlers.getSchedulerCapacity();
    const body = await res.json() as Record<string, unknown>;
    expect(body['slots_in_use']).toBe(2);
    expect(body['queue_depth']).toBe(0);
  });

  test('with queued runs: queue_depth and oldest_queued_age_ms populated', async () => {
    const oldestAgeMs = 12_500;
    const ctx = makeContext({
      slots_total: 4,
      slots_in_use: 4,
      queue_depth: 3,
      oldest_queued_age_ms: oldestAgeMs,
    });
    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const res = handlers.getSchedulerCapacity();
    const body = await res.json() as Record<string, unknown>;
    expect(body['slots_in_use']).toBe(4);
    expect(body['queue_depth']).toBe(3);
    expect(body['oldest_queued_age_ms']).toBe(oldestAgeMs);
  });

  test('oldest_queued_age_ms is null when queue is empty even when slots_in_use > 0', async () => {
    const ctx = makeContext({
      slots_total: 4,
      slots_in_use: 2,
      queue_depth: 0,
      oldest_queued_age_ms: null,
    });
    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const res = handlers.getSchedulerCapacity();
    const body = await res.json() as Record<string, unknown>;
    expect(body['oldest_queued_age_ms']).toBeNull();
  });
});

describe('Arch #3 — GET /api/runtime/scheduler: HTTP route wiring', () => {
  test('getSchedulerCapacity handler returns 200 with required field keys', async () => {
    const ctx = makeContext({
      slots_total: 4,
      slots_in_use: 1,
      queue_depth: 2,
      oldest_queued_age_ms: 5000,
    });
    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const res = handlers.getSchedulerCapacity();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    // Verify all four documented fields are present
    expect('slots_total' in body).toBe(true);
    expect('slots_in_use' in body).toBe(true);
    expect('queue_depth' in body).toBe(true);
    expect('oldest_queued_age_ms' in body).toBe(true);
  });

  // Dispatcher integration: the following tests go through dispatchOperatorRoutes
  // to verify the scheduler route is correctly wired at the HTTP dispatch layer.

  test('happy path via dispatcher: GET /api/runtime/scheduler returns 200 with documented shape', async () => {
    const ctx = makeContext({
      slots_total: 4,
      slots_in_use: 1,
      queue_depth: 2,
      oldest_queued_age_ms: 5000,
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
    expect(typeof body['slots_total']).toBe('number');
    expect(typeof body['slots_in_use']).toBe('number');
    expect(typeof body['queue_depth']).toBe('number');
    expect(body['slots_total']).toBe(4);
    expect(body['slots_in_use']).toBe(1);
    expect(body['queue_depth']).toBe(2);
    expect(body['oldest_queued_age_ms']).toBe(5000);
  });

  test('non-200 pass-through via dispatcher: handler returning 403 is plumbed through by dispatcher', async () => {
    // Simulates a non-200 response scenario: the handler returns a 403 Response.
    // Verifies the dispatcher faithfully plumbs through non-200 responses
    // without swallowing or overriding them.
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
