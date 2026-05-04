/**
 * router-e2e-session.test.ts
 *
 * Router-level E2E tests for the session route family.
 * Exercises dispatchSessionRoutes which handles:
 *   GET  /api/sessions
 *   POST /api/sessions
 *   GET  /api/sessions/:id
 *   POST /api/sessions/:id/close
 *   GET  /api/sessions/:id/messages
 *   POST /api/sessions/:id/messages
 *   GET  /api/sessions/:id/inputs
 *   POST /api/sessions/:id/steer
 *   POST /api/sessions/:id/follow-up
 *   POST /api/sessions/:id/inputs/:inputId/cancel
 *   GET  /api/sessions/:id/events
 */

import { describe, expect, test } from 'bun:test';
import { dispatchSessionRoutes } from '../packages/daemon-sdk/src/sessions.js';
import type { DaemonApiRouteHandlers } from '../packages/daemon-sdk/src/context.js';
import { makeRequest } from './_helpers/router-requests.js';

function makeSession(id = 'sess-1') {
  return {
    id,
    status: 'active' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeMessage(id = 'msg-1') {
  return {
    id,
    role: 'assistant' as const,
    content: 'Hello from test',
    createdAt: Date.now(),
  };
}

/**
 * Minimal stub satisfying the Pick used by dispatchSessionRoutes.
 */
function makeSessionHandlers(
  overrides: Partial<DaemonApiRouteHandlers> = {},
): DaemonApiRouteHandlers {
  const defaults: Partial<DaemonApiRouteHandlers> = {
    getIntegrationSessions: () =>
      Response.json({ sessions: [makeSession()] }),

    createSharedSession: async (_req) =>
      Response.json(makeSession('sess-new'), { status: 200 }),

    getSharedSession: (sessionId) =>
      Response.json(makeSession(sessionId)),

    closeSharedSession: (sessionId, _req) =>
      Response.json({ ok: true, sessionId }),

    reopenSharedSession: (sessionId, _req) =>
      Response.json({ ok: true, sessionId }),

    getSharedSessionMessages: (sessionId, _url) =>
      Response.json({ messages: [makeMessage()], sessionId }),

    postSharedSessionMessage: async (sessionId, _req) =>
      Response.json({ messageId: 'msg-queued', sessionId }),

    getSharedSessionInputs: (sessionId, _url) =>
      Response.json({ inputs: [], sessionId }),

    postSharedSessionSteer: async (sessionId, _req) =>
      Response.json({ ok: true, sessionId }),

    postSharedSessionFollowUp: async (sessionId, _req) =>
      Response.json({ ok: true, sessionId }),

    cancelSharedSessionInput: (sessionId, inputId, _req) =>
      Response.json({ ok: true, sessionId, inputId }),

    getSharedSessionEvents: (_sessionId, _req) =>
      new Response('data: {"type":"ready"}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
  };

  return { ...defaults, ...overrides } as DaemonApiRouteHandlers;
}

// ---------------------------------------------------------------------------
// describe: session routes — happy paths
// ---------------------------------------------------------------------------

describe('router-e2e session — POST /api/sessions (happy path)', () => {
  test('creates a session and returns 200 with session id', async () => {
    const handlers = makeSessionHandlers();
    const req = makeRequest('POST', 'http://localhost/api/sessions', {
      modelId: 'inception:mercury-2',
    });
    const res = await dispatchSessionRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(typeof body.id).toBe('string'); // id is a string session ID
    expect(body.status).toBe('active');
  });

  test('GET /api/sessions returns integration session list', async () => {
    const handlers = makeSessionHandlers();
    const req = makeRequest('GET', 'http://localhost/api/sessions');
    const res = await dispatchSessionRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as { sessions: unknown[] };
    expect(body.sessions).toBeInstanceOf(Array);
  });
});

describe('router-e2e session — messages (happy path)', () => {
  test('GET /api/sessions/:id/messages returns message list', async () => {
    const handlers = makeSessionHandlers();
    const req = makeRequest('GET', 'http://localhost/api/sessions/sess-1/messages');
    const res = await dispatchSessionRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as { messages: unknown[] };
    expect(body.messages).toBeInstanceOf(Array);
  });

  test('POST /api/sessions/:id/messages submits message and returns messageId', async () => {
    const handlers = makeSessionHandlers();
    const req = makeRequest('POST', 'http://localhost/api/sessions/sess-1/messages', {
      content: 'Run the tests',
    });
    const res = await dispatchSessionRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(typeof body.messageId).toBe('string'); // messageId is a string
  });

  test('POST /api/sessions/:id/close closes session', async () => {
    let capturedId: string | null = null;
    const handlers = makeSessionHandlers({
      closeSharedSession: (sessionId, _req) => {
        capturedId = sessionId;
        return Response.json({ ok: true, sessionId });
      },
    });
    const req = makeRequest('POST', 'http://localhost/api/sessions/sess-1/close');
    const res = await dispatchSessionRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(capturedId).toBe('sess-1');
    const body = await res!.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// describe: session routes — failure paths
// ---------------------------------------------------------------------------

describe('router-e2e session — failure paths', () => {
  test('returns null for unmatched path', async () => {
    const handlers = makeSessionHandlers();
    const req = makeRequest('GET', 'http://localhost/api/no-such-session-route');
    const res = await dispatchSessionRoutes(req, handlers);
    expect(res).toBeNull();
  });

  test('returns null for unknown sub-path on session', async () => {
    const handlers = makeSessionHandlers();
    const req = makeRequest('GET', 'http://localhost/api/sessions/sess-1/unknown-sub');
    const res = await dispatchSessionRoutes(req, handlers);
    expect(res).toBeNull();
  });

  test('POST /api/sessions/:id/inputs/:inputId/cancel cancels input', async () => {
    let capturedInput: string | null = null;
    const handlers = makeSessionHandlers({
      cancelSharedSessionInput: (sessionId, inputId, _req) => {
        capturedInput = inputId;
        return Response.json({ ok: true, sessionId, inputId });
      },
    });
    const req = makeRequest('POST', 'http://localhost/api/sessions/sess-1/inputs/input-99/cancel');
    const res = await dispatchSessionRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(capturedInput).toBe('input-99');
  });
});
