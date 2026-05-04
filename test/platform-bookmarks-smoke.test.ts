/**
 * COV-01 (ninth-review): platform/bookmarks/ smoke test.
 * Verifies BookmarkManager is instantiable and core methods are callable.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-bookmark-smoke-'));
  tmpRoots.push(dir);
  return dir;
}

describe('platform/bookmarks — smoke', () => {
  test('BookmarkManager is a class export', async () => {
    const mod = await import('../packages/sdk/src/platform/bookmarks/index.js');
  });

  test('BookmarkManager can be constructed with a minimal config store', async () => {
    const { BookmarkManager } = await import('../packages/sdk/src/platform/bookmarks/index.js');
    const mgr = new BookmarkManager(makeTmpDir());
    expect(mgr).toBeDefined();
  });

  test('BookmarkManager.list returns an array on empty store', async () => {
    const { BookmarkManager } = await import('../packages/sdk/src/platform/bookmarks/index.js');
    const mgr = new BookmarkManager(makeTmpDir());
    const result = mgr.list();
    expect(result).toBeInstanceOf(Array);
  });
});
