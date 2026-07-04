import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentWorktree } from '../packages/sdk/src/platform/agents/worktree.js';

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString('utf8'));
  }
  return Buffer.from(result.stdout).toString('utf8');
}

describe('AgentWorktree', () => {
  test('commitWorkingTree commits project changes without staging GoodVibes internal state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-worktree-'));
    runGit(root, ['init']);

    writeFileSync(join(root, 'feature.ts'), 'export const ok = true;\n');
    mkdirSync(join(root, '.goodvibes', 'sessions'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'sessions', 'internal.json'), '{}\n');

    const worktree = new AgentWorktree(root);
    const { hash } = await worktree.commitWorkingTree('WRFC: commit project changes');

    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    const trackedFiles = runGit(root, ['ls-files']);
    expect(trackedFiles).toContain('feature.ts');
    expect(trackedFiles).not.toContain('.goodvibes');

    writeFileSync(join(root, '.goodvibes', 'sessions', 'later.json'), '{}\n');
    await expect(worktree.commitWorkingTree('WRFC: internal only')).resolves.toEqual({ hash: null, skippedIgnored: [] });
  });

  test('commitWorkingTree(message, paths) stages only the given paths, leaving other dirty files uncommitted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-worktree-scoped-'));
    runGit(root, ['init']);

    writeFileSync(join(root, 'touched.ts'), 'export const touched = true;\n');
    writeFileSync(join(root, 'untouched.ts'), 'export const untouched = true;\n');

    const worktree = new AgentWorktree(root);
    const { hash } = await worktree.commitWorkingTree('WRFC: scoped commit', ['touched.ts']);

    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    const committedFiles = runGit(root, ['show', '--stat', '--name-only', 'HEAD']);
    expect(committedFiles).toContain('touched.ts');
    expect(committedFiles).not.toContain('untouched.ts');

    const status = runGit(root, ['status', '--porcelain']);
    expect(status).toContain('untouched.ts');
  });

  test('commitWorkingTree(message, paths) tolerates a hallucinated path mixed into the batch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-worktree-scoped-hallucinated-'));
    runGit(root, ['init']);

    writeFileSync(join(root, 'real.ts'), 'export const real = true;\n');

    const worktree = new AgentWorktree(root);
    const { hash } = await worktree.commitWorkingTree('WRFC: scoped commit with bad claim', [
      'real.ts',
      'this/path/was/never/written.ts',
    ]);

    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    const committedFiles = runGit(root, ['show', '--stat', '--name-only', 'HEAD']);
    expect(committedFiles).toContain('real.ts');
  });

  test('commitWorkingTree(message, paths) stages a confirmed deletion even though the path no longer exists on disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-worktree-scoped-deleted-'));
    runGit(root, ['init']);
    writeFileSync(join(root, 'gone.ts'), 'export const gone = true;\n');
    runGit(root, ['add', 'gone.ts']);
    runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'seed']);
    // Delete the tracked file from the working tree without staging the removal — the
    // engineer's report claims a deletion of a path that git still has tracked in HEAD.
    Bun.spawnSync(['rm', join(root, 'gone.ts')]);

    const worktree = new AgentWorktree(root);
    const { hash } = await worktree.commitWorkingTree('WRFC: scoped deletion', ['gone.ts']);

    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    const trackedFiles = runGit(root, ['ls-files']);
    expect(trackedFiles).not.toContain('gone.ts');
  });

  test('commitWorkingTree(message, paths) commits the deliverable and skips a gitignored path in the same ledger, leaving a clean index', async () => {
    // Reproduces the WRFC trust defect: the product writes .gitignore (ignoring .goodvibes/) and
    // its own bookkeeping under .goodvibes/, so a self-reported ledger mixes a real deliverable
    // with an ignored path. `git add -A -- <deliverable> <ignored>` exits non-zero AFTER staging
    // the deliverable — the ignored path must be filtered out first.
    const root = mkdtempSync(join(tmpdir(), 'agent-worktree-ignored-'));
    runGit(root, ['init']);
    writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
    runGit(root, ['add', '.gitignore']);
    runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'seed .gitignore']);

    writeFileSync(join(root, 'slugify.ts'), 'export const slugify = (s: string) => s;\n');
    mkdirSync(join(root, '.goodvibes', 'memory'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'memory', 'repo_preferences.json'), '{"pref":1}\n');

    const worktree = new AgentWorktree(root);
    const result = await worktree.commitWorkingTree('WRFC: slugify', [
      'slugify.ts',
      '.goodvibes/memory/repo_preferences.json',
    ]);

    // The deliverable committed; the ignored bookkeeping path is reported as skipped, not failed.
    expect(result.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.skippedIgnored).toEqual(['.goodvibes/memory/repo_preferences.json']);
    const committedFiles = runGit(root, ['show', '--stat', '--name-only', 'HEAD']);
    expect(committedFiles).toContain('slugify.ts');
    expect(committedFiles).not.toContain('.goodvibes');
    // Index is clean — nothing left staged after the commit.
    expect(runGit(root, ['diff', '--cached', '--name-only']).trim()).toBe('');
  });

  test('commitWorkingTree(message, paths) returns hash:null when every scoped path is gitignored, staging nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-worktree-all-ignored-'));
    runGit(root, ['init']);
    writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
    runGit(root, ['add', '.gitignore']);
    runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'seed']);
    mkdirSync(join(root, '.goodvibes', 'memory'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'memory', 'x.json'), '{}\n');

    const worktree = new AgentWorktree(root);
    const result = await worktree.commitWorkingTree('WRFC: only ignored', ['.goodvibes/memory/x.json']);

    expect(result.hash).toBeNull();
    expect(result.skippedIgnored).toEqual(['.goodvibes/memory/x.json']);
    expect(runGit(root, ['diff', '--cached', '--name-only']).trim()).toBe('');
  });

  test('commitWorkingTree restores the index when the commit step fails after staging', async () => {
    // A genuinely-failing commit (here: a pre-commit hook that rejects) must not leave the
    // deliverable staged in the user's index. The staged path is reset before the error propagates.
    const root = mkdtempSync(join(tmpdir(), 'agent-worktree-restore-'));
    runGit(root, ['init']);
    writeFileSync(join(root, 'seed.ts'), 'export const seed = 1;\n');
    runGit(root, ['add', 'seed.ts']);
    runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'seed']);

    // Install a pre-commit hook that always rejects. The executable bit must be set explicitly —
    // git ignores a non-executable hook (and writeFileSync's mode is not honored reliably here).
    const hookDir = join(root, '.git', 'hooks');
    mkdirSync(hookDir, { recursive: true });
    const hookPath = join(hookDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
    Bun.spawnSync(['chmod', '+x', hookPath]);

    writeFileSync(join(root, 'deliverable.ts'), 'export const d = true;\n');
    const worktree = new AgentWorktree(root);
    await expect(worktree.commitWorkingTree('WRFC: rejected', ['deliverable.ts'])).rejects.toThrow();

    // Index must be clean despite the failed commit — the staged path was reset.
    expect(runGit(root, ['diff', '--cached', '--name-only']).trim()).toBe('');
    // And the working-tree file is untouched (still present, just not staged).
    expect(runGit(root, ['status', '--porcelain']).trim()).toContain('deliverable.ts');
  });
});
