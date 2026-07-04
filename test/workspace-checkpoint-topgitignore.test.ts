import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceCheckpointManager } from '../packages/sdk/src/platform/workspace/checkpoint/manager.js';

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString('utf8'));
  }
  return Buffer.from(result.stdout).toString('utf8');
}

function tempWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('WorkspaceCheckpointManager in a repo whose top-level .gitignore ignores .goodvibes/', () => {
  // Regression test for a live-replay finding: SideGitRunner.stageAll() used
  // to pass an explicit `:(exclude).goodvibes` pathspec to `git add -A`. When
  // the WORKSPACE's own top-level .gitignore also contains a `.goodvibes/`
  // rule (exactly what this project's own TUI writes at startup), naming that
  // already-ignored path explicitly in a pathspec makes git abort the whole
  // `add -A` with "The following paths are ignored by one of your .gitignore
  // files: .goodvibes ... Use -f if you really want to add them." — because
  // git's ignore check fires on any pathspec that literally names an ignored
  // path, exclude magic or not. `.goodvibes/.gitignore`'s own `*` self-ignore
  // (written by SideGitRunner.init()) already keeps everything under
  // `.goodvibes` out of a plain `git add -A -- .` sweep with no explicit
  // exclude needed, so every checkpoint operation below must succeed even
  // though the workspace itself declares `.goodvibes/` ignored up front.
  test('create() succeeds, list() reflects it, and restore() works', async () => {
    const root = tempWorkspace('wcp-topgitignore-');
    runGit(root, ['init', '--quiet']);
    runGit(root, ['config', 'user.name', 'Test User']);
    runGit(root, ['config', 'user.email', 'test@example.com']);
    writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
    runGit(root, ['add', '.gitignore']);
    runGit(root, ['commit', '-m', 'initial: ignore .goodvibes']);

    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root });
    writeFileSync(join(root, 'feature.ts'), 'export const ok = true;\n');

    const cp1 = await manager.create({ kind: 'manual', label: 'cp1' });
    expect(cp1).not.toBeNull();
    expect(cp1!.id).toMatch(/^wcp_[0-9a-z]+_[0-9a-f]{8}$/);

    const list = await manager.list();
    expect(list.map((c) => c.id)).toEqual([cp1!.id]);

    writeFileSync(join(root, 'feature.ts'), 'export const ok = false;\n');
    const result = await manager.restore(cp1!.id);
    expect(readFileSync(join(root, 'feature.ts'), 'utf-8')).toBe('export const ok = true;\n');
    expect(result.checkpointId).toBe(cp1!.id);

    // The self-ignore file this whole mechanism relies on really is in place.
    expect(existsSync(join(root, '.goodvibes', '.gitignore'))).toBe(true);
    expect(readFileSync(join(root, '.goodvibes', '.gitignore'), 'utf-8')).toContain('*');
  });

  test('automatic (event-triggered) snapshots also succeed under a top-level .goodvibes/ ignore rule', async () => {
    const root = tempWorkspace('wcp-topgitignore-auto-');
    runGit(root, ['init', '--quiet']);
    runGit(root, ['config', 'user.name', 'Test User']);
    runGit(root, ['config', 'user.email', 'test@example.com']);
    writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
    runGit(root, ['add', '.gitignore']);
    runGit(root, ['commit', '-m', 'initial: ignore .goodvibes']);

    // No runtimeBus is wired here (that plumbing is exercised in
    // workspace-checkpoint-events.test.ts); this simulates the same
    // "manual create racing an automatic snapshot" shape by firing two
    // uncoordinated create() calls back-to-back, both of which must go
    // through SideGitRunner.init()'s self-ignore write before either one
    // stages anything.
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root });
    writeFileSync(join(root, 'a.ts'), 'v1\n');
    const [manual, auto] = await Promise.all([
      manager.create({ kind: 'manual', label: 'manual' }),
      manager.create({ kind: 'turn', turnId: 't1', label: 'auto' }),
    ]);
    // Exactly one of the two racing create() calls observes a change to
    // stage (the other sees an identical tree and dedupes to null) — either
    // way, neither call may throw.
    expect([manual, auto].some((c) => c !== null)).toBe(true);

    const list = await manager.list();
    expect(list.length).toBeGreaterThan(0);
  });
});
