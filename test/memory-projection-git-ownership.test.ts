/**
 * Memory projection git ownership, proven against the real system git: the
 * projection only ever commits to a repository it owns. A projection directory
 * nested inside some other checkout must never produce a commit in that
 * checkout (git resolves upward from a non-root directory, so an unguarded
 * seam would commit scratch files into whatever repository happened to
 * contain them, authored as the operator).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMemoryProjectionGit,
  projectMemoryToFiles,
} from '../packages/sdk/src/platform/state/memory-file-projection.js';
import type { MemoryRecord } from '../packages/sdk/src/platform/state/memory-store.js';

const scratchDirs: string[] = [];

function makeScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-memory-projection-git-'));
  scratchDirs.push(dir);
  return dir;
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf-8' }).trim();
}

function initRepoWithOneCommit(dir: string): void {
  git(['init'], dir);
  writeFileSync(join(dir, 'README.md'), 'foreign checkout\n', 'utf-8');
  git(['add', '-A'], dir);
  git([
    '-c', 'user.name=Foreign Owner',
    '-c', 'user.email=owner@example.com',
    'commit', '--no-verify', '-m', 'initial',
  ], dir);
}

function record(id = 'mem_projection_a'): MemoryRecord {
  return {
    id,
    scope: 'project',
    cls: 'decision',
    summary: 'use bun everywhere',
    detail: 'bun is the runtime',
    tags: ['tooling'],
    confidence: 0.9,
    reviewState: 'approved',
    createdAt: 1000,
    updatedAt: 1000,
  } as unknown as MemoryRecord;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('memory projection commits only to a repository it owns (real git)', () => {
  test('a projection dir nested inside a foreign repository never commits into it', () => {
    const scratch = makeScratch();
    const foreignRepo = join(scratch, 'foreign-repo');
    mkdirSync(foreignRepo, { recursive: true });
    initRepoWithOneCommit(foreignRepo);
    const foreignHeadBefore = git(['rev-parse', 'HEAD'], foreignRepo);

    // The incident shape: a scratch/temp projection dir that happens to live
    // INSIDE someone's real checkout.
    const projectionDir = join(foreignRepo, '.test-tmp-scratch', 'projection');

    const report = projectMemoryToFiles([record()], projectionDir, {
      now: 1000,
      git: createMemoryProjectionGit(),
    });

    // The projection completed and committed — honestly, to its OWN repo.
    expect(report.committed).toBe(true);
    expect(report.written.length).toBe(1);

    // The foreign repository gained no commit and no staged files.
    const foreignHeadAfter = git(['rev-parse', 'HEAD'], foreignRepo);
    expect(foreignHeadAfter).toBe(foreignHeadBefore);
    const foreignLog = git(['log', '--oneline'], foreignRepo);
    expect(foreignLog.split('\n').length).toBe(1);
    expect(foreignLog).not.toContain('memory projection');
    const staged = git(['diff', '--cached', '--name-only'], foreignRepo);
    expect(staged).toBe('');

    // The projection dir became its own repository root with the commit.
    expect(git(['rev-parse', '--show-toplevel'], projectionDir)).toBe(realpathSync(projectionDir));
    const projectionLog = git(['log', '--oneline'], projectionDir);
    expect(projectionLog).toContain('memory projection: 1 record(s)');
    // Authored by the projection's neutral identity, never the operator's.
    const author = git(['log', '-1', '--format=%an <%ae>'], projectionDir);
    expect(author).toBe('GoodVibes Memory Projection <memory-projection@goodvibes.local>');
  });

  test('a projection dir that is its own repository root commits normally', () => {
    const scratch = makeScratch();
    const projectionDir = join(scratch, 'projection');
    mkdirSync(projectionDir, { recursive: true });
    git(['init'], projectionDir);

    const report = projectMemoryToFiles([record()], projectionDir, {
      now: 1000,
      git: createMemoryProjectionGit(),
    });
    expect(report.committed).toBe(true);
    const log = git(['log', '--oneline'], projectionDir);
    expect(log).toContain('memory projection: 1 record(s)');

    // A second projection with no changes stays clean (no throw, no new commit).
    const second = projectMemoryToFiles([record()], projectionDir, {
      now: 1000,
      git: createMemoryProjectionGit(),
    });
    expect(second.committed).toBe(true);
    expect(git(['log', '--oneline'], projectionDir).split('\n').length).toBe(1);
  });

  test('a projection dir in no repository at all gets its own repository', () => {
    const scratch = makeScratch();
    const projectionDir = join(scratch, 'standalone-projection');

    const report = projectMemoryToFiles([record()], projectionDir, {
      now: 1000,
      git: createMemoryProjectionGit(),
    });
    expect(report.committed).toBe(true);
    expect(git(['rev-parse', '--show-toplevel'], projectionDir)).not.toBe('');
    expect(git(['log', '--oneline'], projectionDir)).toContain('memory projection: 1 record(s)');
  });
});
