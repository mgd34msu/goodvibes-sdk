/**
 * WorkspaceCheckpointManager — root guard, git-root preference, first-snapshot
 * size guard, and automatic retention wiring.
 *
 * Pins the protections added after an orphaned multi-GiB checkpoint store
 * (rooted at $HOME, no refs) had to be deleted by hand: a daemon whose cwd is a
 * broad directory must refuse to snapshot it rather than silently regrowing the
 * store, and retention must actually run in production, not just exist.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceCheckpointManager } from '../packages/sdk/src/platform/workspace/checkpoint/manager.js';

function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString('utf8'));
  }
}

function tempWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('WorkspaceCheckpointManager — broad-root guard', () => {
  test('refuses a home-directory root: create() throws an honest, override-naming message', async () => {
    const root = tempWorkspace('wcp-home-');
    // Treat the workspace root AS the home directory via the homeDir override.
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root, homeDir: root });
    writeFileSync(join(root, 'a.txt'), 'hello\n');

    let message = '';
    try {
      await manager.create({ kind: 'manual', label: 'should-refuse' });
      throw new Error('expected create() to throw for a home-directory root');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain('user home directory');
    expect(message).toContain('allowBroadRoot');
    // No snapshot was recorded for the refused root — the guard blocks the
    // actual checkpoint commit/objects (the thing that regrows the store), not
    // the tiny empty side-repo scaffolding init lays down.
    expect(await manager.list()).toHaveLength(0);
  });

  test('allowBroadRoot override permits an otherwise-refused home root', async () => {
    const root = tempWorkspace('wcp-home-ok-');
    const manager = new WorkspaceCheckpointManager({
      workspaceRoot: root,
      homeDir: root,
      allowBroadRoot: true,
    });
    writeFileSync(join(root, 'a.txt'), 'hello\n');

    const cp = await manager.create({ kind: 'manual', label: 'allowed' });
    expect(cp).not.toBeNull();
  });

  test('prefers the enclosing git repository root over a raw cwd subdirectory', async () => {
    const root = tempWorkspace('wcp-gitroot-');
    runGit(root, ['init', '--quiet']);
    const subdir = join(root, 'packages', 'app');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, 'index.ts'), 'export const x = 1;\n');

    // Point the manager at the SUBDIR; it must resolve up to the repo root.
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: subdir });
    const cp = await manager.create({ kind: 'manual', label: 'from-subdir' });
    expect(cp).not.toBeNull();

    // Checkpoint storage lives at the repo root, not inside the subdir.
    expect(existsSync(join(root, '.goodvibes', 'checkpoints', 'git', 'HEAD'))).toBe(true);
    expect(existsSync(join(subdir, '.goodvibes', 'checkpoints', 'git', 'HEAD'))).toBe(false);
    expect(manager.workspaceRoot).not.toBe(subdir);
  });
});

describe('WorkspaceCheckpointManager — first-snapshot size guard', () => {
  test('refuses a first snapshot whose sweep exceeds the file-count ceiling, stating count and override', async () => {
    const root = tempWorkspace('wcp-bigfirst-');
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, `f${i}.txt`), `file ${i}\n`);
    }
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root, maxFirstSnapshotFiles: 3 });

    let message = '';
    try {
      await manager.create({ kind: 'manual', label: 'too-big' });
      throw new Error('expected create() to throw for an oversized first snapshot');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain('5 files');
    expect(message).toContain('limit 3');
    expect(message).toContain('allowLargeFirstSnapshot');
  });

  test('allowLargeFirstSnapshot override permits the oversized first sweep', async () => {
    const root = tempWorkspace('wcp-bigfirst-ok-');
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, `f${i}.txt`), `file ${i}\n`);
    }
    const manager = new WorkspaceCheckpointManager({
      workspaceRoot: root,
      maxFirstSnapshotFiles: 3,
      allowLargeFirstSnapshot: true,
    });

    const cp = await manager.create({ kind: 'manual', label: 'allowed-big' });
    expect(cp).not.toBeNull();
  });
});

describe('WorkspaceCheckpointManager — automatic retention wiring', () => {
  test('gc() runs automatically after a create() crosses the retention threshold', async () => {
    const root = tempWorkspace('wcp-autoretain-');
    const manager = new WorkspaceCheckpointManager({
      workspaceRoot: root,
      retention: { standard: { maxAgeMs: 24 * 60 * 60 * 1000, maxCount: 2, maxSizeBytes: 200 * 1024 * 1024 } },
    });

    // Wrap gc() to observe the automatic invocation while keeping real behavior.
    const realGc = manager.gc.bind(manager);
    let gcCalls = 0;
    (manager as unknown as { gc: () => Promise<unknown> }).gc = () => {
      gcCalls += 1;
      return realGc();
    };

    for (let i = 0; i < 3; i++) {
      writeFileSync(join(root, 'f.txt'), `content ${i}\n`);
      const cp = await manager.create({ kind: 'turn', label: `turn ${i}`, retentionClass: 'standard' });
      expect(cp).not.toBeNull();
    }

    // The third create pushed the standard class over maxCount=2, so the
    // automatic (non-blocking) retention sweep must have fired gc().
    expect(gcCalls).toBeGreaterThan(0);

    // Force any in-flight sweep to settle, then confirm the store was trimmed.
    await manager.gc();
    const remaining = await manager.list();
    expect(remaining.length).toBeLessThanOrEqual(2);
  });

  test('autoRetention:false leaves pruning entirely to manual gc()', async () => {
    const root = tempWorkspace('wcp-noauto-');
    const manager = new WorkspaceCheckpointManager({
      workspaceRoot: root,
      autoRetention: false,
      retention: { standard: { maxAgeMs: 24 * 60 * 60 * 1000, maxCount: 1, maxSizeBytes: 200 * 1024 * 1024 } },
    });

    const realGc = manager.gc.bind(manager);
    let gcCalls = 0;
    (manager as unknown as { gc: () => Promise<unknown> }).gc = () => {
      gcCalls += 1;
      return realGc();
    };

    for (let i = 0; i < 3; i++) {
      writeFileSync(join(root, 'f.txt'), `content ${i}\n`);
      await manager.create({ kind: 'turn', label: `turn ${i}`, retentionClass: 'standard' });
    }

    // No automatic sweep fired — the store is over-limit but untouched until manual gc().
    expect(gcCalls).toBe(0);
    const before = await manager.list();
    expect(before.length).toBe(3);
    await manager.gc();
    const after = await manager.list();
    expect(after.length).toBe(1);
  });
});
