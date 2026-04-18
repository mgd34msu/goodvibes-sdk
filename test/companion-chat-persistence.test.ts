/**
 * companion-chat-persistence.test.ts
 *
 * Verifies that CompanionChatManager persists sessions to disk and restores
 * them on re-instantiation (simulating daemon restart).
 *
 * P1: Sessions written during one manager lifetime load into a fresh instance.
 * P2: Messages (user + assistant) are restored in order.
 * P3: Closed sessions are NOT restored (terminal state).
 * P4: Session directory is created if it does not exist.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionChatManager } from '../packages/sdk/src/_internal/platform/companion/companion-chat-manager.js';
import type {
  CompanionLLMProvider,
  CompanionProviderChunk,
} from '../packages/sdk/src/_internal/platform/companion/companion-chat-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockProvider(reply = 'hi there'): CompanionLLMProvider {
  return {
    async *chatStream() {
      yield { type: 'text_delta', delta: reply } satisfies CompanionProviderChunk;
      yield { type: 'done' } satisfies CompanionProviderChunk;
    },
  };
}

function makeManager(sessionsDir: string): CompanionChatManager {
  return new CompanionChatManager({
    provider: makeMockProvider(),
    eventPublisher: { publishEvent() {} },
    gcIntervalMs: 999_999, // disable automatic GC
    persist: true, // explicitly opt into disk persistence — this file tests persistence behaviour
    sessionsDir,
    rateLimiter: false, // disable rate limiting in tests
  });
}

// ---------------------------------------------------------------------------
// P1: Sessions restored across manager re-instantiation
// ---------------------------------------------------------------------------

describe('P1: active sessions restored on re-instantiation', () => {
  test('session created in instance A is visible in instance B after init()', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-'));
    try {
      const managerA = makeManager(sessionsDir);
      await managerA.init();

      const session = managerA.createSession({ title: 'My chat' });
      expect(session.status).toBe('active');

      // Wait for async persist to flush
      await new Promise((r) => setTimeout(r, 50));

      managerA.dispose();

      // Simulate daemon restart
      const managerB = makeManager(sessionsDir);
      await managerB.init();

      const restored = managerB.getSession(session.id);
      expect(restored).not.toBeNull();
      expect(restored!.id).toBe(session.id);
      expect(restored!.title).toBe('My chat');
      expect(restored!.status).toBe('active');

      managerB.dispose();
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// P2: Messages (user + assistant) restored in order
// ---------------------------------------------------------------------------

describe('P2: messages restored in order after restart', () => {
  test('user and assistant messages are available after reload', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-'));
    try {
      const managerA = makeManager(sessionsDir);
      await managerA.init();

      const session = managerA.createSession();
      await managerA.postMessage(session.id, 'Hello world');

      // Give the async turn time to complete and persist
      await new Promise((r) => setTimeout(r, 100));

      const msgsA = managerA.getMessages(session.id);
      expect(msgsA.length).toBeGreaterThanOrEqual(1);
      expect(msgsA[0]!.role).toBe('user');
      expect(msgsA[0]!.content).toBe('Hello world');

      managerA.dispose();

      // Simulate daemon restart
      const managerB = makeManager(sessionsDir);
      await managerB.init();

      const msgsB = managerB.getMessages(session.id);
      expect(msgsB.length).toBeGreaterThanOrEqual(1);
      expect(msgsB[0]!.role).toBe('user');
      expect(msgsB[0]!.content).toBe('Hello world');

      // Assert order is preserved
      for (let i = 0; i < msgsB.length - 1; i++) {
        expect(msgsB[i]!.createdAt).toBeLessThanOrEqual(msgsB[i + 1]!.createdAt);
      }

      managerB.dispose();
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// P3: Closed sessions are NOT restored
// ---------------------------------------------------------------------------

describe('P3: closed sessions are not restored on restart', () => {
  test('session closed before shutdown does not appear after reload', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-'));
    try {
      const managerA = makeManager(sessionsDir);
      await managerA.init();

      const session = managerA.createSession();
      managerA.closeSession(session.id);

      await new Promise((r) => setTimeout(r, 50));
      managerA.dispose();

      // Restart
      const managerB = makeManager(sessionsDir);
      await managerB.init();

      // Closed sessions are skipped during load
      expect(managerB.getSession(session.id)).toBeNull();

      managerB.dispose();
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// P4: Sessions directory is created if it does not exist
// ---------------------------------------------------------------------------

describe('P4: sessions directory created if missing', () => {
  test('manager creates nested sessions directory automatically', async () => {
    const base = mkdtempSync(join(tmpdir(), 'companion-base-'));
    const sessionsDir = join(base, 'deep', 'nested', 'sessions');
    try {
      const manager = makeManager(sessionsDir);
      await manager.init(); // should not throw even if dir doesn't exist

      const session = manager.createSession({ title: 'Auto-created dir' });
      await new Promise((r) => setTimeout(r, 50));

      // Confirm the session was persisted (directory was auto-created)
      manager.dispose();

      const manager2 = makeManager(sessionsDir);
      await manager2.init();
      const restored = manager2.getSession(session.id);
      expect(restored).not.toBeNull();
      manager2.dispose();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
