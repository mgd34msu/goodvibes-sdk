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
});
