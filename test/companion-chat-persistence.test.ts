/**
 * companion-chat-persistence.test.ts
 *
 * Verifies that CompanionChatManager persists sessions to disk and restores
 * them on re-instantiation (simulating daemon restart).
 *
 * P1: Sessions written during one manager lifetime load into a fresh instance.
 * P2: Messages (user + assistant) are restored in order.
 * P3: Closed sessions SURVIVE restart (closed-skip fix) and stay GC-eligible.
 * P4: Session directory is created if it does not exist.
 */

import { describe, expect, test } from 'bun:test';
import { settleEvents, withTestTimeout } from './_helpers/test-timeout.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionChatManager } from '../packages/sdk/src/platform/companion/companion-chat-manager.js';
import { CompanionChatPersistence } from '../packages/sdk/src/platform/companion/companion-chat-persistence.js';
import type { PersistedChatSession } from '../packages/sdk/src/platform/companion/companion-chat-persistence.js';
import type {
  CompanionLLMProvider,
  CompanionProviderChunk,
} from '../packages/sdk/src/platform/companion/companion-chat-manager.js';

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

function makeManager(
  sessionsDir: string,
  overrides: {
    readonly closedSessionMemoryGraceMs?: number;
    readonly closedSessionRetentionMs?: number;
  } = {},
): CompanionChatManager {
  return new CompanionChatManager({
    provider: makeMockProvider(),
    eventPublisher: { publishEvent() {} },
    gcIntervalMs: 999_999, // disable automatic GC
    persist: true, // explicitly opt into disk persistence — this file tests persistence behaviour
    sessionsDir,
    rateLimiter: false, // disable rate limiting in tests
    ...(overrides.closedSessionMemoryGraceMs !== undefined ? { closedSessionMemoryGraceMs: overrides.closedSessionMemoryGraceMs } : {}),
    ...(overrides.closedSessionRetentionMs !== undefined ? { closedSessionRetentionMs: overrides.closedSessionRetentionMs } : {}),
  });
}

function makePersistedSession(id: string): PersistedChatSession {
  const now = Date.now();
  return {
    meta: {
      id,
      kind: 'companion-chat',
      title: 'Chat',
      model: null,
      provider: null,
      systemPrompt: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      messageCount: 0,
    },
    messages: [],
  };
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
      await settleEvents();

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
      await settleEvents(100);

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
// P3: Closed sessions SURVIVE restart (closed-skip data-loss fix, S1 spine) and
// are HISTORY. The old behavior dropped closed sessions on reload — the exact
// "299 on-disk, serves 0" bug. They must now load (listable + importable). GC's
// deletion authority is SPLIT: it may evict message BODIES from memory after a
// grace (meta stays listable, on-disk copy untouched), but it must NOT delete
// the persisted file unless an explicit finite retention window is configured.
// ---------------------------------------------------------------------------

describe('P3: closed sessions survive restart and stay listable', () => {
  test('a session closed before shutdown loads after restart (closed-skip fix)', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-'));
    try {
      const managerA = makeManager(sessionsDir);
      await managerA.init();

      const session = managerA.createSession();
      managerA.closeSession(session.id);

      await settleEvents();
      managerA.dispose();

      // Restart
      const managerB = makeManager(sessionsDir);
      await managerB.init();

      // Closed sessions are now retained in a lightweight terminal state.
      const restored = managerB.getSession(session.id);
      expect(restored).not.toBeNull();
      expect(restored?.status).toBe('closed');
      // listSessions({includeClosed:true}) must not silently return fewer than on-disk.
      expect(managerB.listSessions({ includeClosed: true }).sessions.map((s) => s.id)).toContain(session.id);
      // Default list still hides closed sessions.
      expect(managerB.listSessions().sessions.map((s) => s.id)).not.toContain(session.id);

      managerB.dispose();
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  test('default retention: an ancient-closed session survives the sweep — listable and on disk', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-gc-'));
    try {
      // Seed a closed session whose closedAt is well past the OLD 5-min grace.
      const stale: PersistedChatSession = {
        meta: {
          id: 'stale-closed', kind: 'companion-chat', title: 'Stale', model: null, provider: null,
          systemPrompt: null, status: 'closed', createdAt: 1, updatedAt: 1,
          closedAt: Date.now() - 10 * 60_000, messageCount: 0,
        },
        messages: [],
      };
      await new CompanionChatPersistence(sessionsDir).save(stale);

      const manager = makeManager(sessionsDir); // default retention = indefinite
      await manager.init();
      expect(manager.getSession('stale-closed')).not.toBeNull();
      // Sweep runs but must NOT delete under the default (retain indefinitely).
      manager._gcSweep();
      expect(manager.getSession('stale-closed')).not.toBeNull();
      expect(manager.listSessions({ includeClosed: true }).sessions.map((s) => s.id)).toContain('stale-closed');
      manager.dispose();

      // Still on disk — a fresh manager reloads it.
      const reloaded = makeManager(sessionsDir);
      await reloaded.init();
      expect(reloaded.getSession('stale-closed')).not.toBeNull();
      reloaded.dispose();
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  test('memory eviction: an ancient-closed session drops its message bodies from RAM but keeps meta + disk', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-evict-'));
    try {
      const stale: PersistedChatSession = {
        meta: {
          id: 'evict-me', kind: 'companion-chat', title: 'Evict', model: null, provider: null,
          systemPrompt: null, status: 'closed', createdAt: 1, updatedAt: 1,
          closedAt: Date.now() - 10 * 60_000, messageCount: 2,
        },
        messages: [
          { id: 'm1', sessionId: 'evict-me', role: 'user', content: 'hi', attachments: [], createdAt: 2 },
          { id: 'm2', sessionId: 'evict-me', role: 'assistant', content: 'yo', attachments: [], createdAt: 3 },
        ],
      };
      await new CompanionChatPersistence(sessionsDir).save(stale);

      const manager = makeManager(sessionsDir, { closedSessionMemoryGraceMs: 5 * 60_000 });
      await manager.init();
      expect(manager.getMessages('evict-me')).toHaveLength(2);

      manager._gcSweep(); // past grace → evict bodies from memory
      // Meta stays listable; bodies gone from RAM.
      expect(manager.getSession('evict-me')?.status).toBe('closed');
      expect(manager.getMessages('evict-me')).toHaveLength(0);
      // meta.messageCount stays honest (the logical total).
      expect(manager.getSession('evict-me')?.messageCount).toBe(2);
      manager.dispose();

      // On-disk copy is UNTOUCHED — a fresh manager restores the bodies.
      const reloaded = makeManager(sessionsDir);
      await reloaded.init();
      expect(reloaded.getMessages('evict-me')).toHaveLength(2);
      reloaded.dispose();
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  test('explicit retention window: a closed session past the window IS deleted (opt-in)', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-retain-'));
    try {
      const stale: PersistedChatSession = {
        meta: {
          id: 'retire-me', kind: 'companion-chat', title: 'Retire', model: null, provider: null,
          systemPrompt: null, status: 'closed', createdAt: 1, updatedAt: 1,
          closedAt: Date.now() - 10 * 60_000, messageCount: 0,
        },
        messages: [],
      };
      await new CompanionChatPersistence(sessionsDir).save(stale);

      const manager = makeManager(sessionsDir, { closedSessionRetentionMs: 5 * 60_000 });
      await manager.init();
      expect(manager.getSession('retire-me')).not.toBeNull();
      manager._gcSweep(); // past the finite retention window → delete
      await settleEvents();
      expect(manager.getSession('retire-me')).toBeNull();
      manager.dispose();

      // Deleted from disk too.
      const reloaded = makeManager(sessionsDir);
      await reloaded.init();
      expect(reloaded.getSession('retire-me')).toBeNull();
      reloaded.dispose();
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
      await settleEvents();

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

// ---------------------------------------------------------------------------
// P5: Persistence failures reject instead of pretending success
// ---------------------------------------------------------------------------

describe('P5: persistence failures are observable', () => {
  test('save rejects when the atomic rename target cannot be replaced', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-'));
    try {
      const persistence = new CompanionChatPersistence(sessionsDir);
      mkdirSync(join(sessionsDir, 'blocked.json'));

      await expect(persistence.save(makePersistedSession('blocked'))).rejects.toThrow(
        'Companion chat session save failed for blocked',
      );
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  test('delete rejects when the session path cannot be unlinked', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-'));
    try {
      const persistence = new CompanionChatPersistence(sessionsDir);
      mkdirSync(join(sessionsDir, 'blocked.json'));

      await expect(persistence.delete('blocked')).rejects.toThrow(
        'Companion chat session delete failed for blocked',
      );
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// P6: deleteSession never loses a race against closeSession's fire-and-forget
// persist save (Wave-5 F1 regression). closeSession schedules its save via
// _persist() without awaiting it, so a caller that immediately follows close
// with delete (the webui's normal close-then-delete sequence) can have that
// save's write+rename still in flight when the delete would unlink. Forcing
// the save to hang on a controllable gate makes the race deterministic:
// deleteSession must drain the in-flight save BEFORE it unlinks, so the file
// never gets resurrected after "delete" reports success.
// ---------------------------------------------------------------------------

describe('P6: deleteSession drains an in-flight close-time save before unlinking', () => {
  test('a gated close-time save cannot resurrect the file after delete, even across a simulated restart', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'companion-persist-race-'));
    try {
      const manager = makeManager(sessionsDir);
      await manager.init();

      const session = manager.createSession();
      // Let the create-time save land so the file genuinely exists first.
      await settleEvents();
      const filePath = join(sessionsDir, `${session.id}.json`);
      expect(existsSync(filePath)).toBe(true);

      // Gate the persistence layer's save() so we control exactly when the
      // close-time write actually reaches disk.
      const persistence = (manager as unknown as {
        persistence: { save(session: PersistedChatSession): Promise<void> };
      }).persistence;
      const realSave = persistence.save.bind(persistence);
      let releaseSave: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { releaseSave = resolve; });
      let saveEntered = false;
      persistence.save = async (persisted: PersistedChatSession): Promise<void> => {
        saveEntered = true;
        await gate;
        return realSave(persisted);
      };

      // Close: schedules the (now-gated) fire-and-forget persist save.
      manager.closeSession(session.id);
      await settleEvents(10); // let the save chain reach the gate
      expect(saveEntered).toBe(true);

      // Fire delete WHILE the close-time save is still gated open (in flight).
      const deletePromise = manager.deleteSession(session.id);

      // Give delete every chance to race ahead if it were going to: it must
      // NOT have unlinked the file yet, because the save it must drain is
      // still blocked on our gate.
      await settleEvents(20);
      expect(existsSync(filePath)).toBe(true);

      // Now release the gate — the drained save completes its write, and
      // only then should deleteSession proceed to unlink.
      releaseSave!();
      const result = await withTestTimeout(deletePromise, 2_000, 'deleteSession did not settle after the gated save was released');
      expect(result).toEqual({ sessionId: session.id, deleted: true });

      // The resurrected-then-deleted file must be gone, not resurrected.
      expect(existsSync(filePath)).toBe(false);
      await settleEvents();
      expect(existsSync(filePath)).toBe(false);

      manager.dispose();

      // Simulated re-init (fresh manager instance, same dir) must not reload
      // the deleted session — proving there's no leftover file to reload.
      const reloaded = makeManager(sessionsDir);
      await reloaded.init();
      expect(reloaded.getSession(session.id)).toBeNull();
      reloaded.dispose();
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});
