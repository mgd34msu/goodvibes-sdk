/**
 * session-store-importer.test.ts
 *
 * One-Platform Wave 1, S1 — the migration importer. Folds ALL THREE legacy store
 * classes (299-style companion dir + per-project broker store + stale agent store)
 * into the ONE home store, idempotently, with no session dropped (closed included),
 * and tolerating corrupt files.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverLegacySessionSources,
  importLegacySessionStores,
} from '../packages/sdk/src/platform/control-plane/index.ts';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.ts';
import { CompanionChatPersistence } from '../packages/sdk/src/platform/companion/companion-chat-persistence.ts';
import type { PersistedChatSession } from '../packages/sdk/src/platform/companion/companion-chat-persistence.ts';
import { RouteBindingManager } from '../packages/sdk/src/platform/channels/index.ts';

function makeBroker(storePath: string): SharedSessionBroker {
  return new SharedSessionBroker({
    storePath,
    routeBindings: { start: async () => {}, patchBinding: async () => null, getBinding: () => null } as unknown as RouteBindingManager,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: () => true },
  } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]);
}

function companionSession(id: string, status: 'active' | 'closed'): PersistedChatSession {
  const now = Date.now();
  return {
    meta: {
      id, kind: 'companion-chat', title: `Chat ${id}`, model: null, provider: null,
      systemPrompt: null, status, createdAt: now, updatedAt: now,
      closedAt: status === 'closed' ? now : null, messageCount: 1,
    },
    messages: [{ id: `${id}-m1`, sessionId: id, role: 'user', content: 'hello', createdAt: now }],
  };
}

interface Fixture {
  readonly root: string;
  readonly projectRoot: string;
  readonly companionDir: string;
  readonly homeStorePath: string;
}

async function buildFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'importer-'));
  const projectRoot = join(root, 'projA');
  const companionDir = join(root, 'home', '.goodvibes', 'companion-chat', 'sessions');
  const homeStorePath = join(root, 'home', '.goodvibes', 'control-plane', 'sessions.json');

  // 1) Companion dir — active + closed (the 299-style, closed-inclusive class).
  const persistence = new CompanionChatPersistence(companionDir);
  await persistence.save(companionSession('comp-active', 'active'));
  await persistence.save(companionSession('comp-closed', 'closed'));

  // 2) Per-project broker store under the 'goodvibes' surface (created without a
  //    project field, so the importer must stamp project = projectRoot).
  const goodvibesStore = join(projectRoot, '.goodvibes', 'goodvibes', 'control-plane', 'sessions.json');
  const broker = makeBroker(goodvibesStore);
  await broker.createSession({ id: 'tui-a' });
  const closedTui = await broker.createSession({ id: 'tui-closed' });
  await broker.closeSession(closedTui.id);

  // 3) Stale agent store under the 'agent' surface.
  const agentStore = join(projectRoot, '.goodvibes', 'agent', 'control-plane', 'sessions.json');
  const agentBroker = makeBroker(agentStore);
  await agentBroker.createSession({ id: 'agent-a', kind: 'agent' });

  return { root, projectRoot, companionDir, homeStorePath };
}

describe('migration importer — folds all three legacy stores into one home store', () => {
  test('no session left behind (closed included), correct kinds + projects, then re-run is a no-op', async () => {
    const fx = await buildFixture();
    try {
      const sources = discoverLegacySessionSources({
        projectRoot: fx.projectRoot,
        companionSessionsDir: fx.companionDir,
      });

      const first = await importLegacySessionStores({ homeStorePath: fx.homeStorePath, sources });
      // All 5 sessions imported: 2 companion (1 closed) + 2 project (1 closed) + 1 agent.
      expect(first.total).toBe(5);
      expect(first.imported).toBe(5);

      const home = makeBroker(fx.homeStorePath);
      await home.start();
      const byId = new Map(home.listSessions(500).map((s) => [s.id, s]));

      // Every source id present — closed ones too.
      for (const id of ['comp-active', 'comp-closed', 'tui-a', 'tui-closed', 'agent-a']) {
        expect(byId.has(id)).toBe(true);
      }
      expect(byId.get('comp-closed')?.status).toBe('closed');
      expect(byId.get('tui-closed')?.status).toBe('closed');

      // Kinds preserved from each source.
      expect(byId.get('comp-active')?.kind).toBe('companion-chat');
      expect(byId.get('agent-a')?.kind).toBe('agent');

      // Projects: broker-store records stamped with the project root; companion → 'unknown'.
      expect(byId.get('tui-a')?.project).toBe(fx.projectRoot);
      expect(byId.get('agent-a')?.project).toBe(fx.projectRoot);
      expect(byId.get('comp-closed')?.project).toBe('unknown');

      // Companion message survived the conversion.
      expect(home.getMessages('comp-active', 10).map((m) => m.body)).toContain('hello');

      // Idempotency: a second run adds nothing and drops nothing.
      const second = await importLegacySessionStores({ homeStorePath: fx.homeStorePath, sources });
      expect(second.total).toBe(5);
      expect(second.imported).toBe(0);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test('a corrupt companion file is logged and skipped; the run completes', async () => {
    const fx = await buildFixture();
    try {
      writeFileSync(join(fx.companionDir, 'broken.json'), '{ not valid json');
      const sources = discoverLegacySessionSources({
        projectRoot: fx.projectRoot,
        companionSessionsDir: fx.companionDir,
      });
      const result = await importLegacySessionStores({ homeStorePath: fx.homeStorePath, sources });
      // Run still completes and imports the good sessions despite the broken file.
      expect(result.total).toBe(5);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test('missing sources are reported, not fatal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'importer-missing-'));
    try {
      const homeStorePath = join(root, 'home', '.goodvibes', 'control-plane', 'sessions.json');
      const result = await importLegacySessionStores({
        homeStorePath,
        sources: [{ kind: 'broker-store', path: join(root, 'nope', 'sessions.json'), project: '/x' }],
      });
      expect(result.imported).toBe(0);
      expect(result.missingSources).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
