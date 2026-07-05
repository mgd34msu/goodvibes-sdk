/**
 * session-history-inversion-guard.test.ts
 *
 * BLOCKER inversion guard: closed sessions are HISTORY. This is the exact
 * "299 on disk, serves 0" scenario expressed as a test. Seed many closed
 * sessions whose closedAt is ancient (far past any grace), boot, run the GC
 * sweep repeatedly, and assert that ALL of them remain listable and on disk —
 * memory eviction may drop bodies, but nothing is ever deleted off disk by the
 * default sweep. Covers BOTH deletion authorities: the companion manager
 * (_gcSweep) and the broker (gcSweep / sweepSharedSessions).
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionChatManager } from '../packages/sdk/src/platform/companion/companion-chat-manager.ts';
import { CompanionChatPersistence } from '../packages/sdk/src/platform/companion/companion-chat-persistence.ts';
import type { PersistedChatSession } from '../packages/sdk/src/platform/companion/companion-chat-persistence.ts';
import type {
  CompanionLLMProvider,
  CompanionProviderChunk,
} from '../packages/sdk/src/platform/companion/companion-chat-manager.ts';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.ts';
import { RouteBindingManager } from '../packages/sdk/src/platform/channels/index.ts';

const N = 299;
const ANCIENT = Date.now() - 24 * 60 * 60_000; // a full day past close

function mockProvider(): CompanionLLMProvider {
  return {
    async *chatStream() {
      yield { type: 'done' } satisfies CompanionProviderChunk;
    },
  };
}

function makeManager(sessionsDir: string): CompanionChatManager {
  return new CompanionChatManager({
    provider: mockProvider(),
    eventPublisher: { publishEvent() {} },
    gcIntervalMs: 999_999,
    persist: true,
    sessionsDir,
    rateLimiter: false,
    closedSessionMemoryGraceMs: 5 * 60_000,
    // closedSessionRetentionMs omitted → default retain indefinitely.
  });
}

function ancientClosedChat(id: string, messageCount: number): PersistedChatSession {
  return {
    meta: {
      id, kind: 'companion-chat', title: `Chat ${id}`, model: null, provider: null,
      systemPrompt: null, status: 'closed', createdAt: 1, updatedAt: ANCIENT,
      closedAt: ANCIENT, messageCount,
    },
    messages: Array.from({ length: messageCount }, (_v, i) => ({
      id: `${id}-m${i}`, sessionId: id, role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `${id} body ${i}`, attachments: [], createdAt: 2 + i,
    })),
  };
}

function makeBroker(storePath: string): SharedSessionBroker {
  return new SharedSessionBroker({
    storePath,
    routeBindings: { start: async () => {}, patchBinding: async () => null, getBinding: () => null } as unknown as RouteBindingManager,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: () => true },
  } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]);
}

describe('inversion guard — the 299-closed-chat scenario is never mass-deleted', () => {
  test('companion manager: boot → advance past grace → sweep×3 → all 299 still listable + on disk, memory bounded', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'inversion-companion-'));
    try {
      const persistence = new CompanionChatPersistence(sessionsDir);
      for (let i = 0; i < N; i++) {
        // Half carry message bodies (eviction candidates), half are empty.
        await persistence.save(ancientClosedChat(`chat-${i}`, i % 2 === 0 ? 6 : 0));
      }

      const manager = makeManager(sessionsDir);
      await manager.init();
      // Every closed session loaded and listable.
      expect(manager.listSessions({ includeClosed: true, limit: 1000 }).sessions).toHaveLength(N);

      // Run the sweep repeatedly (idempotent) — the closedAt is a day old.
      manager._gcSweep();
      manager._gcSweep();
      manager._gcSweep();

      const listed = manager.listSessions({ includeClosed: true, limit: 1000 }).sessions;
      expect(listed).toHaveLength(N); // NOTHING deleted
      for (const s of listed) expect(s.status).toBe('closed');

      // Memory bounded: bodies evicted from RAM for every session that had them.
      let bodiesInMemory = 0;
      for (let i = 0; i < N; i++) bodiesInMemory += manager.getMessages(`chat-${i}`).length;
      expect(bodiesInMemory).toBe(0);
      // But meta.messageCount stays honest for the ones that had bodies.
      expect(manager.getSession('chat-0')?.messageCount).toBe(6);
      manager.dispose();

      // On disk untouched: a fresh boot restores all 299 AND their bodies.
      const reloaded = makeManager(sessionsDir);
      await reloaded.init();
      expect(reloaded.listSessions({ includeClosed: true, limit: 1000 }).sessions).toHaveLength(N);
      expect(reloaded.getMessages('chat-0')).toHaveLength(6);
      reloaded.dispose();
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  test('broker: boot → backdate closedAt → gcSweep×3 → all 299 still listable + survive restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inversion-broker-'));
    try {
      const storePath = join(dir, 'sessions.json');
      const seed = makeBroker(storePath);
      for (let i = 0; i < N; i++) {
        const s = await seed.createSession({ id: `sess-${i}`, kind: 'tui', project: '/p' });
        await seed.closeSession(s.id);
      }

      const broker = makeBroker(storePath);
      await broker.start();
      const store = broker as unknown as {
        sessions: Map<string, { closedAt?: number; updatedAt: number }>;
        gcSweep: () => void;
      };
      // Backdate every closedAt a full day and run the sweep repeatedly.
      for (const [id, rec] of store.sessions) store.sessions.set(id, { ...rec, closedAt: ANCIENT });
      store.gcSweep();
      store.gcSweep();
      store.gcSweep();

      const listed = broker.listSessions(1000, { includeClosed: true });
      expect(listed).toHaveLength(N); // NOTHING deleted under default retention
      for (const s of listed) expect(s.status).toBe('closed');

      // Survives a restart from disk.
      const fresh = makeBroker(storePath);
      await fresh.start();
      expect(fresh.listSessions(1000, { includeClosed: true })).toHaveLength(N);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
