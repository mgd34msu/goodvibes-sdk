/**
 * Wave-5 Stage B — code-index-reindex.ts (tool-site incremental reindex) unit suite.
 *
 * Covers path extraction from write/edit tool args, the debounce+coalesce shape, the
 * no-op gates (setting off / index never built / failed tool), and contained failure
 * handling — all without a live sqlite store, via a fake CodeIndexReindexTarget.
 */
import { describe, expect, test } from 'bun:test';
import {
  CodeIndexReindexScheduler,
  extractReindexPaths,
  type CodeIndexReindexTarget,
} from '../packages/sdk/src/platform/state/code-index-reindex.js';
import type { CodeChunkMode } from '../packages/sdk/src/platform/state/index.js';

function makeTarget(over: {
  reindex?: (abs: string) => Promise<{ indexed: boolean; mode: CodeChunkMode }>;
  available?: boolean;
  indexedChunks?: number;
} = {}) {
  const calls: string[] = [];
  const target: CodeIndexReindexTarget = {
    reindexFile: async (abs) => {
      calls.push(abs);
      return over.reindex ? over.reindex(abs) : { indexed: true, mode: 'symbols' as CodeChunkMode };
    },
    stats: () => ({ available: over.available ?? true, indexedChunks: over.indexedChunks ?? 5 }),
  };
  return { target, calls };
}

const ROOT = '/repo';

describe('extractReindexPaths', () => {
  test('write: pulls every files[].path', () => {
    expect(extractReindexPaths('write', { files: [{ path: 'a.ts', content: 'x' }, { path: 'b.ts', content: 'y' }] }))
      .toEqual(['a.ts', 'b.ts']);
  });
  test('edit: pulls edits[].path and notebook_operations.path', () => {
    const paths = extractReindexPaths('edit', {
      edits: [{ path: 'a.ts', find: 'x', replace: 'y' }, { path: 'a.ts', find: 'z', replace: 'w' }],
      notebook_operations: { path: 'nb.ipynb', operations: [] },
    });
    expect(paths).toContain('a.ts');
    expect(paths).toContain('nb.ipynb');
    expect(paths.filter((p) => p === 'a.ts')).toHaveLength(1); // de-duplicated
  });
  test('top-level path / file_path honored', () => {
    expect(extractReindexPaths('write', { path: 'x.ts' })).toEqual(['x.ts']);
    expect(extractReindexPaths('edit', { file_path: 'y.ts' })).toEqual(['y.ts']);
  });
  test('non-file tools and empty args yield nothing', () => {
    expect(extractReindexPaths('exec', { command: 'ls' })).toEqual([]);
    expect(extractReindexPaths('read', { path: 'a.ts' })).toEqual([]);
    expect(extractReindexPaths('write', {})).toEqual([]);
  });
});

describe('scheduler — edit→reindex fires, debounced and coalesced', () => {
  test('a successful write schedules a reindex of the resolved absolute path', async () => {
    const { target, calls } = makeTarget();
    const s = new CodeIndexReindexScheduler({ target, workingDirectory: ROOT, debounceMs: 1 });
    s.onToolExecuted('write', { files: [{ path: 'src/a.ts', content: 'x' }] }, true);
    expect(s.pendingCount()).toBe(1);
    await s.flush();
    expect(calls).toEqual(['/repo/src/a.ts']);
    expect(s.lastActivity()).toMatchObject({ path: '/repo/src/a.ts', status: 'indexed', mode: 'symbols' });
  });

  test('repeated edits to the SAME path within the window coalesce into one reindex', async () => {
    const { target, calls } = makeTarget();
    const s = new CodeIndexReindexScheduler({ target, workingDirectory: ROOT, debounceMs: 50 });
    s.onToolExecuted('edit', { edits: [{ path: 'src/a.ts', find: 'x', replace: '1' }] }, true);
    s.onToolExecuted('edit', { edits: [{ path: 'src/a.ts', find: 'y', replace: '2' }] }, true);
    s.onToolExecuted('edit', { edits: [{ path: 'src/a.ts', find: 'z', replace: '3' }] }, true);
    expect(s.pendingCount()).toBe(1); // three touches, one pending timer
    await s.flush();
    expect(calls).toEqual(['/repo/src/a.ts']); // exactly one reindex
  });

  test('distinct paths each reindex independently', async () => {
    const { target, calls } = makeTarget();
    const s = new CodeIndexReindexScheduler({ target, workingDirectory: ROOT, debounceMs: 1 });
    s.onToolExecuted('write', { files: [{ path: 'src/a.ts', content: 'x' }, { path: 'src/b.ts', content: 'y' }] }, true);
    expect(s.pendingCount()).toBe(2);
    await s.flush();
    expect(calls.sort()).toEqual(['/repo/src/a.ts', '/repo/src/b.ts']);
  });
});

describe('scheduler — no-op gates', () => {
  test('failed tool call schedules nothing', async () => {
    const { target, calls } = makeTarget();
    const s = new CodeIndexReindexScheduler({ target, workingDirectory: ROOT, debounceMs: 1 });
    s.onToolExecuted('write', { files: [{ path: 'a.ts', content: 'x' }] }, false);
    expect(s.pendingCount()).toBe(0);
    await s.flush();
    expect(calls).toEqual([]);
  });

  test('setting disabled (isEnabled false) => timer arms but reindex no-ops at fire time', async () => {
    const { target, calls } = makeTarget();
    const s = new CodeIndexReindexScheduler({ target, workingDirectory: ROOT, debounceMs: 1, isEnabled: () => false });
    s.onToolExecuted('write', { files: [{ path: 'a.ts', content: 'x' }] }, true);
    await s.flush();
    expect(calls).toEqual([]);
    expect(s.lastActivity()).toBeNull();
  });

  test('index never built (indexedChunks 0) => reindex no-ops', async () => {
    const { target, calls } = makeTarget({ indexedChunks: 0 });
    const s = new CodeIndexReindexScheduler({ target, workingDirectory: ROOT, debounceMs: 1 });
    s.onToolExecuted('write', { files: [{ path: 'a.ts', content: 'x' }] }, true);
    await s.flush();
    expect(calls).toEqual([]);
    expect(s.lastActivity()).toBeNull();
  });

  test('unavailable store => reindex no-ops', async () => {
    const { target, calls } = makeTarget({ available: false });
    const s = new CodeIndexReindexScheduler({ target, workingDirectory: ROOT, debounceMs: 1 });
    s.onToolExecuted('write', { files: [{ path: 'a.ts', content: 'x' }] }, true);
    await s.flush();
    expect(calls).toEqual([]);
  });
});

describe('scheduler — contained failure & honest activity', () => {
  test('reindexFile throwing is caught, recorded as error, never rethrown', async () => {
    const { target } = makeTarget({ reindex: async () => { throw new Error('disk gone'); } });
    const s = new CodeIndexReindexScheduler({ target, workingDirectory: ROOT, debounceMs: 1 });
    s.onToolExecuted('write', { files: [{ path: 'a.ts', content: 'x' }] }, true);
    await s.flush(); // must not reject
    const activity = s.lastActivity();
    expect(activity?.status).toBe('error');
    expect(activity?.error).toContain('disk gone');
  });

  test('a reindex that returns indexed:false is recorded as skipped', async () => {
    const { target } = makeTarget({ reindex: async () => ({ indexed: false, mode: 'empty' as CodeChunkMode }) });
    const s = new CodeIndexReindexScheduler({ target, workingDirectory: ROOT, debounceMs: 1 });
    s.onToolExecuted('write', { files: [{ path: 'gitignored.ts', content: 'x' }] }, true);
    await s.flush();
    expect(s.lastActivity()).toMatchObject({ status: 'skipped', mode: 'empty' });
  });

  test('absolute tool-arg paths pass through resolve unchanged', async () => {
    const { target, calls } = makeTarget();
    const s = new CodeIndexReindexScheduler({ target, workingDirectory: ROOT, debounceMs: 1 });
    s.onToolExecuted('write', { files: [{ path: '/elsewhere/z.ts', content: 'x' }] }, true);
    await s.flush();
    expect(calls).toEqual(['/elsewhere/z.ts']);
  });
});
