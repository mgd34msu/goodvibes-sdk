import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { MemoryUsageStatsStore } from '../packages/sdk/src/platform/state/index.js';

/**
 * Per-memory usage counters (hoisted from the agent surface). Answers "was
 * injected context actually used?" — durable JSON sidecar, feeds decay ordering
 * via lookup(). Semantics must match the agent original.
 */
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function newFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-usage-'));
  roots.push(root);
  return join(root, 'usage.json');
}

describe('MemoryUsageStatsStore', () => {
  test('counts injections and references per id', () => {
    const store = new MemoryUsageStatsStore(newFile());
    store.recordInjected(['a'], 1);
    store.recordInjected(['a'], 2);
    store.recordReferenced(['a'], 3);
    store.recordInjected(['b'], 4);
    expect(store.get('a')).toMatchObject({ injectedCount: 2, referencedCount: 1 });
    expect(store.get('b')).toMatchObject({ injectedCount: 1, referencedCount: 0 });
    expect(store.get('missing')).toBeNull();
  });

  test('lookup returns the consolidation signal or undefined', () => {
    const store = new MemoryUsageStatsStore(newFile());
    store.recordInjected(['x'], 10);
    expect(store.lookup('x')).toMatchObject({ injectedCount: 1, referencedCount: 0, lastReferencedAt: null });
    expect(store.lookup('never')).toBeUndefined();
  });

  test('persists across store instances at the same path', () => {
    const file = newFile();
    const a = new MemoryUsageStatsStore(file);
    a.recordInjected(['p'], 1);
    a.recordReferenced(['p'], 2);
    const b = new MemoryUsageStatsStore(file);
    expect(b.get('p')).toMatchObject({ injectedCount: 1, referencedCount: 1 });
  });

  test('summary aggregates injected/referenced/never-referenced with honest note', () => {
    const store = new MemoryUsageStatsStore(newFile());
    store.recordInjected(['a', 'b', 'c'], 1);
    store.recordReferenced(['a'], 2);
    const summary = store.summary();
    expect(summary.everInjected).toBe(3);
    expect(summary.everReferenced).toBe(1);
    expect(summary.neverReferenced).toBe(2);
    expect(summary.mostReferenced[0]!.id).toBe('a');
    expect(summary.signalNote.toLowerCase()).toContain('heuristic');
  });
});
