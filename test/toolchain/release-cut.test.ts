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

  test('names the bad config field before touching the tree', () => {
    const dir = makeRepo();
    try {
      // What a hand-edited toolchain.config.json can hand this tool: the cast in
      // parseToolchainConfig lets a missing array through as if it were typed.
      const broken = { ...config, commitPaths: undefined } as unknown as ReleaseCutConfig;

      expect(() => runReleaseCut({ cwd: dir, bump: 'patch', config: broken })).toThrow(/commitPaths must be an array of strings/);
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim()).toBe('');
      expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version).toBe('1.0.0');
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

  /**
   * A cut that dies between `git commit` and `git tag` leaves a CLEAN tree on
   * the release branch whose package.json is already bumped. Re-running the
   * tool is the natural recovery action, and it used to read that bumped
   * version as `current` and cut a SECOND release on top of it, stranding the
   * first commit in history with no tag.
   */
  describe('crash-retry between commit and tag', () => {
    function cutInterrupted(dir: string): string {
      // Everything runReleaseCut does up to and including the commit.
      const git = (...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }); };
      writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'x', version: '1.1.0' }, null, 2)}\n`);
      writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [1.1.0] - 2026-07-16\n- new feature\n\n## [1.0.0] - 2026-07-01\n- initial\n');
      git('add', 'package.json', 'CHANGELOG.md');
      git('commit', '-m', 'chore: release 1.1.0');
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    }

    test('a re-run finishes the interrupted cut instead of bumping again', () => {
      const dir = makeRepo();
      try {
        const head = cutInterrupted(dir);

        const result = runReleaseCut({ cwd: dir, bump: 'patch', config, date: '2026-07-17' });

        expect(result.version).toBe('1.1.0');
        expect(result.tag).toBe('v1.1.0');
        expect(result.resumed).toBe(true);
        expect(result.committed).toBe(true);
        // No second bump, no second changelog section, no second commit.
        expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version).toBe('1.1.0');
        expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).not.toContain('1.1.1');
        expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()).toBe(head);
        // The tag the crash never got to write now exists, on the release commit.
        expect(execFileSync('git', ['rev-list', '-n', '1', 'v1.1.0'], { cwd: dir, encoding: 'utf8' }).trim()).toBe(head);
        expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim()).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('a third run over a completed cut is a no-op', () => {
      const dir = makeRepo();
      try {
        const head = cutInterrupted(dir);
        runReleaseCut({ cwd: dir, bump: 'patch', config });

        const again = runReleaseCut({ cwd: dir, bump: 'patch', config });

        expect(again).toEqual({ version: '1.1.0', tag: 'v1.1.0', committed: true, resumed: true });
        expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()).toBe(head);
        expect(execFileSync('git', ['tag', '-l'], { cwd: dir, encoding: 'utf8' }).trim()).toBe('v1.1.0');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('dry-run reports the resume without creating the tag', () => {
      const dir = makeRepo();
      try {
        cutInterrupted(dir);

        const result = runReleaseCut({ cwd: dir, bump: 'patch', config, dryRun: true });

        expect(result).toEqual({ version: '1.1.0', tag: 'v1.1.0', committed: false, resumed: true });
        expect(execFileSync('git', ['tag', '-l'], { cwd: dir, encoding: 'utf8' }).trim()).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('refuses when the release tag name is taken by a different commit', () => {
      const dir = makeRepo();
      try {
        execFileSync('git', ['tag', '-a', 'v1.1.0', '-m', 'stale'], { cwd: dir, stdio: 'ignore' });
        cutInterrupted(dir);

        expect(() => runReleaseCut({ cwd: dir, bump: 'patch', config })).toThrow(/already points at a different commit/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('refuses before touching any file when the next tag already exists', () => {
      const dir = makeRepo();
      try {
        execFileSync('git', ['tag', '-a', 'v1.0.1', '-m', 'stale'], { cwd: dir, stdio: 'ignore' });

        expect(() => runReleaseCut({ cwd: dir, bump: 'patch', config })).toThrow(/Tag v1\.0\.1 already exists/);
        // The refusal happens before the bump, so the tree is still clean.
        expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim()).toBe('');
        expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version).toBe('1.0.0');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
