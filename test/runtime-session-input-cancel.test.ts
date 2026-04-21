/**
 * runtime-session-input-cancel.test.ts
 *
 * Tests for F17 — cancelSharedSessionInput state-transition guard.
 *
 * queued input → cancel returns 200, input state transitions to cancelled
 * spawned input → cancel returns 409 CANCEL_NOT_ALLOWED
 * unknown input id → 404 regression guard
 */

import { describe, expect, test } from 'bun:test';
import { createDaemonRuntimeSessionRouteHandlers } from '../packages/daemon-sdk/src/runtime-session-routes.js';
import type { DaemonRuntimeRouteContext } from '../packages/daemon-sdk/src/runtime-route-types.js';

// ---------------------------------------------------------------------------
// Minimal context stub
// ---------------------------------------------------------------------------

type InputRecord = {
  id: string;
  state: string;
};

function makeContext(inputs: Map<string, InputRecord>): DaemonRuntimeRouteContext {
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
      createSession: async () => ({ id: 'stub-session' }),
      getSession: (sessionId) => (
        sessionId === 'test-session'
          ? { id: 'test-session', status: 'open', messageCount: 0 }
          : null
      ),
      getMessages: () => [],
      getInputs: () => [],
      closeSession: async () => null,
      reopenSession: async () => null,
      cancelInput: async (_sessionId, inputId) => {
        const input = inputs.get(inputId);
        if (!input) return null;
        // Simulate real broker: only transition 'queued' → 'cancelled'
        if (input.state === 'queued') {
          input.state = 'cancelled';
        }
        return input;
      },
      completeAgent: async () => {},
      appendCompanionMessage: async () => {},
    },
    agentManager: {
      getStatus: () => null,
      cancel: () => {},
    },
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
      getSchedulerCapacity: () => ({ slotsTotal: 4, slotsInUse: 0, queueDepth: 0, oldestQueuedAgeMs: null }),
    },
    normalizeAtSchedule: () => ({}),
    normalizeEverySchedule: () => ({}),
    normalizeCronSchedule: () => ({}),
    routeBindings: {
      start: async () => {},
      getBinding: () => undefined,
    },
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

describe('F17 — cancelSharedSessionInput: queued → cancelled', () => {
  test('queued input → cancel returns 200, input state is cancelled', async () => {
    const inputs = new Map<string, InputRecord>([
      ['input-queued-1', { id: 'input-queued-1', state: 'queued' }],
    ]);
    const ctx = makeContext(inputs);
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const res = await handlers.cancelSharedSessionInput('test-session', 'input-queued-1');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['input']).toBeDefined();
    const inputRecord = body['input'] as Record<string, unknown>;
    expect(inputRecord['state']).toBe('cancelled');
  });

  test('already-cancelled input → cancel returns 200 (idempotent)', async () => {
    const inputs = new Map<string, InputRecord>([
      ['input-cancelled-1', { id: 'input-cancelled-1', state: 'cancelled' }],
    ]);
    const ctx = makeContext(inputs);
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const res = await handlers.cancelSharedSessionInput('test-session', 'input-cancelled-1');
    expect(res.status).toBe(200);
  });
});

describe('F17 — cancelSharedSessionInput: spawned → 409 CANCEL_NOT_ALLOWED', () => {
  test('spawned input → 409 CANCEL_NOT_ALLOWED', async () => {
    const inputs = new Map<string, InputRecord>([
      ['input-spawned-1', { id: 'input-spawned-1', state: 'spawned' }],
    ]);
    const ctx = makeContext(inputs);
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const res = await handlers.cancelSharedSessionInput('test-session', 'input-spawned-1');
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body['code']).toBe('CANCEL_NOT_ALLOWED');
    expect(typeof body['error']).toBe('string');
    expect(body['input']).toBeDefined();
  });

  test('running input → 409 CANCEL_NOT_ALLOWED', async () => {
    const inputs = new Map<string, InputRecord>([
      ['input-running-1', { id: 'input-running-1', state: 'running' }],
    ]);
    const ctx = makeContext(inputs);
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const res = await handlers.cancelSharedSessionInput('test-session', 'input-running-1');
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body['code']).toBe('CANCEL_NOT_ALLOWED');
  });
});

describe('F17 — cancelSharedSessionInput: unknown input → 404', () => {
  test('unknown input id → 404', async () => {
    const inputs = new Map<string, InputRecord>();
    const ctx = makeContext(inputs);
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const res = await handlers.cancelSharedSessionInput('test-session', 'no-such-input');
    expect(res.status).toBe(404);
  });
});
