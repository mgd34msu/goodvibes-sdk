import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  MemoryEmbeddingProviderRegistry,
  MemoryRegistry,
  MemoryStore,
  applyMemoryProjectionProposals,
  diffProjectionToProposals,
  parseProjectedMemoryFile,
  projectMemoryRecordToMarkdown,
  projectMemoryToFiles,
  readProjectedMemoryFiles,
  type MemoryRecord,
} from '../packages/sdk/src/platform/state/index.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';

/**
 * Standing memory as git-backed markdown files that round-trip through the
 * confirmation-gated mutation path: a file edit/deletion becomes a proposal, and
 * the store is mutated ONLY for confirmed proposals — never a silent write.
 */

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-mfp-'));
  roots.push(root);
  return root;
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = 1_000;
  return { id: 'mem_a', scope: 'project', cls: 'decision', summary: 'use bun', detail: 'bun is the runtime', tags: ['tooling'], provenance: [], reviewState: 'reviewed', confidence: 80, createdAt: now, updatedAt: now, ...overrides };
}

describe('markdown round-trip', () => {
  test('render then parse recovers the fields', () => {
    const r = record({ validUntil: 2_000_000_000_000 });
    const md = projectMemoryRecordToMarkdown(r, 1000);
    expect(md).toContain('status: active'); // validUntil is far in the future
    const parsed = parseProjectedMemoryFile('/x/mem_a.md', md);
    expect(parsed?.id).toBe('mem_a');
    expect(parsed?.summary).toBe('use bun');
    expect(parsed?.detail).toBe('bun is the runtime');
    expect(parsed?.tags).toEqual(['tooling']);
    expect(parsed?.validUntil).toBe(2_000_000_000_000);
  });

  test('an expired record is labelled status: expired', () => {
    const md = projectMemoryRecordToMarkdown(record({ validUntil: 500 }), 1000);
    expect(md).toContain('status: expired');
  });
});

describe('projectMemoryToFiles / readProjectedMemoryFiles', () => {
  test('writes one file per standing record and reads them back; session scope excluded', () => {
    const dir = join(tempDir(), 'memory');
    const records = [
      record({ id: 'mem_p', scope: 'project', summary: 'project fact' }),
      record({ id: 'mem_t', scope: 'team', summary: 'team fact' }),
      record({ id: 'mem_s', scope: 'session', summary: 'session fact' }),
    ];
    const report = projectMemoryToFiles(records, dir, { now: 1000 });
    expect(report.written.length).toBe(2); // session excluded
    const files = readProjectedMemoryFiles(dir);
    expect(files.map((f) => f.id).sort()).toEqual(['mem_p', 'mem_t']);
  });

  test('git seam is invoked when supplied; a dir with no repository gets its own initialized first', () => {
    const dir = join(tempDir(), 'memory');
    const calls: string[] = [];
    projectMemoryToFiles([record()], dir, {
      now: 1000,
      git: {
        resolveToplevel: () => null,
        init: () => calls.push('init'),
        add: () => calls.push('add'),
        commit: () => calls.push('commit'),
      },
    });
    expect(calls).toEqual(['init', 'add', 'commit']);
  });

  test('a projection dir that is already its own repository root commits without re-initializing', () => {
    const dir = join(tempDir(), 'memory');
    const calls: string[] = [];
    projectMemoryToFiles([record()], dir, {
      now: 1000,
      git: {
        resolveToplevel: (queried) => queried,
        init: () => calls.push('init'),
        add: () => calls.push('add'),
        commit: () => calls.push('commit'),
      },
    });
    expect(calls).toEqual(['add', 'commit']);
  });

  test('a projection dir nested inside some other repository never commits into it', () => {
    const dir = join(tempDir(), 'memory');
    const calls: string[] = [];
    projectMemoryToFiles([record()], dir, {
      now: 1000,
      git: {
        // git resolves upward to an enclosing checkout that is NOT ours.
        resolveToplevel: () => '/home/user/some-foreign-checkout',
        init: (initDir) => calls.push(`init:${initDir}`),
        add: (addDir) => calls.push(`add:${addDir}`),
        commit: (commitDir) => calls.push(`commit:${commitDir}`),
      },
    });
    // The seam is redirected to a repository initialized AT the projection dir.
    expect(calls).toEqual([`init:${dir}`, `add:${dir}`, `commit:${dir}`]);
  });
});

describe('diff + gated apply (round-trip)', () => {
  test('editing a file yields an update proposal; nothing changes until confirmed', () => {
    const records = [record()];
    const files = [{ id: 'mem_a', path: '/x/mem_a.md', scope: 'project' as const, cls: 'decision' as const, summary: 'use bun everywhere', detail: 'bun is the runtime', tags: ['tooling'] }];
    const proposals = diffProjectionToProposals(records, files);
    expect(proposals.length).toBe(1);
    expect(proposals[0]!.kind).toBe('update');
    expect(proposals[0]!.changedFields).toContain('summary');
  });

  test('a removed file yields a delete proposal', () => {
    const proposals = diffProjectionToProposals([record()], []);
    expect(proposals.length).toBe(1);
    expect(proposals[0]!.kind).toBe('delete');
  });

  test('unchanged file yields no proposal', () => {
    const files = [{ id: 'mem_a', path: '/x/mem_a.md', scope: 'project' as const, cls: 'decision' as const, summary: 'use bun', detail: 'bun is the runtime', tags: ['tooling'] }];
    expect(diffProjectionToProposals([record()], files)).toEqual([]);
  });

  test('apply is a gate: unconfirmed proposals are skipped, never written', async () => {
    const root = tempDir();
    const configManager = new ConfigManager({ configDir: join(root, 'config') });
    const store = new MemoryStore(join(root, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
      enableVectorIndex: false,
    });
    await store.init();
    const registry = new MemoryRegistry(store);
    const added = await registry.add({ cls: 'decision', summary: 'original', detail: 'd', tags: ['t'], scope: 'project' });

    const dir = join(root, 'memory');
    projectMemoryToFiles(registry.getAll(), dir);
    // User edits the file on disk.
    const filePath = join(dir, `${added.id}.md`);
    writeFileSync(filePath, readFileSync(filePath, 'utf-8').replace('# original', '# corrected'), 'utf-8');

    const proposals = diffProjectionToProposals(registry.getAll(), readProjectedMemoryFiles(dir));
    expect(proposals.length).toBe(1);

    // Deny the proposal: the store must NOT change.
    const denied = applyMemoryProjectionProposals(registry, proposals, { confirm: () => false });
    expect(denied.skipped.length).toBe(1);
    expect(denied.applied.length).toBe(0);
    expect(registry.get(added.id)?.summary).toBe('original');

    // Confirm the proposal: now the store update runs through the registry.
    const confirmed = applyMemoryProjectionProposals(registry, proposals, { confirm: () => true });
    expect(confirmed.applied.length).toBe(1);
    expect(registry.get(added.id)?.summary).toBe('corrected');
  });
});
