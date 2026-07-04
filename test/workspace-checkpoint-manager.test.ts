import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('WorkspaceCheckpointManager', () => {
  test('works in a non-git workspace: creates its own side GIT_DIR without a real .git directory', async () => {
    const root = tempWorkspace('wcp-nongit-');
    expect(existsSync(join(root, '.git'))).toBe(false);

    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root });
    writeFileSync(join(root, 'feature.ts'), 'export const ok = true;\n');

    const checkpoint = await manager.create({ kind: 'manual', label: 'first' });
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.id).toMatch(/^wcp_[0-9a-z]+_[0-9a-f]{8}$/);

    expect(existsSync(join(root, '.goodvibes', 'checkpoints', 'git', 'HEAD'))).toBe(true);
    expect(existsSync(join(root, '.git'))).toBe(false);
  });

  test('never pollutes a real user git repo: HEAD, status, cached diff, and stash are all unchanged after create+restore', async () => {
    const root = tempWorkspace('wcp-usergit-');
    runGit(root, ['init', '--quiet']);
    runGit(root, ['config', 'user.name', 'Test User']);
    runGit(root, ['config', 'user.email', 'test@example.com']);
    writeFileSync(join(root, 'README.md'), '# hello\n');
    runGit(root, ['add', 'README.md']);
    runGit(root, ['commit', '-m', 'initial']);

    // app.ts is created (and left untracked in the user's real repo) before
    // the baseline snapshot so the assertions below isolate what OUR tool
    // does, not the pre-existing "untracked file" noise app.ts's mere
    // presence already causes in `git status --porcelain`.
    writeFileSync(join(root, 'app.ts'), 'export const app = 1;\n');
    const beforeHead = runGit(root, ['rev-parse', 'HEAD']).trim();
    const beforeStatus = runGit(root, ['status', '--porcelain']).trim();
    const beforeCached = runGit(root, ['diff', '--cached']).trim();
    const beforeStash = runGit(root, ['stash', 'list']).trim();

    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root });
    const cp1 = await manager.create({ kind: 'manual', label: 'cp1' });
    expect(cp1).not.toBeNull();

    writeFileSync(join(root, 'app.ts'), 'export const app = 2;\n');
    await manager.restore(cp1!.id);

    const afterHead = runGit(root, ['rev-parse', 'HEAD']).trim();
    const afterStatus = runGit(root, ['status', '--porcelain']).trim();
    const afterCached = runGit(root, ['diff', '--cached']).trim();
    const afterStash = runGit(root, ['stash', 'list']).trim();

    expect(afterHead).toBe(beforeHead);
    expect(afterStatus).toBe(beforeStatus);
    expect(afterCached).toBe(beforeCached);
    expect(afterStash).toBe(beforeStash);
  });

  test('create() dedupes: returns null when the tree is unchanged since the parent checkpoint', async () => {
    const root = tempWorkspace('wcp-dedupe-');
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root });
    writeFileSync(join(root, 'a.txt'), 'a'.repeat(1000));

    const cp1 = await manager.create({ kind: 'manual', label: 'cp1' });
    expect(cp1).not.toBeNull();

    const noop = await manager.create({ kind: 'manual', label: 'cp1-again' });
    expect(noop).toBeNull();

    // Only the newly-added/changed file's bytes should count toward sizeBytes,
    // not the whole tree — proves the accounting (and by extension git's own
    // object dedup underneath) scales with the diff, not with total size.
    writeFileSync(join(root, 'b.txt'), 'b'.repeat(37));
    const cp2 = await manager.create({ kind: 'manual', label: 'cp2' });
    expect(cp2).not.toBeNull();
    expect(cp2!.sizeBytes).toBe(37);
    expect(cp2!.parentId).toBe(cp1!.id);
  });

  test('list() returns newest-first and supports kind/since/limit filters', async () => {
    const root = tempWorkspace('wcp-list-');
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root });

    writeFileSync(join(root, 'a.txt'), '1');
    const cp1 = await manager.create({ kind: 'manual', label: 'cp1' });
    writeFileSync(join(root, 'a.txt'), '2');
    const cp2 = await manager.create({ kind: 'turn', label: 'cp2', turnId: 't1' });
    writeFileSync(join(root, 'a.txt'), '3');
    const cp3 = await manager.create({ kind: 'manual', label: 'cp3' });

    const all = await manager.list();
    expect(all.map((c) => c.id)).toEqual([cp3!.id, cp2!.id, cp1!.id]);

    const onlyTurns = await manager.list({ kind: 'turn' });
    expect(onlyTurns.map((c) => c.id)).toEqual([cp2!.id]);

    const limited = await manager.list({ limit: 1 });
    expect(limited.map((c) => c.id)).toEqual([cp3!.id]);
  });

  test('diff() reports file lists between two checkpoints and against the live working tree', async () => {
    const root = tempWorkspace('wcp-diff-');
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root });

    writeFileSync(join(root, 'a.txt'), 'one\n');
    const cp1 = await manager.create({ kind: 'manual', label: 'cp1' });
    writeFileSync(join(root, 'b.txt'), 'two\n');
    const cp2 = await manager.create({ kind: 'manual', label: 'cp2' });

    const diffBetween = await manager.diff(cp1!.id, cp2!.id);
    expect(diffBetween.files).toEqual(['b.txt']);
    expect(diffBetween.unifiedDiff).toContain('b.txt');
    expect(diffBetween.to).toBe(cp2!.id);

    writeFileSync(join(root, 'a.txt'), 'one-edited\n');
    const diffAgainstWorking = await manager.diff(cp2!.id);
    expect(diffAgainstWorking.to).toBe('WORKING');
    expect(diffAgainstWorking.files).toEqual(['a.txt']);
  });

  test('restore() re-creates a file deleted after the checkpoint and removes a file added after it', async () => {
    const root = tempWorkspace('wcp-restore-');
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root });

    writeFileSync(join(root, 'keep.txt'), 'keep\n');
    writeFileSync(join(root, 'to-delete.txt'), 'will be deleted after checkpoint\n');
    const cp1 = await manager.create({ kind: 'manual', label: 'cp1' });
    expect(cp1).not.toBeNull();

    rmSync(join(root, 'to-delete.txt'));
    writeFileSync(join(root, 'added-later.txt'), 'should be removed on restore\n');

    const result = await manager.restore(cp1!.id);

    expect(existsSync(join(root, 'to-delete.txt'))).toBe(true);
    expect(readFileSync(join(root, 'to-delete.txt'), 'utf-8')).toBe('will be deleted after checkpoint\n');
    expect(existsSync(join(root, 'added-later.txt'))).toBe(false);
    expect(existsSync(join(root, 'keep.txt'))).toBe(true);
    expect(result.removedFiles).toContain('added-later.txt');
    expect(result.restoredFiles).toContain('to-delete.txt');
    // A safety checkpoint is recorded by default since the tree changed since cp1.
    expect(result.safetyCheckpointId).not.toBeNull();
  });

  test('restore() never deletes an untracked path outside the checkpoint set (workspace .gitignore is honored)', async () => {
    const root = tempWorkspace('wcp-untracked-');
    writeFileSync(join(root, '.gitignore'), 'dist/\n');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'build-output.txt'), 'never touched\n');

    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root });
    writeFileSync(join(root, 'src.ts'), 'v1\n');
    const cp1 = await manager.create({ kind: 'manual', label: 'cp1' });
    expect(cp1).not.toBeNull();

    writeFileSync(join(root, 'src.ts'), 'v2\n');
    await manager.create({ kind: 'manual', label: 'cp2' });

    await manager.restore(cp1!.id);

    expect(existsSync(join(root, 'dist', 'build-output.txt'))).toBe(true);
    expect(readFileSync(join(root, 'dist', 'build-output.txt'), 'utf-8')).toBe('never touched\n');
  });

  test('restore() and a concurrent create() are serialized: a racing auto-snapshot cannot interleave its staging between read-tree-reset and checkout-index-all', async () => {
    const root = tempWorkspace('wcp-concurrency-');
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root });

    writeFileSync(join(root, 'a.txt'), 'v1\n');
    const cp1 = await manager.create({ kind: 'manual', label: 'cp1' });
    expect(cp1).not.toBeNull();

    writeFileSync(join(root, 'a.txt'), 'v2\n');
    writeFileSync(join(root, 'extra.txt'), 'added after checkpoint\n');

    // Widen the window between the side index being reset to the target
    // tree and the working tree actually being checked out from it — exactly
    // the window a same-tick auto-snapshot create() could land its
    // `git add -A` inside if operations weren't serialized (FINDING 1). We
    // only patch this one manager instance's runner, not the class, and we
    // restore the real behavior first thing inside the wrapper — this is a
    // timing probe, not a stub.
    const sideGit = (manager as unknown as { sideGit: { readTreeReset: (commit: string) => Promise<void> } }).sideGit;
    const originalReadTreeReset = sideGit.readTreeReset.bind(sideGit);
    sideGit.readTreeReset = async (commit: string) => {
      await originalReadTreeReset(commit);
      await new Promise((resolve) => setTimeout(resolve, 200));
    };

    // Fire restore() and a "concurrent auto-snapshot" create() back-to-back,
    // uncoordinated by the caller — exactly how a bus-driven auto-snapshot
    // (TURN_COMPLETED etc.) would land mid-restore in the field.
    const restorePromise = manager.restore(cp1!.id);
    const createPromise = manager.create({ kind: 'turn', turnId: 'racing-turn', label: 'racing auto-snapshot' });

    const [restoreResult, racingCheckpoint] = await Promise.all([restorePromise, createPromise]);

    // The restore itself must be exactly correct — not corrupted by the
    // racing create()'s `git add -A` re-staging the pre-restore disk state
    // into the index in between reset and checkout.
    expect(readFileSync(join(root, 'a.txt'), 'utf-8')).toBe('v1\n');
    expect(existsSync(join(root, 'extra.txt'))).toBe(false);
    expect(restoreResult.restoredFiles).toContain('a.txt');
    expect(restoreResult.removedFiles).toContain('extra.txt');

    // The racing create() must have observed the fully-restored workspace,
    // never some torn hybrid of pre- and post-restore state: diffing it
    // against cp1 (the restore target) must show zero file differences —
    // the only way that's possible is if create()'s own `git add -A` ran
    // strictly after restore()'s read-tree-reset AND checkout-index-all had
    // both completed.
    expect(racingCheckpoint).not.toBeNull();
    const diffAgainstTarget = await manager.diff(cp1!.id, racingCheckpoint!.id);
    expect(diffAgainstTarget.files).toEqual([]);

    // The checkpoint set as a whole is coherent: cp1, the safety checkpoint
    // restore() took automatically, and the racing create() — three
    // distinct ids, no corruption, no lost/duplicated entries.
    const all = await manager.list();
    const allIds = all.map((c) => c.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds).toContain(cp1!.id);
    expect(allIds).toContain(racingCheckpoint!.id);
    expect(restoreResult.safetyCheckpointId).not.toBeNull();
    expect(allIds).toContain(restoreResult.safetyCheckpointId);
    expect(all).toHaveLength(3);
  });

  test('restore() with safetyCheckpoint: false skips the safety checkpoint', async () => {
    const root = tempWorkspace('wcp-nosafety-');
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root });

    writeFileSync(join(root, 'a.txt'), '1');
    const cp1 = await manager.create({ kind: 'manual', label: 'cp1' });
    writeFileSync(join(root, 'a.txt'), '2');

    const result = await manager.restore(cp1!.id, { safetyCheckpoint: false });
    expect(result.safetyCheckpointId).toBeNull();
    expect(readFileSync(join(root, 'a.txt'), 'utf-8')).toBe('1');

    const list = await manager.list();
    expect(list).toHaveLength(1);
  });
});
