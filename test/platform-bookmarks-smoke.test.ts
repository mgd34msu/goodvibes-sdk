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
    // BookmarkManager requires a configManager-like store; use a minimal stub.
    const store = {
      get: (_k: string) => undefined,
      set: (_k: string, _v: unknown) => {},
      delete: (_k: string) => {},
    };
    const mgr = new BookmarkManager(store as Parameters<typeof BookmarkManager>[0]);
    expect(mgr).toBeDefined();
    expect(typeof mgr.list).toBe('function');
    expect(typeof mgr.add).toBe('function');
  });

  test('BookmarkManager.list returns an array on empty store', async () => {
    const { BookmarkManager } = await import('../packages/sdk/src/platform/bookmarks/index.js');
    const store = {
      get: (_k: string) => undefined,
      set: (_k: string, _v: unknown) => {},
      delete: (_k: string) => {},
    };
    const mgr = new BookmarkManager(store as Parameters<typeof BookmarkManager>[0]);
    const result = mgr.list();
    expect(Array.isArray(result)).toBe(true);
  });
});
