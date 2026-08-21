import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherTrainStatus, realExec, type TrainStatusManifest } from '@pellux/goodvibes-toolchain';

// Integration coverage: real git against two tiny throwaway repos (one
// tagged, one untagged). npm is stubbed out via fetchLatestSdkVersion so the
// test never touches the real registry.

const ROOT = mkdtempSync(join(tmpdir(), 'gv-train-status-'));

function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

function initRepo(name: string): string {
  const dir = join(ROOT, name);
  execFileSync('mkdir', ['-p', dir]);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'ci@goodvibes.local');
  git(dir, 'config', 'user.name', 'CI');
  return dir;
}

function commit(dir: string, packageVersion: string, message: string): void {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'x', version: packageVersion }, null, 2)}\n`);
  // A marker file carrying the commit message keeps every commit's tree
  // distinct even when successive calls reuse the same package version, so
  // `git commit` always has something staged.
  writeFileSync(join(dir, 'marker.txt'), `${message}\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', message);
}

// Tagged repo: v1.0.0, then two commits after the tag.
const taggedDir = initRepo('tagged-repo');
commit(taggedDir, '1.0.0', 'init');
git(taggedDir, 'tag', 'v1.0.0');
commit(taggedDir, '1.0.1-dev', 'work after tag 1');
commit(taggedDir, '1.0.1-dev', 'work after tag 2');

// Untagged repo: an sdk-consumer with a stale SDK pin, no tag at all.
const untaggedDir = initRepo('untagged-repo');
writeFileSync(
  join(untaggedDir, 'package.json'),
  `${JSON.stringify({ name: 'consumer', version: '0.3.0', dependencies: { '@pellux/goodvibes-sdk': '1.0.0' } }, null, 2)}\n`,
);
git(untaggedDir, 'add', '.');
git(untaggedDir, 'commit', '-m', 'init');

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('gatherTrainStatus against real git repos', () => {
  test('a tagged sdk repo with commits since the tag reports the correct counts and action', () => {
    const manifest: TrainStatusManifest = {
      repos: [{ path: taggedDir, name: 'goodvibes-sdk', kind: 'sdk' }],
    };
    const result = gatherTrainStatus(manifest, { exec: realExec, fetchLatestSdkVersion: () => null });
    const row = result.rows[0]!;
    expect(row.error).toBeUndefined();
    expect(row.version).toBe('1.0.1-dev');
    expect(row.lastTag).toBe('v1.0.0');
    expect(row.commitsSinceTag).toBe(2);
    expect(row.unpushedCommits).toBe(0); // no upstream configured, tolerated as 0
    expect(row.action).toBe('cut vNEXT');
  });

  test('an untagged sdk-consumer counts every commit as since-tag and flags a stale pin', () => {
    const manifest: TrainStatusManifest = {
      repos: [{ path: untaggedDir, name: 'consumer-repo', kind: 'sdk-consumer' }],
    };
    const result = gatherTrainStatus(manifest, { exec: realExec, fetchLatestSdkVersion: () => '1.4.0' });
    expect(result.latestSdkVersion).toBe('1.4.0');
    const row = result.rows[0]!;
    expect(row.error).toBeUndefined();
    expect(row.version).toBe('0.3.0');
    expect(row.lastTag).toBe('(none)');
    expect(row.commitsSinceTag).toBe(1);
    expect(row.sdkPin).toBe('1.0.0 -> 1.4.0 (repin needed)');
    expect(row.action).toBe('repin to 1.4.0 then release');
  });

  test('fetchLatestSdkVersion is never called when no repo in the manifest is an sdk-consumer', () => {
    const manifest: TrainStatusManifest = {
      repos: [{ path: taggedDir, name: 'goodvibes-sdk', kind: 'sdk' }],
    };
    let called = false;
    gatherTrainStatus(manifest, { exec: realExec, fetchLatestSdkVersion: () => { called = true; return '1.0.0'; } });
    expect(called).toBe(false);
  });

  test('a missing path produces a clean error row instead of throwing', () => {
    const manifest: TrainStatusManifest = {
      repos: [{ path: join(ROOT, 'does-not-exist'), name: 'ghost', kind: 'independent' }],
    };
    const result = gatherTrainStatus(manifest, { exec: realExec, fetchLatestSdkVersion: () => null });
    const row = result.rows[0]!;
    expect(row.error).toContain('path does not exist');
    expect(row.action).toContain('ERROR:');
  });

  test('a path that exists but is not a git repo produces a clean error row', () => {
    const notGit = join(ROOT, 'not-a-repo');
    execFileSync('mkdir', ['-p', notGit]);
    const manifest: TrainStatusManifest = {
      repos: [{ path: notGit, name: 'plain-dir', kind: 'independent' }],
    };
    const result = gatherTrainStatus(manifest, { exec: realExec, fetchLatestSdkVersion: () => null });
    const row = result.rows[0]!;
    expect(row.error).toContain('not a git repository');
  });
});
