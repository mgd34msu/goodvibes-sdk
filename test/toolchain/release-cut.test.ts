import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextVersion, parseSemver, buildChangelogSection, insertChangelogSection, runReleaseCut, type ReleaseCutConfig } from '@pellux/goodvibes-toolchain';

describe('release-cut pure helpers', () => {
  test('nextVersion for each bump kind', () => {
    expect(nextVersion('1.10.1', 'patch')).toBe('1.10.2');
    expect(nextVersion('1.10.1', 'minor')).toBe('1.11.0');
    expect(nextVersion('1.10.1', 'major')).toBe('2.0.0');
  });
  test('parseSemver rejects a range', () => {
    expect(() => parseSemver('^1.2.3')).toThrow();
  });
  test('buildChangelogSection renders bracket + notes', () => {
    const section = buildChangelogSection('1.2.0', 'bracket', '2026-07-16', ['- Added a thing']);
    expect(section).toContain('## [1.2.0] - 2026-07-16');
    expect(section).toContain('- Added a thing');
  });
  test('insertChangelogSection top-prepends above the first heading', () => {
    const out = insertChangelogSection('# Changelog\n\n## [1.0.0]\n- old\n', 'NEW\n', 'top');
    expect(out.indexOf('NEW')).toBeLessThan(out.indexOf('## [1.0.0]'));
  });
  test('insertChangelogSection after the first separator', () => {
    const out = insertChangelogSection('# Changelog\n---\n## [1.0.0]\n', 'NEW\n', 'first-separator');
    expect(out).toContain('---\n\nNEW');
  });
});

describe('release-cut against a temp git fixture', () => {
  const config: ReleaseCutConfig = {
    branch: 'main',
    versionFiles: [],
    syncCommands: [],
    commitPaths: ['package.json', 'CHANGELOG.md'],
    changelogHeading: 'bracket',
    changelogInsertMarker: 'top',
  };

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gv-relcut-'));
    const git = (...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }); };
    git('init', '-b', 'main');
    git('config', 'user.email', 'ci@goodvibes.local');
    git('config', 'user.name', 'CI');
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2)}\n`);
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-07-01\n- initial\n');
    git('add', '.');
    git('commit', '-m', 'init');
    return dir;
  }

  test('bumps, changelogs, commits, and tags a clean tree', () => {
    const dir = makeRepo();
    try {
      const result = runReleaseCut({ cwd: dir, bump: 'minor', config, notes: ['- new feature'], date: '2026-07-16' });
      expect(result.version).toBe('1.1.0');
      expect(result.tag).toBe('v1.1.0');
      expect(result.committed).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version).toBe('1.1.0');
      expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toContain('## [1.1.0] - 2026-07-16');
      const tags = execFileSync('git', ['tag', '-l'], { cwd: dir, encoding: 'utf8' });
      expect(tags).toContain('v1.1.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses a dirty tree', () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, 'dirty.txt'), 'uncommitted');
      expect(() => runReleaseCut({ cwd: dir, bump: 'patch', config })).toThrow(/not clean/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dry-run makes no commit', () => {
    const dir = makeRepo();
    try {
      const result = runReleaseCut({ cwd: dir, bump: 'patch', config, dryRun: true });
      expect(result.committed).toBe(false);
      expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version).toBe('1.0.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
