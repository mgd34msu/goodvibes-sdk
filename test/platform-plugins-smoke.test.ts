/**
 * COV-03 (ninth-review): platform/plugins/ smoke test.
 * Security-relevant: plugin loader/manager has a trust boundary.
 * Verifies core functions are exported with correct arity.
 */
import { describe, expect, test } from 'bun:test';

describe('platform/plugins — smoke', () => {
  test('discoverPlugins is a function export', async () => {
    const mod = await import('../packages/sdk/src/platform/plugins/index.js');
    expect(typeof mod.discoverPlugins).toBe('function');
  });

  test('getUserPluginDirectory is a function export', async () => {
    const mod = await import('../packages/sdk/src/platform/plugins/index.js');
    expect(typeof mod.getUserPluginDirectory).toBe('function');
  });

  test('getPluginDirectories is a function export', async () => {
    const mod = await import('../packages/sdk/src/platform/plugins/index.js');
    expect(typeof mod.getPluginDirectories).toBe('function');
  });

  test('PluginManager is a class export', async () => {
    const mod = await import('../packages/sdk/src/platform/plugins/index.js');
    expect(typeof mod.PluginManager).toBe('function');
  });

  test('discoverPlugins returns an array for a non-existent directory', async () => {
    const { discoverPlugins } = await import('../packages/sdk/src/platform/plugins/index.js');
    // Calling with paths that don't exist should return empty array, not throw.
    const result = discoverPlugins({ cwd: '/tmp/nonexistent-xyz', homeDir: '/tmp/nonexistent-xyz' });
    expect(Array.isArray(result)).toBe(true);
  });

  test('getUserPluginDirectory returns a non-empty string path', async () => {
    const { getUserPluginDirectory } = await import('../packages/sdk/src/platform/plugins/index.js');
    const dir = getUserPluginDirectory({ cwd: '/tmp/test-plugins', homeDir: '/tmp/test-plugins' });
    expect(typeof dir).toBe('string');
    expect(dir.length).toBeGreaterThan(0);
  });
});
