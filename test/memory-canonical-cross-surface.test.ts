import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  MemoryEmbeddingProviderRegistry,
  MemoryStore,
  resolveCanonicalMemoryDbPath,
  foldMemoryStores,
} from '../packages/sdk/src/platform/state/index.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';

/**
 * Memory unification — one canonical cross-surface memory store.
 *
 * Proves the core outcome under the ruled model (shared canonical path,
 * sequential/owned access — never a naive concurrent shared-file write):
 *   1. A record written by one surface recalls from another surface that opens the
 *      SAME canonical path.
 *   2. The fold/migration path folds every legacy per-surface store into the
 *      canonical store with NO loss, is id-keyed (no overwrite), and is idempotent.
 */

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function embeddingRegistry(root: string): MemoryEmbeddingProviderRegistry {
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  return new MemoryEmbeddingProviderRegistry({ configManager });
}

function openStore(dbPath: string, registry: MemoryEmbeddingProviderRegistry): MemoryStore {
  return new MemoryStore(dbPath, { embeddingRegistry: registry, enableVectorIndex: false });
}

describe('canonical memory path', () => {
  test('resolves the single shared path under the home dir', () => {
    const path = resolveCanonicalMemoryDbPath('/home/user');
    expect(path).toBe('/home/user/.goodvibes/shared/memory.sqlite');
  });
});

describe('cross-surface recall (E6 core outcome)', () => {
  test('a record written by one surface recalls from another on the same canonical path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-e6-xsurface-'));
    tmpRoots.push(root);
    const canonicalPath = resolveCanonicalMemoryDbPath(root);
    const registry = embeddingRegistry(root);

    // Surface A (e.g. the agent) writes.
    const surfaceA = openStore(canonicalPath, registry);
    await surfaceA.init();
    const written = await surfaceA.add({
      scope: 'project',
      cls: 'fact',
      summary: 'the deploy command is `bun run ship`',
    });
    await surfaceA.save();
    surfaceA.close();

    // Surface B (e.g. the TUI) opens the SAME canonical path and recalls it.
    const surfaceB = openStore(canonicalPath, registry);
    await surfaceB.init();
    const recalled = surfaceB.get(written.id);
    expect(recalled).not.toBeNull();
    expect(recalled?.summary).toBe('the deploy command is `bun run ship`');
    const found = surfaceB.search({ query: 'deploy command' });
    expect(found.map((r) => r.id)).toContain(written.id);
    surfaceB.close();
  });
});

describe('fold/migration into the canonical store (migration honesty)', () => {
  test('folds every legacy store in with no loss, id-keyed, idempotent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-e6-fold-'));
    tmpRoots.push(root);
    const registry = embeddingRegistry(root);

    // Legacy agent-global store.
    const agentPath = join(root, 'agent', 'memory.sqlite');
    const agent = openStore(agentPath, registry);
    await agent.init();
    const a1 = await agent.add({ scope: 'project', cls: 'fact', summary: 'agent fact one' });
    const a2 = await agent.add({ scope: 'team', cls: 'constraint', summary: 'agent constraint two' });
    await agent.save();
    agent.close();

    // Legacy TUI per-project store.
    const tuiPath = join(root, 'tui', 'memory.sqlite');
    const tui = openStore(tuiPath, registry);
    await tui.init();
    const t1 = await tui.add({ scope: 'project', cls: 'decision', summary: 'tui decision one' });
    await tui.save();
    tui.close();

    const canonicalPath = resolveCanonicalMemoryDbPath(root);
    const canonical = openStore(canonicalPath, registry);
    await canonical.init();

    const report = await foldMemoryStores(
      canonical,
      [
        { label: 'agent-global', dbPath: agentPath },
        { label: 'tui:/repo', dbPath: tuiPath },
        { label: 'missing-surface', dbPath: join(root, 'nope', 'memory.sqlite') },
      ],
      { embeddingRegistry: registry },
    );

    // No loss: every legacy record is now in the canonical store.
    expect(report.totalImported).toBe(3);
    expect(report.totalSkipped).toBe(0);
    expect(report.missingSources).toEqual(['missing-surface']);
    expect(report.failedSources).toEqual([]);
    for (const id of [a1.id, a2.id, t1.id]) {
      expect(canonical.get(id)).not.toBeNull();
    }
    // Missing source is reported honestly, not as an error.
    const missing = report.sources.find((s) => s.label === 'missing-surface');
    expect(missing?.existed).toBe(false);

    // Idempotent: a second fold imports nothing new (all ids already present, none dropped).
    const report2 = await foldMemoryStores(
      canonical,
      [
        { label: 'agent-global', dbPath: agentPath },
        { label: 'tui:/repo', dbPath: tuiPath },
      ],
      { embeddingRegistry: registry },
    );
    expect(report2.totalImported).toBe(0);
    expect(report2.totalSkipped).toBe(3);
    expect(canonical.search({}).length).toBe(3);

    // Legacy stores are never deleted by migration.
    expect(existsSync(agentPath)).toBe(true);
    expect(existsSync(tuiPath)).toBe(true);
    canonical.close();
  });

  test('a corrupt/unreadable source is skipped per-source, not fatal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-e6-fold-bad-'));
    tmpRoots.push(root);
    const registry = embeddingRegistry(root);

    const goodPath = join(root, 'good', 'memory.sqlite');
    const good = openStore(goodPath, registry);
    await good.init();
    await good.add({ scope: 'project', cls: 'fact', summary: 'good fact' });
    await good.save();
    good.close();

    // A path that exists but is not a valid sqlite db.
    const badPath = join(root, 'bad', 'memory.sqlite');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(root, 'bad'), { recursive: true });
    writeFileSync(badPath, 'not a database', 'utf-8');

    const canonicalPath = resolveCanonicalMemoryDbPath(root);
    const canonical = openStore(canonicalPath, registry);
    await canonical.init();
    const report = await foldMemoryStores(
      canonical,
      [
        { label: 'bad-source', dbPath: badPath },
        { label: 'good-source', dbPath: goodPath },
      ],
      { embeddingRegistry: registry },
    );
    // Good source still folded; bad source reported, run did not abort.
    expect(report.totalImported).toBe(1);
    expect(report.failedSources).toEqual(['bad-source']);
    const bad = report.sources.find((s) => s.label === 'bad-source');
    expect(bad?.error).toBeTruthy();
    canonical.close();
  });
});
