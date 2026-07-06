/**
 * session-steer-closed-guard.test.ts
 *
 * Acceptance re-replay — the HTTP route surface for
 * `POST /api/sessions/:id/steer`. The broker (session-broker.ts) now throws
 * `{ code: 'SESSION_CLOSED', status: 409 }` before any mutation when the
 * target session is closed (see session-steer-surface-routing.test.ts for the
 * broker-level no-side-effects proof). This file proves the route handler
 * converts that thrown error into a structured 409 JSON response — the same
 * shape the messages route already returns for kind='message' on a closed
 * session — instead of letting it propagate as an unhandled rejection, and
 * that a normal (non-closed) steer submission still reaches the caller
 * unchanged.
 */

import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createDaemonRuntimeSessionRouteHandlers } from '../packages/daemon-sdk/src/runtime-session-routes.js';
import type { DaemonRuntimeRouteContext } from '../packages/daemon-sdk/src/runtime-route-types.js';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/sessions/s-1/steer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeContext(steerMessage: (input: unknown) => Promise<unknown>): DaemonRuntimeRouteContext {
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
      steerMessage,
      submitMessage: async () => { throw new Error('not expected'); },
      followUpMessage: async () => { throw new Error('not expected'); },
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

describe('POST /api/sessions/:id/steer — closed-session guard (D-1)', () => {
  test('returns 409 { code: SESSION_CLOSED } when the broker rejects a closed session', async () => {
    const ctx = makeContext(async () => {
      throw Object.assign(new Error('Session is closed: s-1'), { code: 'SESSION_CLOSED', status: 409 });
    });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);

    const res = await handlers.postSharedSessionSteer('s-1', makeRequest({ body: 'steer a closed session' }));

    expect(res.status).toBe(409);
    const payload = await res.json() as { code?: string; error?: string };
    expect(payload.code).toBe('SESSION_CLOSED');
    expect(typeof payload.error).toBe('string');
  });

  test('an unrelated thrown error from the broker is not swallowed as SESSION_CLOSED', async () => {
    const ctx = makeContext(async () => {
      throw new Error('boom');
    });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);

    await expect(handlers.postSharedSessionSteer('s-1', makeRequest({ body: 'steer' }))).rejects.toThrow('boom');
  });

  test('an open-session steer submission still reaches the caller (spawn fallback)', async () => {
    const sessionId = randomUUID();
    const ctx = makeContext(async (input) => ({
      mode: 'spawn',
      input: { id: randomUUID(), state: 'pending' },
      session: { id: sessionId, status: 'active' },
      task: (input as { body: string }).body,
      routeBinding: undefined,
      activeAgentId: null,
      userMessage: null,
    }));
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);

    const res = await handlers.postSharedSessionSteer(sessionId, makeRequest({ body: 'steer an open session' }));

    expect(res.status).toBe(202);
    const payload = await res.json() as { mode?: string; agentId?: string };
    expect(payload.mode).toBe('spawn');
    expect(typeof payload.agentId).toBe('string');
  });
});
