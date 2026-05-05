/**
 * companion-chat-lifecycle.test.ts
 *
 * Verifies the session lifecycle:
 * L1: create → message → close — happy path
 * L2: closed sessions reject further messages with 409
 * L3: sessions that were never found return 404
 * L4: idle GC closes empty sessions after idleEmptyMs
 * L5: idle GC closes content sessions after idleActiveMs
 * L6: GC leaves sessions with recent activity alone
 */

import { describe, expect, test } from 'bun:test';
import { settleEvents } from './_helpers/test-timeout.js';
import { CompanionChatManager } from '../packages/sdk/src/platform/companion/companion-chat-manager.js';
import type {
  CompanionLLMProvider,
  CompanionProviderChunk,
} from '../packages/sdk/src/platform/companion/companion-chat-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockProvider(reply = 'response'): CompanionLLMProvider {
  return {
    async *chatStream() {
      yield { type: 'text_delta', delta: reply } satisfies CompanionProviderChunk;
      yield { type: 'done' } satisfies CompanionProviderChunk;
    },
  };
}

function makeManager(overrides: { idleActiveMs?: number; idleEmptyMs?: number } = {}): CompanionChatManager {
  return new CompanionChatManager({
    provider: makeMockProvider(),
    eventPublisher: { publishEvent() {} },
    gcIntervalMs: 999_999, // disable automatic GC; we call _gcSweep() manually
    idleActiveMs: overrides.idleActiveMs ?? 30 * 60_000,
    idleEmptyMs: overrides.idleEmptyMs ?? 5 * 60_000,
  });
}

// ---------------------------------------------------------------------------
// L1: Happy path
// ---------------------------------------------------------------------------

describe('L1: create → message → close lifecycle', () => {
  test('full lifecycle completes without error', async () => {
    const manager = makeManager();

    const session = manager.createSession({ title: 'My chat', provider: 'anthropic', model: 'claude-sonnet' });
    expect(session.id).not.toBe('');
    expect(session.kind).toBe('companion-chat');
    expect(session.status).toBe('active');

    // Post a message
    const messageId = await manager.postMessage(session.id, 'Hello');
    expect(typeof messageId).toBe('string');

    // Give async turn a tick
    await settleEvents();

    // Messages should include user + assistant
    const messages = manager.getMessages(session.id);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toBe('Hello');

    // Close
    const closed = manager.closeSession(session.id);
    expect(closed?.status).toBe('closed');
    expect(typeof closed?.closedAt).toBe('number');

    // getSession still returns the closed session
    const retrieved = manager.getSession(session.id);
    expect(retrieved?.status).toBe('closed');
  });

  test('session metadata is correct immediately after creation', () => {
    const manager = makeManager();
    const session = manager.createSession({ title: 'Test', model: 'gpt-5', provider: 'openai', systemPrompt: 'Be helpful' });
    expect(session.kind).toBe('companion-chat');
    expect(session.title).toBe('Test');
    expect(session.model).toBe('gpt-5');
    expect(session.provider).toBe('openai');
    expect(session.systemPrompt).toBe('Be helpful');
    expect(session.status).toBe('active');
    expect(session.messageCount).toBe(0);
  });

  test('session route metadata requires provider and model together', () => {
    const manager = makeManager();
    expect(() => manager.createSession({ title: 'Partial route', model: 'gpt-5' })).toThrow(
      'provider and model must be supplied together',
    );
  });
});

// ---------------------------------------------------------------------------
// L2: Closed sessions reject messages with 409
// ---------------------------------------------------------------------------

describe('L2: closed sessions reject further messages', () => {
  test('postMessage on a closed session throws with status 409', async () => {
    const manager = makeManager();
    const session = manager.createSession();
    manager.closeSession(session.id);

    await expect(manager.postMessage(session.id, 'should fail')).rejects.toMatchObject({
      status: 409,
      code: 'SESSION_CLOSED',
    });
  });

  test('closing an already-closed session is idempotent (returns session, status still closed)', () => {
    const manager = makeManager();
    const session = manager.createSession();
    const first = manager.closeSession(session.id);
    const second = manager.closeSession(session.id);
    expect(first?.status).toBe('closed');
    expect(second?.status).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// L3: Non-existent sessions return 404
// ---------------------------------------------------------------------------

describe('L3: non-existent sessions', () => {
  test('getSession returns null for unknown id', () => {
    const manager = makeManager();
    expect(manager.getSession('no-such-id')).toBeNull();
  });

  test('postMessage on unknown session throws with status 404', async () => {
    const manager = makeManager();
    await expect(manager.postMessage('no-such-id', 'hello')).rejects.toMatchObject({
      status: 404,
      code: 'SESSION_NOT_FOUND',
    });
  });

  test('closeSession returns null for unknown id', () => {
    const manager = makeManager();
    expect(manager.closeSession('ghost')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// L4: GC closes empty sessions after idleEmptyMs
// ---------------------------------------------------------------------------

describe('L4: GC closes empty idle sessions', () => {
  test('empty session idle beyond idleEmptyMs is closed by _gcSweep()', () => {
    const manager = makeManager({ idleEmptyMs: 100 });
    const session = manager.createSession();
    expect(session.status).toBe('active');
    expect(manager.getMessages(session.id)).toHaveLength(0);

    // Manually age the session by directly mutating lastActivityAt
    // (Testing internal state via the GC sweep interface.)
    // We call _gcSweep after waiting slightly more than idleEmptyMs.
    // Since Jest/bun fake timers are not always available, we use a real wait.
    // The idleEmptyMs is 100ms so this should be fast.
    const internalSessions = (manager as unknown as { sessions: Map<string, { lastActivityAt: number }> }).sessions;
    const internal = internalSessions.get(session.id);
    if (internal) internal.lastActivityAt = Date.now() - 200;

    manager._gcSweep();

    const retrieved = manager.getSession(session.id);
    expect(retrieved?.status).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// L5: GC closes content sessions after idleActiveMs
// ---------------------------------------------------------------------------

describe('L5: GC closes active sessions after idleActiveMs', () => {
  test('session with messages idle beyond idleActiveMs is closed by _gcSweep()', async () => {
    const manager = makeManager({ idleActiveMs: 100 });
    const session = manager.createSession();

    await manager.postMessage(session.id, 'Hello');
    await settleEvents();

    expect(manager.getMessages(session.id).map((message) => message.role)).toEqual(['user', 'assistant']);

    // Age the session
    const internalSessions = (manager as unknown as { sessions: Map<string, { lastActivityAt: number }> }).sessions;
    const internal = internalSessions.get(session.id);
    if (internal) internal.lastActivityAt = Date.now() - 200;

    manager._gcSweep();

    expect(manager.getSession(session.id)?.status).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// L6: GC leaves recently-active sessions alone
// ---------------------------------------------------------------------------

describe('L6: GC does not close recently-active sessions', () => {
  test('session with recent activity survives _gcSweep()', async () => {
    const manager = makeManager({ idleEmptyMs: 100, idleActiveMs: 100 });
    const session = manager.createSession();

    await manager.postMessage(session.id, 'Recent message');
    await settleEvents(20);

    // lastActivityAt is fresh (< 100ms ago)
    manager._gcSweep();

    expect(manager.getSession(session.id)?.status).toBe('active');
  });
});
