/**
 * companion-chat-routes.test.ts
 *
 * Tests for: create session, post message, SSE event stream, get session,
 * delete session. Uses a mock provider that returns deterministic text.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { CompanionChatManager } from '../packages/sdk/src/_internal/platform/companion/companion-chat-manager.js';
import { dispatchCompanionChatRoutes } from '../packages/sdk/src/_internal/platform/companion/companion-chat-routes.js';
import type {
  CompanionChatEventPublisher,
  CompanionChatManagerConfig,
  CompanionLLMProvider,
  CompanionProviderChunk,
} from '../packages/sdk/src/_internal/platform/companion/companion-chat-manager.js';
import type { CompanionChatRouteContext } from '../packages/sdk/src/_internal/platform/companion/companion-chat-route-types.js';

// ---------------------------------------------------------------------------
// Mock provider — returns deterministic chunks
// ---------------------------------------------------------------------------

function makeMockProvider(reply = 'Hello from assistant'): CompanionLLMProvider {
  return {
    async *chatStream() {
      const words = reply.split(' ');
      for (const word of words) {
        yield { type: 'text_delta', delta: word + ' ' } satisfies CompanionProviderChunk;
      }
      yield { type: 'done' } satisfies CompanionProviderChunk;
    },
  };
}

// ---------------------------------------------------------------------------
// Mock event publisher
// ---------------------------------------------------------------------------

function makeEventPublisher(): CompanionChatEventPublisher & {
  events: Array<{ event: string; payload: unknown; filter?: unknown }>;
} {
  const events: Array<{ event: string; payload: unknown; filter?: unknown }> = [];
  return {
    events,
    publishEvent(event, payload, filter?) {
      events.push({ event, payload, filter });
    },
  };
}

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

function makeContext(
  chatManager: CompanionChatManager,
  openSessionEventStream?: (req: Request, sessionId: string) => Response,
): CompanionChatRouteContext {
  return {
    chatManager,
    async parseJsonBody(req) {
      try {
        return await req.json();
      } catch {
        return new Response('Bad JSON', { status: 400 });
      }
    },
    async parseOptionalJsonBody(req) {
      const text = await req.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return new Response('Bad JSON', { status: 400 });
      }
    },
    openSessionEventStream: openSessionEventStream ?? ((_req, sessionId) => {
      return new Response(`data: connected sessionId=${sessionId}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('companion-chat-routes: create session', () => {
  let manager: CompanionChatManager;
  let publisher: ReturnType<typeof makeEventPublisher>;

  beforeEach(() => {
    publisher = makeEventPublisher();
    const config: CompanionChatManagerConfig = {
      provider: makeMockProvider(),
      eventPublisher: publisher,
      gcIntervalMs: 999_999,
    };
    manager = new CompanionChatManager(config);
  });

  test('POST /api/companion/chat/sessions returns 201 with sessionId', async () => {
    const req = makeRequest('POST', 'http://localhost/api/companion/chat/sessions', {
      title: 'Test session',
      model: 'claude-sonnet',
    });
    const ctx = makeContext(manager);
    const res = await dispatchCompanionChatRoutes(req, ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(201);
    const body = await res!.json();
    expect(typeof body.sessionId).toBe('string');
    expect(body.sessionId.length).toBeGreaterThan(0);
    expect(typeof body.createdAt).toBe('number');
  });

  test('POST /api/companion/chat/sessions with no body creates session with defaults', async () => {
    const req = new Request('http://localhost/api/companion/chat/sessions', { method: 'POST' });
    const ctx = makeContext(manager);
    const res = await dispatchCompanionChatRoutes(req, ctx);
    expect(res!.status).toBe(201);
    const body = await res!.json();
    expect(typeof body.sessionId).toBe('string');
  });

  test('GET /api/companion/chat/sessions/:id returns session + empty messages', async () => {
    // Create session first
    const createReq = makeRequest('POST', 'http://localhost/api/companion/chat/sessions', {});
    const ctx = makeContext(manager);
    const createRes = await dispatchCompanionChatRoutes(createReq, ctx);
    const { sessionId } = await createRes!.json();

    const getReq = makeRequest('GET', `http://localhost/api/companion/chat/sessions/${sessionId}`);
    const getRes = await dispatchCompanionChatRoutes(getReq, ctx);
    expect(getRes!.status).toBe(200);
    const body = await getRes!.json();
    expect(body.session.id).toBe(sessionId);
    expect(body.session.kind).toBe('companion-chat');
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages).toHaveLength(0);
  });

  test('GET unknown session returns 404', async () => {
    const ctx = makeContext(manager);
    const res = await dispatchCompanionChatRoutes(
      makeRequest('GET', 'http://localhost/api/companion/chat/sessions/no-such-session'),
      ctx,
    );
    expect(res!.status).toBe(404);
  });
});

describe('companion-chat-routes: post message and events', () => {
  let manager: CompanionChatManager;
  let publisher: ReturnType<typeof makeEventPublisher>;

  beforeEach(() => {
    publisher = makeEventPublisher();
    manager = new CompanionChatManager({
      provider: makeMockProvider('The answer is 42'),
      eventPublisher: publisher,
      gcIntervalMs: 999_999,
    });
  });

  test('POST message returns 202 with messageId', async () => {
    const ctx = makeContext(manager);
    // Create session
    const createRes = await dispatchCompanionChatRoutes(
      makeRequest('POST', 'http://localhost/api/companion/chat/sessions', {}),
      ctx,
    );
    const { sessionId } = await createRes!.json();

    // Post a message
    const msgRes = await dispatchCompanionChatRoutes(
      makeRequest('POST', `http://localhost/api/companion/chat/sessions/${sessionId}/messages`, {
        content: 'What is the answer?',
      }),
      ctx,
    );
    expect(msgRes!.status).toBe(202);
    const body = await msgRes!.json();
    expect(typeof body.messageId).toBe('string');
  });

  test('POST empty content returns 400', async () => {
    const ctx = makeContext(manager);
    const session = manager.createSession();
    const res = await dispatchCompanionChatRoutes(
      makeRequest('POST', `http://localhost/api/companion/chat/sessions/${session.id}/messages`, {
        content: '',
      }),
      ctx,
    );
    expect(res!.status).toBe(400);
  });

  test('events arrive in order: started -> deltas -> completed', async () => {
    const ctx = makeContext(manager);
    const session = manager.createSession();

    // Register a subscriber so events are routed
    manager.registerSubscriber(session.id, `client:${session.id}`);

    // Post message — turn runs async; we wait for turn.completed event
    await manager.postMessage(session.id, 'Hello');

    // Give the async turn a tick to complete
    await new Promise((r) => setTimeout(r, 50));

    const eventTypes = publisher.events.map((e) => {
      const payload = e.payload as { type?: string };
      return payload.type ?? e.event;
    });

    expect(eventTypes[0]).toBe('turn.started');
    // At least one delta
    expect(eventTypes.some((t) => t === 'turn.delta')).toBe(true);
    // Completed comes last
    expect(eventTypes[eventTypes.length - 1]).toBe('turn.completed');
  });

  test('GET events returns SSE response for active session', async () => {
    const ctx = makeContext(manager);
    const session = manager.createSession();
    const res = await dispatchCompanionChatRoutes(
      makeRequest('GET', `http://localhost/api/companion/chat/sessions/${session.id}/events`),
      ctx,
    );
    expect(res!.status).toBe(200);
    expect(res!.headers.get('content-type')).toContain('text/event-stream');
  });

  test('GET events for closed session returns 410', async () => {
    const ctx = makeContext(manager);
    const session = manager.createSession();
    manager.closeSession(session.id);
    const res = await dispatchCompanionChatRoutes(
      makeRequest('GET', `http://localhost/api/companion/chat/sessions/${session.id}/events`),
      ctx,
    );
    expect(res!.status).toBe(410);
  });

  test('non-companion paths return null (fall-through)', async () => {
    const ctx = makeContext(manager);
    const res = await dispatchCompanionChatRoutes(
      makeRequest('GET', 'http://localhost/api/sessions'),
      ctx,
    );
    expect(res).toBeNull();
  });
});

describe('companion-chat-routes: delete session', () => {
  test('DELETE closes session and returns 200', async () => {
    const publisher = makeEventPublisher();
    const manager = new CompanionChatManager({
      provider: makeMockProvider(),
      eventPublisher: publisher,
      gcIntervalMs: 999_999,
    });
    const ctx = makeContext(manager);
    const session = manager.createSession({ title: 'To delete' });

    const res = await dispatchCompanionChatRoutes(
      makeRequest('DELETE', `http://localhost/api/companion/chat/sessions/${session.id}`),
      ctx,
    );
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.status).toBe('closed');

    // Further messages should be rejected
    const msgRes = await dispatchCompanionChatRoutes(
      makeRequest('POST', `http://localhost/api/companion/chat/sessions/${session.id}/messages`, {
        content: 'Will fail',
      }),
      ctx,
    );
    expect(msgRes!.status).toBe(409);
  });

  test('DELETE unknown session returns 404', async () => {
    const manager = new CompanionChatManager({
      provider: makeMockProvider(),
      eventPublisher: makeEventPublisher(),
      gcIntervalMs: 999_999,
    });
    const ctx = makeContext(manager);
    const res = await dispatchCompanionChatRoutes(
      makeRequest('DELETE', 'http://localhost/api/companion/chat/sessions/ghost-id'),
      ctx,
    );
    expect(res!.status).toBe(404);
  });
});
