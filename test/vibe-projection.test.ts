import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  MemoryEmbeddingProviderRegistry,
  MemoryStore,
  renderVibeProjection,
  selectVibeRecords,
  vibeBodyToConstraintOptions,
  VIBE_PROJECTION_HEADING,
  VIBE_PROJECTION_CAVEAT,
} from '../packages/sdk/src/platform/state/index.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';

/**
 * VIBE.md as a projection of persona/constraint records.
 *
 * Asserts: the '## VIBE.md' block renders from constraint records (not a file),
 * the precedence caveat is preserved, a persona edit via a record changes the
 * projected block, and persona records round-trip through the normal MemoryStore
 * bundle seam (the file demoted to an import/export format).
 */

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function openStore(root: string): MemoryStore {
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  return new MemoryStore(join(root, 'memory.sqlite'), {
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    enableVectorIndex: false,
  });
}

const SAMPLE_VIBE = [
  '# VIBE.md',
  '',
  'Describe how GoodVibes Agent should feel and work with you.',
  '',
  '- Be direct about tradeoffs.',
  '- Prefer visible, reversible actions.',
].join('\n');

describe('VIBE body imported as constraint records (file demoted to format)', () => {
  test('each bullet becomes one persona constraint record', () => {
    const options = vibeBodyToConstraintOptions(SAMPLE_VIBE, { scope: 'project', sourceRef: '/repo/VIBE.md' });
    expect(options.length).toBe(2);
    expect(options.every((o) => o.cls === 'constraint')).toBe(true);
    expect(options.every((o) => o.scope === 'project')).toBe(true);
    expect(options.every((o) => o.tags?.includes('vibe'))).toBe(true);
    expect(options.map((o) => o.summary)).toEqual([
      'Be direct about tradeoffs.',
      'Prefer visible, reversible actions.',
    ]);
    expect(options[0]!.provenance?.[0]).toEqual({ kind: 'file', ref: '/repo/VIBE.md' });
  });

  test('a prose-only body (no bullets) becomes a single record', () => {
    const options = vibeBodyToConstraintOptions('Keep things calm and clear.', { name: 'Calm' });
    expect(options.length).toBe(1);
    expect(options[0]!.detail).toBe('Keep things calm and clear.');
    expect(options[0]!.tags).toContain('Calm');
  });
});

describe('renderVibeProjection (records -> prompt block)', () => {
  test('projects the VIBE block from constraint records with the caveat preserved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-vibe-proj-'));
    tmpRoots.push(root);
    const store = openStore(root);
    await store.init();
    for (const opts of vibeBodyToConstraintOptions(SAMPLE_VIBE, { scope: 'project' })) {
      await store.add(opts);
    }
    // A non-persona constraint must NOT leak into the projection.
    await store.add({ scope: 'project', cls: 'constraint', summary: 'unrelated constraint', tags: ['policy'] });

    const block = renderVibeProjection(store.search({}));
    expect(block).not.toBeNull();
    expect(block).toContain(VIBE_PROJECTION_HEADING);
    expect(block).toContain(VIBE_PROJECTION_CAVEAT);
    expect(block).toContain('- Be direct about tradeoffs.');
    expect(block).toContain('- Prefer visible, reversible actions.');
    expect(block).not.toContain('unrelated constraint');
    store.close();
  });

  test('no persona records → no block (null, not an empty header)', () => {
    expect(renderVibeProjection([])).toBeNull();
  });

  test('editing one persona record changes exactly that line of the block', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-vibe-edit-'));
    tmpRoots.push(root);
    const store = openStore(root);
    await store.init();
    const created = [];
    for (const opts of vibeBodyToConstraintOptions(SAMPLE_VIBE, { scope: 'project' })) {
      created.push(await store.add(opts));
    }
    store.update(created[0]!.id, { summary: 'Be extremely direct about tradeoffs.' });
    const block = renderVibeProjection(store.search({}));
    expect(block).toContain('- Be extremely direct about tradeoffs.');
    expect(block).not.toContain('- Be direct about tradeoffs.');
    expect(block).toContain('- Prefer visible, reversible actions.');
    store.close();
  });
});

describe('persona records round-trip through the bundle seam', () => {
  test('export from one store, import into another, projection is identical', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'gv-vibe-rt-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'gv-vibe-rt-b-'));
    tmpRoots.push(rootA, rootB);

    const storeA = openStore(rootA);
    await storeA.init();
    for (const opts of vibeBodyToConstraintOptions(SAMPLE_VIBE, { scope: 'project' })) {
      await storeA.add(opts);
    }
    const projectionA = renderVibeProjection(storeA.search({}));
    const bundle = storeA.exportBundle({});
    storeA.close();

    const storeB = openStore(rootB);
    await storeB.init();
    await storeB.importBundle(bundle);
    const projectionB = renderVibeProjection(storeB.search({}));
    expect(projectionB).toBe(projectionA);
    expect(selectVibeRecords(storeB.search({})).length).toBe(2);
    storeB.close();
  });
});
