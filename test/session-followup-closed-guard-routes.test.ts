/**
 * session-followup-closed-guard-routes.test.ts
 *
 * Wave-2 final-batch fix — HTTP route surface proof that BOTH follow-up
 * entry points (`POST /api/sessions/:id/follow-up` and
 * `POST /api/sessions/:id/messages` with `kind:'followup'`) and the submit
 * entry points (`POST /task` and `POST /api/sessions/:id/messages` with
 * `kind:'task'`) convert the broker's closed-session guard throw
 * (`{ code: 'SESSION_CLOSED', status: 409 }`, thrown before any mutation —
 * see session-followup-submit-closed-guard.test.ts for the broker-level
 * no-side-effects proof) into the same structured 409 JSON response the
 * steer route already returns (session-steer-closed-guard.test.ts), instead
 * of letting it propagate as an unhandled rejection. Also proves an
 * unrelated thrown error is not swallowed, and a normal (non-closed)
 * submission still reaches the caller unchanged on every entry point.
 */

import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createDaemonRuntimeSessionRouteHandlers } from '../packages/daemon-sdk/src/runtime-session-routes.js';
import type { DaemonRuntimeRouteContext } from '../packages/daemon-sdk/src/runtime-route-types.js';

function makeRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeContext(broker: {
  readonly submitMessage?: (input: unknown) => Promise<unknown>;
  readonly followUpMessage?: (input: unknown) => Promise<unknown>;
}): DaemonRuntimeRouteContext {
  return {
    parseJsonBody: async (req: Request) => {
      try {
        return await req.json();
      } catch {
        return new Response('Bad JSON', { status: 400 });
      }
    },
    parseOptionalJsonBody: async () => null,
    recordApiResponse: (_req: unknown, _path: unknown, response: Response) => response,
    requireAdmin: () => null,
    sessionBroker: {
      start: async () => {},
      steerMessage: async () => { throw new Error('not expected'); },
      submitMessage: broker.submitMessage ?? (async () => { throw new Error('not expected'); }),
      followUpMessage: broker.followUpMessage ?? (async () => { throw new Error('not expected'); }),
      bindAgent: async () => {},
      createSession: async (input: { id?: string }) => ({ id: input.id ?? randomUUID() }),
      getSession: () => null,
      getMessages: () => [],
      getInputs: () => [],
      closeSession: async () => null,
      reopenSession: async () => null,
      cancelInput: async () => null,
      completeAgent: async () => {},
      appendCompanionMessage: async () => null,
    },
    agentManager: { getStatus: () => null, cancel: () => {} },
    automationManager: {
      listJobs: () => [], listRuns: () => [], getRun: () => null,
      triggerHeartbeat: async () => null, cancelRun: async () => null, retryRun: async () => ({}),
      createJob: async () => ({ id: randomUUID() }), updateJob: async () => null, removeJob: async () => {},
      setEnabled: async () => null, runNow: async () => ({ id: randomUUID(), status: 'running' }),
    },
    normalizeAtSchedule: (at: unknown) => at,
    normalizeEverySchedule: (interval: unknown) => interval,
    normalizeCronSchedule: (expr: unknown) => expr,
    routeBindings: { start: async () => {}, getBinding: () => undefined },
    trySpawnAgent: () => ({ id: randomUUID(), status: 'running', task: 'test-task', tools: [], startedAt: Date.now() }),
    queueSurfaceReplyFromBinding: () => {},
    surfaceDeliveryEnabled: () => false,
    syncSpawnedAgentTask: () => {},
    syncFinishedAgentTask: () => {},
    configManager: { get: () => undefined },
    runtimeStore: null,
    runtimeDispatch: null,
    publishConversationFollowup: () => {},
    openSessionEventStream: () => new Response('stream', { status: 200 }),
  } as unknown as DaemonRuntimeRouteContext;
}

function closedError(): never {
  throw Object.assign(new Error('Session is closed: s-1'), { code: 'SESSION_CLOSED', status: 409 });
}

function openSubmission(sessionId: string, input: unknown) {
  return {
    mode: 'spawn',
    input: { id: randomUUID(), state: 'pending' },
    session: { id: sessionId, status: 'active' },
    task: (input as { body: string }).body,
    routeBinding: undefined,
    activeAgentId: null,
    userMessage: null,
  };
}

async function assertClosed409(res: Response): Promise<void> {
  expect(res.status).toBe(409);
  const payload = await res.json() as { code?: string; error?: string };
  expect(payload.code).toBe('SESSION_CLOSED');
  expect(payload.error).toBe('Session is closed');
}

describe('POST /api/sessions/:id/follow-up — closed-session guard', () => {
  test('returns 409 { code: SESSION_CLOSED } when the broker rejects a closed session', async () => {
    const ctx = makeContext({ followUpMessage: async () => closedError() });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const res = await handlers.postSharedSessionFollowUp('s-1', makeRequest('http://localhost/api/sessions/s-1/follow-up', { body: 'follow up a closed session' }));
    await assertClosed409(res);
  });

  test('an unrelated thrown error is not swallowed as SESSION_CLOSED', async () => {
    const ctx = makeContext({ followUpMessage: async () => { throw new Error('boom'); } });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    await expect(handlers.postSharedSessionFollowUp('s-1', makeRequest('http://localhost/api/sessions/s-1/follow-up', { body: 'follow up' }))).rejects.toThrow('boom');
  });

  test('an open-session follow-up still reaches the caller', async () => {
    const sessionId = randomUUID();
    const ctx = makeContext({ followUpMessage: async (input) => openSubmission(sessionId, input) });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const res = await handlers.postSharedSessionFollowUp(sessionId, makeRequest(`http://localhost/api/sessions/${sessionId}/follow-up`, { body: 'follow up an open session' }));
    expect(res.status).toBe(202);
    const payload = await res.json() as { mode?: string };
    expect(payload.mode).toBe('spawn');
  });
});

describe("POST /api/sessions/:id/messages kind='followup' — closed-session guard", () => {
  test('returns 409 { code: SESSION_CLOSED } when followUpMessage() rejects a closed session', async () => {
    const ctx = makeContext({ followUpMessage: async () => closedError() });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const res = await handlers.postSharedSessionMessage('s-1', makeRequest('http://localhost/api/sessions/s-1/messages', { body: 'follow up', kind: 'followup' }));
    await assertClosed409(res);
  });

  test('an open-session kind=followup message still reaches the caller', async () => {
    const sessionId = randomUUID();
    const ctx = makeContext({ followUpMessage: async (input) => openSubmission(sessionId, input) });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const res = await handlers.postSharedSessionMessage(sessionId, makeRequest(`http://localhost/api/sessions/${sessionId}/messages`, { body: 'follow up', kind: 'followup' }));
    expect(res.status).toBe(202);
  });
});

describe("POST /api/sessions/:id/messages kind='task' (submit) — closed-session guard", () => {
  test('returns 409 { code: SESSION_CLOSED } when submitMessage() rejects a closed session', async () => {
    const ctx = makeContext({ submitMessage: async () => closedError() });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const res = await handlers.postSharedSessionMessage('s-1', makeRequest('http://localhost/api/sessions/s-1/messages', { body: 'submit', kind: 'task' }));
    await assertClosed409(res);
  });

  test('an open-session kind=task message still reaches the caller', async () => {
    const sessionId = randomUUID();
    const ctx = makeContext({ submitMessage: async (input) => openSubmission(sessionId, input) });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const res = await handlers.postSharedSessionMessage(sessionId, makeRequest(`http://localhost/api/sessions/${sessionId}/messages`, { body: 'submit', kind: 'task' }));
    expect(res.status).toBe(202);
  });
});

describe('POST /task (submit) — closed-session guard', () => {
  test('returns 409 { code: SESSION_CLOSED } when submitMessage() rejects a closed session', async () => {
    const ctx = makeContext({ submitMessage: async () => closedError() });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const res = await handlers.postTask(makeRequest('http://localhost/task', { task: 'submit into a closed session', sessionId: 's-1' }));
    await assertClosed409(res);
  });

  test('an unrelated thrown error is not swallowed as SESSION_CLOSED', async () => {
    const ctx = makeContext({ submitMessage: async () => { throw new Error('boom'); } });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    await expect(handlers.postTask(makeRequest('http://localhost/task', { task: 'submit', sessionId: 's-1' }))).rejects.toThrow('boom');
  });

  test('an open-session /task submit still reaches the caller', async () => {
    const sessionId = randomUUID();
    const ctx = makeContext({ submitMessage: async () => ({
      mode: 'spawn',
      input: { id: randomUUID(), state: 'pending', routing: undefined },
      session: { id: sessionId, status: 'active' },
      task: 'submit to an open session',
      routeBinding: undefined,
      activeAgentId: null,
      userMessage: null,
    }) });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const res = await handlers.postTask(makeRequest('http://localhost/task', { task: 'submit to an open session', sessionId }));
    expect(res.status).toBe(202);
    const payload = await res.json() as { mode?: string; agentId?: string };
    expect(payload.mode).toBe('spawn');
    expect(typeof payload.agentId).toBe('string');
  });
});
