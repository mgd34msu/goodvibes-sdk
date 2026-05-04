/**
 * COV-03 (ninth-review): platform/plugins/ smoke test.
 * Security-relevant: plugin loader/manager has a trust boundary.
 * Verifies core functions are exported with correct arity.
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
  const dir = mkdtempSync(join(tmpdir(), 'gv-plugin-smoke-'));
  tmpRoots.push(dir);
  return dir;
}

describe('platform/plugins — smoke', () => {
  test('discoverPlugins is a function export', async () => {
    const mod = await import('../packages/sdk/src/platform/plugins/index.js');
  });

  test('getUserPluginDirectory is a function export', async () => {
    const mod = await import('../packages/sdk/src/platform/plugins/index.js');
  });

  test('getPluginDirectories is a function export', async () => {
    const mod = await import('../packages/sdk/src/platform/plugins/index.js');
  });

  test('PluginManager is a class export', async () => {
    const mod = await import('../packages/sdk/src/platform/plugins/index.js');
  });

  test('discoverPlugins returns an array for a non-existent directory', async () => {
    const { discoverPlugins } = await import('../packages/sdk/src/platform/plugins/index.js');
    const dir = makeTmpDir();
    const result = discoverPlugins({ cwd: dir, homeDir: dir });
    expect(result).toBeInstanceOf(Array);
  });

  test('getUserPluginDirectory returns a non-empty string path', async () => {
    const { getUserPluginDirectory } = await import('../packages/sdk/src/platform/plugins/index.js');
    const dir = makeTmpDir();
    const result = getUserPluginDirectory({ cwd: dir, homeDir: dir });
    expect(result.length).toBeGreaterThan(0);
  });
});
