/**
 * git-structured-diff.test.ts — /git diff routes to real diff machinery.
 *
 * Defect class: the consumer's /git diff sliced raw text at 4,000 chars and
 * printed the stub. The SDK now serves the diff STRUCTURALLY (per-file,
 * per-hunk, per-line — no size cap anywhere), so surfaces render it with their
 * diff-view machinery and the truncation branch is deleted. The completeness
 * proof: a diff far larger than 4,000 chars parses and reconstructs
 * byte-for-byte.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitService } from '../packages/sdk/src/platform/git/service.ts';
import { parseUnifiedDiff, reconstructUnifiedDiff } from '../packages/sdk/src/platform/git/structured-diff.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-structdiff-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  return dir;
}

describe('structured git diff — complete, never truncated', () => {
  test('a >4,000-char diff round-trips complete through the structure', async () => {
    const dir = makeRepo();
    // 300 numbered lines committed, then all rewritten + 100 added: the raw
    // diff is far past the old 4,000-char cap.
    const before = Array.from({ length: 300 }, (_, i) => `original line ${i} with some padding text to grow the diff`).join('\n') + '\n';
    writeFileSync(join(dir, 'big.txt'), before, 'utf-8');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'seed');
    const after = Array.from({ length: 400 }, (_, i) => `rewritten line ${i} with different padding text entirely`).join('\n') + '\n';
    writeFileSync(join(dir, 'big.txt'), after, 'utf-8');

    const service = new GitService(dir);
    const raw = await service.diff();
    expect(raw.length).toBeGreaterThan(4_000); // the old cap would have cut this

    const structured = await service.diffStructured();
    // Structure is complete: one modified file, honest add/del totals.
    expect(structured.files.length).toBe(1);
    const file = structured.files[0]!;
    expect(file.newPath).toBe('big.txt');
    expect(file.status).toBe('modified');
    expect(file.additions).toBe(400);
    expect(file.deletions).toBe(300);
    expect(structured.additions).toBe(400);
    expect(structured.deletions).toBe(300);

    // The completeness proof: reconstructing the unified diff from the
    // structure reproduces the raw text byte-for-byte — nothing was dropped.
    expect(reconstructUnifiedDiff(structured)).toBe(raw);
    // And every rewritten line survived (spot-check far past 4,000 chars).
    const addedTexts = file.hunks.flatMap((hunk) => hunk.lines.filter((l) => l.kind === 'add').map((l) => l.text));
    expect(addedTexts[399]).toBe('rewritten line 399 with different padding text entirely');
  });

  test('multi-file diffs with adds and deletes parse per file', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'keep.txt'), 'kept\n', 'utf-8');
    writeFileSync(join(dir, 'gone.txt'), 'to be deleted\n', 'utf-8');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'seed');
    writeFileSync(join(dir, 'keep.txt'), 'kept but changed\n', 'utf-8');
    writeFileSync(join(dir, 'new.txt'), 'brand new\n', 'utf-8');
    git(dir, 'rm', '-q', 'gone.txt');
    git(dir, 'add', 'new.txt', 'keep.txt');

    const service = new GitService(dir);
    const structured = await service.diffStructured('HEAD');
    const byPath = new Map(structured.files.map((f) => [f.newPath ?? f.oldPath, f]));
    expect(byPath.get('keep.txt')?.status).toBe('modified');
    expect(byPath.get('new.txt')?.status).toBe('added');
    expect(byPath.get('gone.txt')?.status).toBe('deleted');
  });

  test('diffBetweenStructured covers two refs and an empty diff yields zero files', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'a.txt'), 'one\n', 'utf-8');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'first');
    writeFileSync(join(dir, 'a.txt'), 'two\n', 'utf-8');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'second');

    const service = new GitService(dir);
    const between = await service.diffBetweenStructured('HEAD~1', 'HEAD');
    expect(between.files.length).toBe(1);
    expect(between.files[0]!.additions).toBe(1);
    expect(between.files[0]!.deletions).toBe(1);

    expect(parseUnifiedDiff('')).toEqual({ files: [], additions: 0, deletions: 0 });
  });
});
