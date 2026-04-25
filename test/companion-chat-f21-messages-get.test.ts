/**
 * companion-chat-f21-messages-get.test.ts
 *
 * Tests for F21 (SDK 0.21.36):
 *   1. `GET /api/companion/chat/sessions/:id/messages` returns `{sessionId, messages}` when session exists.
 *   2. Returns 404 `SESSION_NOT_FOUND` when session absent.
 *   3. Method catalog contains the companion-chat descriptors registered in `method-catalog-control-core.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { dispatchCompanionChatRoutes } from '../packages/sdk/src/_internal/platform/companion/companion-chat-routes.js';
import type { CompanionChatRouteContext } from '../packages/sdk/src/_internal/platform/companion/companion-chat-route-types.js';
import { GatewayMethodCatalog } from '../packages/sdk/src/_internal/platform/control-plane/method-catalog.js';

const FAKE_SESSION = {
  id: 'sess-test',
  kind: 'companion-chat',
  title: 'Chat',
  status: 'active' as const,
  createdAt: 1,
  updatedAt: 2,
  provider: 'inception',
  model: 'mercury-2',
  systemPrompt: null,
  closedAt: null,
  messageCount: 2,
};

const FAKE_MESSAGES = [
  { id: 'm1', sessionId: 'sess-test', role: 'user', content: 'ping', createdAt: 3 },
  { id: 'm2', sessionId: 'sess-test', role: 'assistant', content: 'pong', createdAt: 4 },
];

function makeCtx(options: { sessionExists: boolean }): CompanionChatRouteContext {
  return {
    chatManager: {
      createSession: () => { throw new Error('not expected'); },
      getSession: (id: string) => options.sessionExists && id === 'sess-test' ? FAKE_SESSION : null,
      getMessages: () => FAKE_MESSAGES,
      postMessage: async () => { throw new Error('not expected'); },
      closeSession: () => { throw new Error('not expected'); },
    },
    parseJsonBody: async () => ({}),
    parseOptionalJsonBody: async () => null,
    openSessionEventStream: () => new Response(null),
    resolveDefaultProviderModel: () => null,
  } as unknown as CompanionChatRouteContext;
}

describe('F21 — GET /api/companion/chat/sessions/:id/messages', () => {
  test('returns 200 with { sessionId, messages } when session exists', async () => {
    const ctx = makeCtx({ sessionExists: true });
    const req = new Request('http://localhost/api/companion/chat/sessions/sess-test/messages', { method: 'GET' });
    const res = await dispatchCompanionChatRoutes(req, ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as { sessionId: string; messages: unknown[] };
    expect(body.sessionId).toBe('sess-test');
    expect(body.messages).toHaveLength(2);
  });

  test('returns 404 SESSION_NOT_FOUND when session does not exist', async () => {
    const ctx = makeCtx({ sessionExists: false });
    const req = new Request('http://localhost/api/companion/chat/sessions/sess-absent/messages', { method: 'GET' });
    const res = await dispatchCompanionChatRoutes(req, ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
    const body = await res!.json() as { error: string; code: string };
    expect(body.code).toBe('SESSION_NOT_FOUND');
  });
});

describe('F21 — method catalog registers companion-chat methods', () => {
  test('listAll includes every companion.chat.* id', () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: true });
    const ids = catalog.list().map((m) => m.id);
    const expected = [
      'companion.chat.sessions.create',
      'companion.chat.sessions.get',
      'companion.chat.sessions.update',
      'companion.chat.sessions.delete',
      'companion.chat.messages.create',
      'companion.chat.messages.list',
      'companion.chat.events.stream',
    ];
    for (const id of expected) {
      expect(ids).toContain(id);
    }
  });

  test('companion.chat.messages.list descriptor targets the restored GET /messages path', () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: true });
    const desc = catalog.list().find((m) => m.id === 'companion.chat.messages.list');
    expect(desc).toBeDefined();
    expect(desc!.http).toEqual({ method: 'GET', path: '/api/companion/chat/sessions/{sessionId}/messages' });
  });
});
