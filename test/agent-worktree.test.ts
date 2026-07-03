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
    const hash = await worktree.commitWorkingTree('WRFC: commit project changes');

    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    const trackedFiles = runGit(root, ['ls-files']);
    expect(trackedFiles).toContain('feature.ts');
    expect(trackedFiles).not.toContain('.goodvibes');

    writeFileSync(join(root, '.goodvibes', 'sessions', 'later.json'), '{}\n');
    await expect(worktree.commitWorkingTree('WRFC: internal only')).resolves.toBeNull();
  });

  test('commitWorkingTree(message, paths) stages only the given paths, leaving other dirty files uncommitted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-worktree-scoped-'));
    runGit(root, ['init']);

    writeFileSync(join(root, 'touched.ts'), 'export const touched = true;\n');
    writeFileSync(join(root, 'untouched.ts'), 'export const untouched = true;\n');

    const worktree = new AgentWorktree(root);
    const hash = await worktree.commitWorkingTree('WRFC: scoped commit', ['touched.ts']);

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
    const hash = await worktree.commitWorkingTree('WRFC: scoped commit with bad claim', [
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
    const hash = await worktree.commitWorkingTree('WRFC: scoped deletion', ['gone.ts']);

    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    const trackedFiles = runGit(root, ['ls-files']);
    expect(trackedFiles).not.toContain('gone.ts');
  });
});
