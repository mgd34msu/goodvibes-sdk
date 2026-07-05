import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-line-cap.ts');

function linesOf(n: number): string {
  return Array.from({ length: n }, (_, i) => `// line ${i + 1}`).join('\n') + '\n';
}

function runCheck(env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bun', [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('check-line-cap (real repo)', () => {
  test('passes on the real SDK tree by construction (grandfather list matches current state)', () => {
    const r = spawnSync('bun', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('line-cap-check PASSED');
  });
});

describe('check-line-cap (fixtures)', () => {
  test('a new over-cap file with no grandfather entry fails the check', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'line-cap-'));
    mkdirSync(join(fixture, 'packages', 'a', 'src'), { recursive: true });
    writeFileSync(join(fixture, 'packages', 'a', 'src', 'big.ts'), linesOf(801));

    const r = runCheck({
      LINE_CAP_ROOT: fixture,
      LINE_CAP_PACKAGE_DIRS_JSON: JSON.stringify(['packages/a/src']),
      LINE_CAP_GRANDFATHER_JSON: JSON.stringify({}),
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('packages/a/src/big.ts');
    expect(r.stderr).toContain('exceeds the 800-line cap');
  });

  test('a grandfathered file sitting exactly at its ceiling passes', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'line-cap-'));
    mkdirSync(join(fixture, 'packages', 'a', 'src'), { recursive: true });
    writeFileSync(join(fixture, 'packages', 'a', 'src', 'big.ts'), linesOf(1200));

    const r = runCheck({
      LINE_CAP_ROOT: fixture,
      LINE_CAP_PACKAGE_DIRS_JSON: JSON.stringify(['packages/a/src']),
      LINE_CAP_GRANDFATHER_JSON: JSON.stringify({
        'packages/a/src/big.ts': { ceiling: 1200, justification: 'test fixture, shrink-only' },
      }),
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('line-cap-check PASSED');
  });

  test('a grandfathered file grown past its ceiling fails', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'line-cap-'));
    mkdirSync(join(fixture, 'packages', 'a', 'src'), { recursive: true });
    writeFileSync(join(fixture, 'packages', 'a', 'src', 'big.ts'), linesOf(1250));

    const r = runCheck({
      LINE_CAP_ROOT: fixture,
      LINE_CAP_PACKAGE_DIRS_JSON: JSON.stringify(['packages/a/src']),
      LINE_CAP_GRANDFATHER_JSON: JSON.stringify({
        'packages/a/src/big.ts': { ceiling: 1200, justification: 'test fixture, shrink-only' },
      }),
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('packages/a/src/big.ts');
    expect(r.stderr).toContain('grew past its grandfathered ceiling of 1200');
  });

  test('a shrunk-under-800-but-still-listed grandfather entry fails with the stale-entry message', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'line-cap-'));
    mkdirSync(join(fixture, 'packages', 'a', 'src'), { recursive: true });
    writeFileSync(join(fixture, 'packages', 'a', 'src', 'big.ts'), linesOf(700));

    const r = runCheck({
      LINE_CAP_ROOT: fixture,
      LINE_CAP_PACKAGE_DIRS_JSON: JSON.stringify(['packages/a/src']),
      LINE_CAP_GRANDFATHER_JSON: JSON.stringify({
        'packages/a/src/big.ts': { ceiling: 1200, justification: 'test fixture, shrink-only' },
      }),
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('packages/a/src/big.ts');
    expect(r.stderr).toContain('under the 800-line cap');
    expect(r.stderr).toContain('remove the entry from line-cap-grandfather.ts');
  });

  test('generated/ and vendor/ directories are excluded even when over cap', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'line-cap-'));
    mkdirSync(join(fixture, 'packages', 'a', 'src', 'generated'), { recursive: true });
    mkdirSync(join(fixture, 'packages', 'a', 'src', 'vendor'), { recursive: true });
    writeFileSync(join(fixture, 'packages', 'a', 'src', 'generated', 'huge.ts'), linesOf(5000));
    writeFileSync(join(fixture, 'packages', 'a', 'src', 'vendor', 'huge.ts'), linesOf(5000));

    const r = runCheck({
      LINE_CAP_ROOT: fixture,
      LINE_CAP_PACKAGE_DIRS_JSON: JSON.stringify(['packages/a/src']),
      LINE_CAP_GRANDFATHER_JSON: JSON.stringify({}),
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('line-cap-check PASSED for 0 source files');
  });

  test('.d.ts declaration files are excluded even when over cap', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'line-cap-'));
    mkdirSync(join(fixture, 'packages', 'a', 'src'), { recursive: true });
    writeFileSync(join(fixture, 'packages', 'a', 'src', 'huge.d.ts'), linesOf(5000));

    const r = runCheck({
      LINE_CAP_ROOT: fixture,
      LINE_CAP_PACKAGE_DIRS_JSON: JSON.stringify(['packages/a/src']),
      LINE_CAP_GRANDFATHER_JSON: JSON.stringify({}),
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('line-cap-check PASSED for 0 source files');
  });

  test('an orphaned grandfather entry (file deleted or renamed) fails', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'line-cap-'));
    mkdirSync(join(fixture, 'packages', 'a', 'src'), { recursive: true });
    writeFileSync(join(fixture, 'packages', 'a', 'src', 'small.ts'), linesOf(10));

    const r = runCheck({
      LINE_CAP_ROOT: fixture,
      LINE_CAP_PACKAGE_DIRS_JSON: JSON.stringify(['packages/a/src']),
      LINE_CAP_GRANDFATHER_JSON: JSON.stringify({
        'packages/a/src/deleted.ts': { ceiling: 1200, justification: 'test fixture, shrink-only' },
      }),
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('packages/a/src/deleted.ts');
    expect(r.stderr).toContain('not found among scanned source files');
  });
});
