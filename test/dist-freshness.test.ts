import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '..');

const BUILT_PACKAGE_ENTRIES = [
  'contracts',
  'daemon-sdk',
  'errors',
  'operator-sdk',
  'peer-sdk',
  'sdk',
  'transport-core',
  'transport-http',
  'transport-realtime',
] as const;

/**
 * shell out to the authoritative recursive
 * walker in scripts/check-dist-freshness.ts so both checks share the same
 * logic and deep-tree staleness (files other than index.ts) is caught.
 *
 * The previous implementation only compared src/index.ts vs dist/index.js
 * mtimes, which means editing a deep file without touching index.ts left the
 * test green while dist was actually stale.
 */
describe('compiled dist fixtures (recursive freshness check)', () => {
  test('check-dist-freshness script exits 0 — all dist/ outputs are up-to-date', () => {
    const script = join(ROOT, 'scripts', 'check-dist-freshness.ts');
    expect(existsSync(script)).toBe(true);

    const result = spawnSync('bun', ['run', script], {
      cwd: ROOT,
      timeout: 30_000,
      env: { ...process.env, NO_COLOR: '1' },
    });

    const stdout = result.stdout?.toString() ?? '';
    const stderr = result.stderr?.toString() ?? '';

    if (result.status !== 0) {
      // Print diagnostic so the failure is immediately actionable
      console.error('[dist-freshness] check-dist-freshness script output:\n' + stdout + stderr);
    }

    expect(result.status).toBe(0);
  });
});

/**
 * Lightweight entry-point existence guard — runs in parallel with the recursive
 * check. This catches the case where dist/ is entirely absent (build never ran).
 */
describe('compiled dist fixtures (entry-point existence)', () => {
  for (const packageName of BUILT_PACKAGE_ENTRIES) {
    test(`${packageName} dist/index.js exists`, () => {
      const distEntry = join(ROOT, 'packages', packageName, 'dist', 'index.js');
      expect(existsSync(distEntry)).toBe(true);
    });

    test(`${packageName} dist/index.js is not older than src/index.ts`, () => {
      const sourceEntry = join(ROOT, 'packages', packageName, 'src', 'index.ts');
      const distEntry = join(ROOT, 'packages', packageName, 'dist', 'index.js');
      if (!existsSync(distEntry)) return; // caught by existence test above
      // Note: this is the lightweight single-file check; deep-tree staleness
      // is caught by the recursive check-dist-freshness.ts test above.
      expect(statSync(distEntry).mtimeMs).toBeGreaterThanOrEqual(statSync(sourceEntry).mtimeMs);
    });
  }
});
