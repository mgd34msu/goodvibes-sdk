import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const PKG_DIR = resolve(import.meta.dir, '../../packages/toolchain');
const DISPATCHER_DIST = resolve(PKG_DIR, 'dist/bin/toolchain.js');

function binMap(): Record<string, string> {
  return (JSON.parse(readFileSync(resolve(PKG_DIR, 'package.json'), 'utf8')) as { bin: Record<string, string> }).bin;
}

describe('goodvibes-toolchain dispatcher', () => {
  test('a bin named after the package exists, so bunx <package> <tool> resolves the dispatcher', () => {
    // bunx matches the bin whose name equals the package's final path segment.
    // Without this entry, bunx falls back to the FIRST bin in the map and runs
    // the wrong tool with the intended tool name as a stray argument.
    expect(binMap()['goodvibes-toolchain']).toBe('./dist/bin/toolchain.js');
    // Keep it first so any first-bin fallback ALSO lands on the dispatcher.
    expect(Object.keys(binMap())[0]).toBe('goodvibes-toolchain');
  });

  test('unknown or missing tool names exit 2 with usage, never fall through to a tool', () => {
    for (const argv of [[], ['no-such-tool']]) {
      const res = spawnSync('bun', [DISPATCHER_DIST, ...argv], { encoding: 'utf8', timeout: 30_000 });
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('Usage: goodvibes-toolchain <tool>');
    }
  });

  test('the goodvibes- prefixed form dispatches the same as the bare tool name', () => {
    // per-job-green with no --repo/--sha exits 2 with its own named error,
    // proof the dispatcher reached the real tool with a clean argv.
    for (const name of ['per-job-green', 'goodvibes-per-job-green']) {
      const res = spawnSync('bun', [DISPATCHER_DIST, name], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, GITHUB_REPOSITORY: '', GITHUB_SHA: '' },
      });
      expect(res.status).toBe(2);
      expect(res.stderr + res.stdout).toContain('per-job-green: --repo');
    }
  });
});
