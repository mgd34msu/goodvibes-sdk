import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'version-consistency-check.ts');

describe('version-consistency-check', () => {
  test('exits 0 when all workspace packages match root version', () => {
    const r = spawnSync('bun', [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('version-consistency-check PASSED');
  });

  test('exits 1 with divergence report when a package version diverges', () => {
    // Build a minimal fixture workspace with two packages: one matching, one diverged.
    const fixture = mkdtempSync(join(tmpdir(), 'version-check-'));

    // Root package.json
    writeFileSync(
      join(fixture, 'package.json'),
      JSON.stringify({ name: 'root', version: '1.0.0' }),
    );

    // packages/a — version matches root
    mkdirSync(join(fixture, 'packages', 'a'), { recursive: true });
    writeFileSync(
      join(fixture, 'packages', 'a', 'package.json'),
      JSON.stringify({ name: '@scope/a', version: '1.0.0' }),
    );

    // packages/b — version diverges from root
    mkdirSync(join(fixture, 'packages', 'b'), { recursive: true });
    writeFileSync(
      join(fixture, 'packages', 'b', 'package.json'),
      JSON.stringify({ name: '@scope/b', version: '0.9.0' }),
    );

    const packagesJson = JSON.stringify(['packages/a', 'packages/b']);

    const r = spawnSync('bun', [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        WORKSPACE_ROOT: fixture,
        WORKSPACE_PACKAGES_JSON: packagesJson,
      },
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('@scope/b');
  });
});
