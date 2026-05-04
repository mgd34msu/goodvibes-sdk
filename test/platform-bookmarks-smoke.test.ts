/**
 * COV-01 (ninth-review): platform/bookmarks/ smoke test.
 * Verifies BookmarkManager is instantiable and core methods are callable.
 */
import { describe, expect, test } from 'bun:test';

describe('platform/bookmarks — smoke', () => {
  test('BookmarkManager is a class export', async () => {
    const mod = await import('../packages/sdk/src/platform/bookmarks/index.js');
    expect(typeof mod.BookmarkManager).toBe('function');
  });

  test('BookmarkManager can be constructed with a minimal config store', async () => {
    const { BookmarkManager } = await import('../packages/sdk/src/platform/bookmarks/index.js');
    // BookmarkManager takes a baseDir string.
    const mgr = new BookmarkManager('/tmp/gv-bookmark-smoke-test');
    expect(mgr).toBeDefined();
    expect(typeof mgr.list).toBe('function');
    expect(typeof mgr.toggle).toBe('function');
  });

  test('BookmarkManager.list returns an array on empty store', async () => {
    const { BookmarkManager } = await import('../packages/sdk/src/platform/bookmarks/index.js');
    const mgr = new BookmarkManager('/tmp/gv-bookmark-smoke-test');
    const result = mgr.list();
    expect(Array.isArray(result)).toBe(true);
  });
});
