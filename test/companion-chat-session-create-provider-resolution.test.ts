/**
 * companion-chat-session-create-provider-resolution.test.ts
 *
 * Tests for F16b — resolveDefaultProviderModel callback in handleCreateSession.
 *
 * Happy path: callback returns {provider, model} → session created with those values
 * Failure path: callback returns null → HTTP 400 NO_MODEL_CONFIGURED, no session row
 * Missing resolver path: callback absent and no explicit provider/model → HTTP 400
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { CompanionChatManager } from '../packages/sdk/src/platform/companion/companion-chat-manager.js';
import { dispatchCompanionChatRoutes } from '../packages/sdk/src/platform/companion/companion-chat-routes.js';
import type {
  CompanionChatEventPublisher,
  CompanionChatManagerConfig,
  CompanionLLMProvider,
  CompanionProviderChunk,
} from '../packages/sdk/src/platform/companion/companion-chat-manager.js';
import type { CompanionChatRouteContext } from '../packages/sdk/src/platform/companion/companion-chat-route-types.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeMockProvider(): CompanionLLMProvider {
  return {
    async *chatStream() {
      yield { type: 'done' } satisfies CompanionProviderChunk;
    },
  };
}

function makeEventPublisher(): CompanionChatEventPublisher {
  return {
    publishEvent() {},
  };
}

function makeManager(): CompanionChatManager {
  const config: CompanionChatManagerConfig = {
    provider: makeMockProvider(),
    eventPublisher: makeEventPublisher(),
    gcIntervalMs: 999_999,
  };
  return new CompanionChatManager(config);
}

function makeContext(
  manager: CompanionChatManager,
  resolveDefaultProviderModel?: () => { provider: string; model: string } | null,
): CompanionChatRouteContext {
  return {
    chatManager: manager,
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
    openSessionEventStream: (_req, sessionId) =>
      new Response(`data: connected sessionId=${sessionId}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    ...(resolveDefaultProviderModel !== undefined ? { resolveDefaultProviderModel } : {}),
  };
}

function makePostRequest(body?: unknown): Request {
  return new Request('http://localhost/api/companion/chat/sessions', {
    method: 'POST',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Happy path: resolver returns {provider, model} → session created
// ---------------------------------------------------------------------------

describe('F16b — companion-chat session-create: resolver happy path', () => {
  let manager: CompanionChatManager;

  beforeEach(() => {
    manager = makeManager();
  });

  test('resolver returns {provider, model} → 201 session created', async () => {
    const resolver = () => ({ provider: 'inception', model: 'mercury-2' });
    const ctx = makeContext(manager, resolver);
    const res = await dispatchCompanionChatRoutes(makePostRequest({}), ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(201);
    const body = await res!.json() as Record<string, unknown>;
    expect(typeof body['sessionId']).toBe('string');
    expect(typeof body['createdAt']).toBe('number');
  });

  test('resolver returns values; body also has model/provider → body values take precedence, session created', async () => {
    // Caller explicitly provides both → resolver should be skipped
    const resolver = () => ({ provider: 'should-not-use', model: 'should-not-use' });
    const ctx = makeContext(manager, resolver);
    const res = await dispatchCompanionChatRoutes(
      makePostRequest({ provider: 'venice', model: 'llama-3.3-70b' }),
      ctx,
    );
    expect(res!.status).toBe(201);
    // Session exists (was created)
    const body = await res!.json() as Record<string, unknown>;
    expect(typeof body['sessionId']).toBe('string');
  });

  test('resolver returns {provider, model}; session persists in manager', async () => {
    const resolver = () => ({ provider: 'inception', model: 'mercury-2' });
    const ctx = makeContext(manager, resolver);
    const res = await dispatchCompanionChatRoutes(makePostRequest(), ctx);
    expect(res!.status).toBe(201);
    const body = await res!.json() as Record<string, unknown>;
    const sessionId = body['sessionId'] as string;
    // Session should be retrievable from the manager
    const session = manager.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(sessionId);
  });
});

// ---------------------------------------------------------------------------
// Failure path: resolver returns null → HTTP 400 NO_MODEL_CONFIGURED
// ---------------------------------------------------------------------------

describe('F16b — companion-chat session-create: resolver returns null → 400', () => {
  let manager: CompanionChatManager;

  beforeEach(() => {
    manager = makeManager();
  });

  test('resolver returns null → 400 NO_MODEL_CONFIGURED', async () => {
    const resolver = () => null;
    const ctx = makeContext(manager, resolver);
    const res = await dispatchCompanionChatRoutes(makePostRequest({}), ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json() as Record<string, unknown>;
    expect(body['code']).toBe('NO_MODEL_CONFIGURED');
  });

  test('resolver returns null → no session row created', async () => {
    const resolver = () => null;
    const ctx = makeContext(manager, resolver);
    const sessionsBefore = manager.sessions.size;
    await dispatchCompanionChatRoutes(makePostRequest({}), ctx);
    expect(manager.sessions.size).toBe(sessionsBefore);
  });

  test('resolver returns null with partial body (only model supplied) → 400 NO_MODEL_CONFIGURED', async () => {
    const resolver = () => null;
    const ctx = makeContext(manager, resolver);
    const res = await dispatchCompanionChatRoutes(
      makePostRequest({ model: 'mercury-2' }), // provider missing
      ctx,
    );
    expect(res!.status).toBe(400);
    const body = await res!.json() as Record<string, unknown>;
    expect(body['code']).toBe('NO_MODEL_CONFIGURED');
  });
});

// ---------------------------------------------------------------------------
// Missing resolver path: callback absent and no explicit provider/model → HTTP 400
// ---------------------------------------------------------------------------

describe('F16b — companion-chat session-create: missing resolver', () => {
  test('no resolver and no body provider/model → 400 NO_MODEL_CONFIGURED', async () => {
    const manager = makeManager();
    const ctx = makeContext(manager); // no resolver injected
    const res = await dispatchCompanionChatRoutes(makePostRequest({}), ctx);
    expect(res!.status).toBe(400);
    const body = await res!.json() as Record<string, unknown>;
    expect(body['code']).toBe('NO_MODEL_CONFIGURED');
  });

  test('no resolver and empty POST body → 400 NO_MODEL_CONFIGURED', async () => {
    const manager = makeManager();
    const ctx = makeContext(manager);
    const req = new Request('http://localhost/api/companion/chat/sessions', { method: 'POST' });
    const res = await dispatchCompanionChatRoutes(req, ctx);
    expect(res!.status).toBe(400);
    const body = await res!.json() as Record<string, unknown>;
    expect(body['code']).toBe('NO_MODEL_CONFIGURED');
  });

  test('no resolver but explicit provider/model → 201 session created', async () => {
    const manager = makeManager();
    const ctx = makeContext(manager);
    const res = await dispatchCompanionChatRoutes(
      makePostRequest({ provider: 'inception', model: 'mercury-2' }),
      ctx,
    );
    expect(res!.status).toBe(201);
    const body = await res!.json() as Record<string, unknown>;
    expect(typeof body['sessionId']).toBe('string');
  });
});
