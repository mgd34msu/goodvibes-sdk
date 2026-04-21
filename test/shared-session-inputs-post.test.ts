/**
 * shared-session-inputs-post.test.ts
 *
 * Tests for F20 (SDK 0.21.36) — `POST /api/sessions/:id/inputs` intent-dispatching alias.
 * Previously removed in 0.21.35; restored in 0.21.36 for API-surface parity.
 *
 * Intents exercised:
 *   - default (missing)  → delegates to sessionBroker.submitMessage
 *   - 'submit'           → delegates to sessionBroker.submitMessage
 *   - 'steer'            → delegates to sessionBroker.steerMessage
 *   - 'follow-up'        → delegates to sessionBroker.followUpMessage
 *   - bogus string       → 400 INVALID_INTENT
 *   - missing body       → 400 Missing shared session input body
 */

import { describe, expect, test } from 'bun:test';
import { dispatchSessionRoutes } from '../packages/sdk/src/_internal/daemon/sessions.js';
import { createDaemonRuntimeSessionRouteHandlers } from '../packages/sdk/src/_internal/daemon/runtime-session-routes.js';
import type { DaemonRuntimeRouteContext } from '../packages/sdk/src/_internal/daemon/runtime-route-types.js';

type BrokerCall = { readonly method: string; readonly body: string };

function makeContext(calls: BrokerCall[]): DaemonRuntimeRouteContext {
  const ok = (method: string) => ({
    mode: 'continued-live' as const,
    input: { id: `sin-${method}`, state: 'spawned' },
    session: { id: 'sess-test', status: 'active' },
    task: 'test-task',
    activeAgentId: 'agent-test',
  });

  const sessionBroker = {
    start: async () => {},
    submitMessage: async (input: { body: string }) => {
      calls.push({ method: 'submitMessage', body: input.body });
      return ok('submit');
    },
    steerMessage: async (input: { body: string }) => {
      calls.push({ method: 'steerMessage', body: input.body });
      return ok('steer');
    },
    followUpMessage: async (input: { body: string }) => {
      calls.push({ method: 'followUpMessage', body: input.body });
      return ok('follow-up');
    },
    // Unused in this test file but required by type
    bindAgent: async () => ({}),
    createSession: async () => ({ id: 'sess-test' }),
    getSession: () => ({ id: 'sess-test', status: 'active', messageCount: 0 }),
    getMessages: () => [],
    getInputs: () => [],
    closeSession: async () => null,
    reopenSession: async () => null,
    cancelInput: async () => null,
    completeAgent: async () => {},
    appendCompanionMessage: async () => ({}),
  };

  return {
    parseJsonBody: async (req: Request) => (await req.json()) as Record<string, unknown>,
    parseOptionalJsonBody: async (req: Request) => { try { return await req.json() as Record<string, unknown>; } catch { return null; } },
    recordApiResponse: (_req: Request, _path: string, response: Response) => response,
    requireAdmin: () => null,
    snapshotMetrics: () => ({}),
    sessionBroker,
    agentManager: { getStatus: () => null, cancel: () => {} },
    automationManager: {
      listJobs: () => [],
      listRuns: () => [],
      getRun: () => null,
      triggerHeartbeat: async () => ({}),
      cancelRun: async () => null,
      retryRun: async () => ({}),
      createJob: async () => ({ id: 'j1' }),
      updateJob: async () => null,
      removeJob: async () => {},
      setEnabled: async () => null,
      runNow: async () => ({ id: 'r1', status: 'queued' }),
      getSchedulerCapacity: () => ({ slotsTotal: 4, slotsInUse: 0, queueDepth: 0, oldestQueuedAgeMs: null }),
    },
    normalizeAtSchedule: () => ({}),
    normalizeEverySchedule: () => ({}),
    normalizeCronSchedule: () => ({}),
    routeBindings: { start: async () => {}, getBinding: () => undefined },
    trySpawnAgent: () => ({ id: 'a1', status: 'queued', task: 't', tools: [], startedAt: 0 }),
    queueSurfaceReplyFromBinding: () => {},
    surfaceDeliveryEnabled: () => true,
    syncSpawnedAgentTask: () => {},
    syncFinishedAgentTask: () => {},
    configManager: { get: () => undefined },
    runtimeStore: null,
    runtimeDispatch: null,
    publishConversationFollowup: () => {},
    openSessionEventStream: () => new Response(null),
  } as unknown as DaemonRuntimeRouteContext;
}

async function postInputs(handlers: ReturnType<typeof createDaemonRuntimeSessionRouteHandlers>, body: Record<string, unknown>): Promise<Response> {
  const req = new Request('http://localhost/api/sessions/sess-test/inputs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await dispatchSessionRoutes(req, handlers as never);
  if (!res) throw new Error('router returned null');
  return res;
}

describe('F20 — POST /api/sessions/:id/inputs intent-dispatching alias', () => {
  test('missing intent → delegates to submitMessage (default)', async () => {
    const calls: BrokerCall[] = [];
    const ctx = makeContext(calls);
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const res = await postInputs(handlers, { body: 'hello', surfaceKind: 'companion', surfaceId: 's:x' });
    expect([200, 202]).toContain(res.status);
    expect(calls.map((c) => c.method)).toEqual(['submitMessage']);
    expect(calls[0]?.body).toBe('hello');
  });

  test("intent: 'submit' → delegates to submitMessage", async () => {
    const calls: BrokerCall[] = [];
    const handlers = createDaemonRuntimeSessionRouteHandlers(makeContext(calls));
    await postInputs(handlers, { body: 'hello', intent: 'submit', surfaceKind: 'companion', surfaceId: 's:x' });
    expect(calls.map((c) => c.method)).toEqual(['submitMessage']);
  });

  test("intent: 'steer' → delegates to steerMessage", async () => {
    const calls: BrokerCall[] = [];
    const handlers = createDaemonRuntimeSessionRouteHandlers(makeContext(calls));
    await postInputs(handlers, { body: 'steer-body', intent: 'steer', surfaceKind: 'companion', surfaceId: 's:x' });
    expect(calls.map((c) => c.method)).toEqual(['steerMessage']);
    expect(calls[0]?.body).toBe('steer-body');
  });

  test("intent: 'follow-up' → delegates to followUpMessage", async () => {
    const calls: BrokerCall[] = [];
    const handlers = createDaemonRuntimeSessionRouteHandlers(makeContext(calls));
    await postInputs(handlers, { body: 'fu-body', intent: 'follow-up', surfaceKind: 'companion', surfaceId: 's:x' });
    expect(calls.map((c) => c.method)).toEqual(['followUpMessage']);
  });

  test('bogus intent → 400 INVALID_INTENT', async () => {
    const calls: BrokerCall[] = [];
    const handlers = createDaemonRuntimeSessionRouteHandlers(makeContext(calls));
    const res = await postInputs(handlers, { body: 'x', intent: 'teleport', surfaceKind: 'companion', surfaceId: 's:x' });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string; code: string };
    expect(json.code).toBe('INVALID_INTENT');
    expect(json.error).toContain("'teleport'");
    expect(calls).toEqual([]);
  });

  test('non-string intent (number) → defaults to submit, not 400', async () => {
    // Defensive narrow: non-string values coerce to 'submit' rather than rejecting.
    const calls: BrokerCall[] = [];
    const handlers = createDaemonRuntimeSessionRouteHandlers(makeContext(calls));
    const res = await postInputs(handlers, { body: 'x', intent: 42, surfaceKind: 'companion', surfaceId: 's:x' });
    expect([200, 202]).toContain(res.status);
    expect(calls.map((c) => c.method)).toEqual(['submitMessage']);
  });

  test('missing body → 400', async () => {
    const calls: BrokerCall[] = [];
    const handlers = createDaemonRuntimeSessionRouteHandlers(makeContext(calls));
    const res = await postInputs(handlers, { surfaceKind: 'companion', surfaceId: 's:x' });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
