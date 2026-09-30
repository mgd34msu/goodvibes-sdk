/**
 * subpath-declared.test.ts, a capability nobody can import does not ship.
 *
 * The gap: `check-subpath-api-surface` enumerates its entry points FROM the
 * exports map, so it is a drift detector over what is already declared. A
 * top-level capability with no exports entry has no entry point to enumerate,
 * it is absent from the snapshot, absent from the diff, and absent from every
 * green run, while `import '@pellux/goodvibes-sdk/platform/<thing>'` fails
 * resolution for every consumer of the published package.
 *
 * That gap survives local development because consumers build against overlay
 * tarballs and workspace links, which resolve through paths a published install
 * does not have. Source-tree resolution proves nothing about the artifact that
 * actually ships.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PACKAGE_DIR = join(REPO_ROOT, 'packages', 'sdk');

function exportsMap(): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  return manifest.exports ?? {};
}

describe('every shipped capability is importable from the published package', () => {
  test('the check passes: no NEW undeclared top-level capability', () => {
    const result = spawnSync('bun', [join(REPO_ROOT, 'scripts', 'check-subpath-declared.ts')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      console.error(`[subpath-declared]\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    }
    expect(result.status).toBe(0);
  });

  test('this capability is declared, and points at a real dist entry', () => {
    const entry = exportsMap()['./platform/payments'] as { types?: string; import?: string } | undefined;
    expect(entry).toBeDefined();
    // Not just present, pointing somewhere that exists. A subpath declared
    // against a path the build does not produce fails at install time rather
    // than here, which is the worst place to find out.
    expect(entry?.import).toBe('./dist/platform/payments/index.js');
    expect(entry?.types).toBe('./dist/platform/payments/index.d.ts');
  });

  test('every declared platform subpath names a dist path, not a src path', () => {
    // A subpath pointing into src/ works in the repo and breaks on install,
    // because src is not in the published `files` list.
    const offenders: string[] = [];
    for (const [subpath, value] of Object.entries(exportsMap())) {
      if (!subpath.startsWith('./platform/')) continue;
      if (typeof value !== 'object' || value === null) continue;
      const entry = value as Record<string, unknown>;
      for (const field of ['types', 'import'] as const) {
        const target = entry[field];
        if (typeof target === 'string' && !target.startsWith('./dist/')) {
          offenders.push(`${subpath}.${field} -> ${target}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
