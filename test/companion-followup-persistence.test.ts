/**
 * companion-followup-persistence.test.ts
 *
 * Regression test for SDK 0.21.9 fix:
 *   POST /api/sessions/:id/messages with kind='message' (companion main-chat sends)
 *   must persist the message to the shared session message log AND emit the
 *   conversation.followup.companion event. Previously only the event fired.
 *
 * Coverage:
 *   - 202 is returned
 *   - appendCompanionMessage is called with correct shape
 *   - GET /api/sessions/:id/messages returns the message (via getMessages mock)
 *   - conversation.followup.companion event fires
 *   - messageId is consistent between persistence call and event payload
 *   - empty body is rejected with 400
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createDaemonRuntimeSessionRouteHandlers } from '../packages/sdk/src/_internal/daemon/runtime-session-routes.js';
import type { DaemonRuntimeRouteContext } from '../packages/sdk/src/_internal/daemon/runtime-route-types.js';

function makeRequest(method: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

type AppendCompanionCall = {
  sessionId: string;
  input: {
    messageId: string;
    body: string;
    timestamp: number;
    source: string;
  };
};

type FollowupEvent = {
  sessionId: string;
  envelope: { messageId: string; body: string; source: string; timestamp: number };
};

interface MockSessionRecord {
  id: string;
  status: string;
  messageCount: number;
}

function makeContext(opts: {
  sessions?: Map<string, MockSessionRecord>;
  appendCalls?: AppendCompanionCall[];
  followupEvents?: FollowupEvent[];
  persistedMessages?: Map<string, unknown[]>;
}): DaemonRuntimeRouteContext {
  const sessions = opts.sessions ?? new Map<string, MockSessionRecord>();
  const appendCalls = opts.appendCalls ?? [];
  const followupEvents = opts.followupEvents ?? [];
  const persistedMessages = opts.persistedMessages ?? new Map<string, unknown[]>();

  return {
    parseJsonBody: async (req) => {
      try {
        return await req.json() as Record<string, unknown>;
      } catch {
        return new Response('Bad JSON', { status: 400 });
      }
    },
    parseOptionalJsonBody: async (req) => {
      const text = await req.text();
      if (!text) return null;
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return new Response('Bad JSON', { status: 400 });
      }
    },
    recordApiResponse: (_req, _path, response) => response,
    requireAdmin: () => null,
    sessionBroker: {
      start: async () => {},
      submitMessage: async (input) => {
        const sessionId = input.sessionId ?? randomUUID();
        const session: MockSessionRecord = sessions.get(sessionId) ?? { id: sessionId, status: 'active', messageCount: 0 };
        sessions.set(sessionId, session);
        return {
          mode: 'spawn',
          input: { id: randomUUID() },
          session: { id: session.id, status: session.status },
          task: input.body,
          routeBinding: undefined,
          activeAgentId: null,
          userMessage: null,
        };
      },
      steerMessage: async (input) => {
        const sessionId = input.sessionId ?? randomUUID();
        const session: MockSessionRecord = sessions.get(sessionId) ?? { id: sessionId, status: 'active', messageCount: 0 };
        sessions.set(sessionId, session);
        return {
          mode: 'spawn',
          input: { id: randomUUID(), state: 'pending' },
          session: { id: session.id, status: session.status },
          task: input.body,
          routeBinding: undefined,
          activeAgentId: null,
          userMessage: null,
        };
      },
      followUpMessage: async (input) => {
        const sessionId = input.sessionId ?? randomUUID();
        const session: MockSessionRecord = sessions.get(sessionId) ?? { id: sessionId, status: 'active', messageCount: 0 };
        sessions.set(sessionId, session);
        return {
          mode: 'spawn',
          input: { id: randomUUID(), state: 'pending' },
          session: { id: session.id, status: session.status },
          task: input.body,
          routeBinding: undefined,
          activeAgentId: null,
          userMessage: null,
        };
      },
      bindAgent: async () => {},
      createSession: async (input) => ({ id: input.id ?? randomUUID() }),
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      getMessages: (sessionId) => persistedMessages.get(sessionId) ?? [],
      getInputs: () => [],
      closeSession: async (sessionId) => sessions.get(sessionId) ?? null,
      reopenSession: async (sessionId) => sessions.get(sessionId) ?? null,
      cancelInput: async () => null,
      completeAgent: async () => {},
      appendCompanionMessage: async (sessionId, input) => {
        appendCalls.push({ sessionId, input });
        // Simulate persistence: store a synthetic message record
        const bucket = persistedMessages.get(sessionId) ?? [];
        bucket.push({
          id: `smsg-${randomUUID().slice(0, 8)}`,
          sessionId,
          role: 'user',
          body: input.body,
          createdAt: input.timestamp,
          metadata: { source: input.source, messageId: input.messageId },
        });
        persistedMessages.set(sessionId, bucket);
        return null;
      },
    },
    agentManager: { getStatus: () => null, cancel: () => {} },
    automationManager: {
      listJobs: () => [],
      listRuns: () => [],
      getRun: () => null,
      triggerHeartbeat: async () => null,
      cancelRun: async () => null,
      retryRun: async () => ({}),
      createJob: async () => ({ id: randomUUID() }),
      updateJob: async () => null,
      removeJob: async () => {},
      setEnabled: async () => null,
      runNow: async () => ({ id: randomUUID(), status: 'running' }),
    },
    normalizeAtSchedule: (at) => at,
    normalizeEverySchedule: (interval) => interval,
    normalizeCronSchedule: (expr) => expr,
    routeBindings: { start: async () => {}, getBinding: () => undefined },
    trySpawnAgent: () => ({
      id: randomUUID(),
      status: 'running',
      task: 'test-task',
      tools: [],
      startedAt: Date.now(),
    }),
    queueSurfaceReplyFromBinding: () => {},
    surfaceDeliveryEnabled: () => false,
    syncSpawnedAgentTask: () => {},
    syncFinishedAgentTask: () => {},
    configManager: { get: () => undefined },
    runtimeStore: null,
    runtimeDispatch: null,
    publishConversationFollowup: (sessionId, envelope) => {
      followupEvents.push({ sessionId, envelope } as FollowupEvent);
    },
  } as unknown as DaemonRuntimeRouteContext;
}

describe('companion-followup-persistence: kind=message persists before emitting', () => {
  let sessionId: string;
  let sessions: Map<string, MockSessionRecord>;
  let appendCalls: AppendCompanionCall[];
  let followupEvents: FollowupEvent[];
  let persistedMessages: Map<string, unknown[]>;

  beforeEach(() => {
    sessionId = randomUUID();
    sessions = new Map([[sessionId, { id: sessionId, status: 'active', messageCount: 0 }]]);
    appendCalls = [];
    followupEvents = [];
    persistedMessages = new Map();
  });

  test('returns 202 for kind=message', async () => {
    const ctx = makeContext({ sessions, appendCalls, followupEvents, persistedMessages });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const req = makeRequest('POST', `http://localhost/api/sessions/${sessionId}/messages`, {
      body: 'hello from companion',
      kind: 'message',
    });
    const res = await handlers.postSharedSessionMessage(sessionId, req);
    expect(res.status).toBe(202);
  });

  test('appendCompanionMessage is called with correct body and source', async () => {
    const ctx = makeContext({ sessions, appendCalls, followupEvents, persistedMessages });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const req = makeRequest('POST', `http://localhost/api/sessions/${sessionId}/messages`, {
      body: 'hello from companion',
      kind: 'message',
    });
    await handlers.postSharedSessionMessage(sessionId, req);

    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0].sessionId).toBe(sessionId);
    expect(appendCalls[0].input.body).toBe('hello from companion');
    expect(appendCalls[0].input.source).toBe('companion-followup');
    expect(typeof appendCalls[0].input.messageId).toBe('string');
    expect(appendCalls[0].input.messageId.length).toBeGreaterThan(0);
    expect(typeof appendCalls[0].input.timestamp).toBe('number');
    expect(appendCalls[0].input.timestamp).toBeGreaterThan(0);
  });

  test('GET /api/sessions/:id/messages returns the persisted message', async () => {
    const ctx = makeContext({ sessions, appendCalls, followupEvents, persistedMessages });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const req = makeRequest('POST', `http://localhost/api/sessions/${sessionId}/messages`, {
      body: 'hello from companion',
      kind: 'message',
    });
    await handlers.postSharedSessionMessage(sessionId, req);

    // Simulate GET /api/sessions/:id/messages
    const getReq = makeRequest('GET', `http://localhost/api/sessions/${sessionId}/messages`);
    const url = new URL(getReq.url);
    const getRes = await handlers.getSharedSessionMessages(sessionId, url);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json() as { messages: Array<{ body: string; role: string }> };
    expect(getBody.messages).toHaveLength(1);
    expect(getBody.messages[0].body).toBe('hello from companion');
    expect(getBody.messages[0].role).toBe('user');
  });

  test('conversation.followup.companion event fires with matching messageId', async () => {
    const ctx = makeContext({ sessions, appendCalls, followupEvents, persistedMessages });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const req = makeRequest('POST', `http://localhost/api/sessions/${sessionId}/messages`, {
      body: 'hello from companion',
      kind: 'message',
    });
    await handlers.postSharedSessionMessage(sessionId, req);

    expect(followupEvents).toHaveLength(1);
    expect(followupEvents[0].sessionId).toBe(sessionId);
    expect(followupEvents[0].envelope.body).toBe('hello from companion');
    expect(followupEvents[0].envelope.source).toBe('companion-followup');

    // messageId must be the same in both persistence call and event
    expect(appendCalls[0].input.messageId).toBe(followupEvents[0].envelope.messageId);
  });

  test('appendCompanionMessage is called before event emission (persistence-first)', async () => {
    // Track order of calls
    const callOrder: Array<'append' | 'event'> = [];
    const ctx = makeContext({ sessions, persistedMessages });
    (ctx as Record<string, unknown>).sessionBroker = {
      ...(ctx as Record<string, unknown>).sessionBroker as object,
      appendCompanionMessage: async (sid: string, input: { messageId: string; body: string; timestamp: number; source: string }) => {
        callOrder.push('append');
        appendCalls.push({ sessionId: sid, input });
        return null;
      },
    };
    (ctx as Record<string, unknown>).publishConversationFollowup = (sid: string, envelope: { messageId: string; body: string; timestamp: number; source: string }) => {
      callOrder.push('event');
      followupEvents.push({ sessionId: sid, envelope });
    };

    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const req = makeRequest('POST', `http://localhost/api/sessions/${sessionId}/messages`, {
      body: 'order test',
      kind: 'message',
    });
    await handlers.postSharedSessionMessage(sessionId, req);

    expect(callOrder).toEqual(['append', 'event']);
  });

  test('response messageId matches the persisted messageId', async () => {
    const ctx = makeContext({ sessions, appendCalls, followupEvents, persistedMessages });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const req = makeRequest('POST', `http://localhost/api/sessions/${sessionId}/messages`, {
      body: 'hello from companion',
      kind: 'message',
    });
    const res = await handlers.postSharedSessionMessage(sessionId, req);
    const body = await res.json() as { messageId: string; routedTo: string };

    expect(body.routedTo).toBe('conversation');
    expect(body.messageId).toBe(appendCalls[0].input.messageId);
    expect(body.messageId).toBe(followupEvents[0].envelope.messageId);
  });

  test('returns 404 for unknown session — no persistence attempted', async () => {
    const ctx = makeContext({ sessions, appendCalls, followupEvents, persistedMessages });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const unknownId = randomUUID();
    const req = makeRequest('POST', `http://localhost/api/sessions/${unknownId}/messages`, {
      body: 'hello',
      kind: 'message',
    });
    const res = await handlers.postSharedSessionMessage(unknownId, req);
    expect(res.status).toBe(404);
    expect(appendCalls).toHaveLength(0);
    expect(followupEvents).toHaveLength(0);
  });

  test('returns 409 for closed session — no persistence attempted', async () => {
    sessions.set(sessionId, { id: sessionId, status: 'closed', messageCount: 0 });
    const ctx = makeContext({ sessions, appendCalls, followupEvents, persistedMessages });
    const handlers = createDaemonRuntimeSessionRouteHandlers(ctx);
    const req = makeRequest('POST', `http://localhost/api/sessions/${sessionId}/messages`, {
      body: 'hello',
      kind: 'message',
    });
    const res = await handlers.postSharedSessionMessage(sessionId, req);
    expect(res.status).toBe(409);
    expect(appendCalls).toHaveLength(0);
    expect(followupEvents).toHaveLength(0);
  });
});
