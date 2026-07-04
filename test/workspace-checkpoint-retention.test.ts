import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceCheckpointManager } from '../packages/sdk/src/platform/workspace/checkpoint/manager.js';
import { CHECKPOINT_REF_PREFIX } from '../packages/sdk/src/platform/workspace/checkpoint/side-git.js';

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

describe('WorkspaceCheckpointManager retention/gc', () => {
  test('gc() prunes oldest standard checkpoints past maxCount, deletes their refs, and shrinks the object store', async () => {
    const root = tempWorkspace('wcp-retention-');
    const manager = new WorkspaceCheckpointManager({
      workspaceRoot: root,
      retention: { standard: { maxAgeMs: 24 * 60 * 60 * 1000, maxCount: 3, maxSizeBytes: 200 * 1024 * 1024 } },
    });

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, 'f.txt'), `revision ${i}\n`);
      const cp = await manager.create({ kind: 'turn', label: `turn ${i}`, retentionClass: 'standard' });
      expect(cp).not.toBeNull();
      ids.push(cp!.id);
    }

    const result = await manager.gc();
    expect(result.deletedCount).toBe(2);
    expect(new Set(result.deletedIds)).toEqual(new Set([ids[0], ids[1]]));

    const remaining = await manager.list();
    expect(remaining.map((c) => c.id).sort()).toEqual([ids[2], ids[3], ids[4]].sort());

    const gitDir = join(root, '.goodvibes', 'checkpoints', 'git');
    for (const prunedId of [ids[0], ids[1]]) {
      expect(() => runGit(root, ['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', `${CHECKPOINT_REF_PREFIX}${prunedId}`])).toThrow();
    }
    for (const survivingId of [ids[2], ids[3], ids[4]]) {
      expect(() => runGit(root, ['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', `${CHECKPOINT_REF_PREFIX}${survivingId}`])).not.toThrow();
    }
  });

  test('a forensic manual pin survives gc() even when many standard checkpoints are pruned', async () => {
    const root = tempWorkspace('wcp-forensic-');
    const manager = new WorkspaceCheckpointManager({
      workspaceRoot: root,
      retention: { standard: { maxAgeMs: 24 * 60 * 60 * 1000, maxCount: 2, maxSizeBytes: 200 * 1024 * 1024 } },
    });

    writeFileSync(join(root, 'f.txt'), 'pin\n');
    const pin = await manager.create({ kind: 'manual', label: 'important pin', retentionClass: 'forensic' });
    expect(pin).not.toBeNull();

    for (let i = 0; i < 4; i++) {
      writeFileSync(join(root, 'f.txt'), `turn ${i}\n`);
      await manager.create({ kind: 'turn', label: `turn ${i}`, retentionClass: 'standard' });
    }

    await manager.gc();

    const remaining = await manager.list();
    expect(remaining.some((c) => c.id === pin!.id)).toBe(true);
  });

  test('gc() only touches refs under refs/goodvibes/checkpoints/ — an unrelated ref namespace (standing in for compaction) is untouched', async () => {
    const root = tempWorkspace('wcp-namespace-');
    const manager = new WorkspaceCheckpointManager({
      workspaceRoot: root,
      retention: { standard: { maxAgeMs: 24 * 60 * 60 * 1000, maxCount: 1, maxSizeBytes: 200 * 1024 * 1024 } },
    });

    writeFileSync(join(root, 'f.txt'), 'v1\n');
    await manager.create({ kind: 'turn', label: 'turn 0', retentionClass: 'standard' });
    writeFileSync(join(root, 'f.txt'), 'v2\n');
    await manager.create({ kind: 'turn', label: 'turn 1', retentionClass: 'standard' });

    const gitDir = join(root, '.goodvibes', 'checkpoints', 'git');
    // Simulate an unrelated subsystem (e.g. a future compaction integration)
    // using the same side repo's object store under its own ref namespace.
    const refs = runGit(root, ['--git-dir', gitDir, 'for-each-ref', '--format=%(objectname)', CHECKPOINT_REF_PREFIX])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect(refs.length).toBeGreaterThan(0);
    runGit(root, ['--git-dir', gitDir, 'update-ref', 'refs/goodvibes/compaction/cpt_fake', refs[0]!]);

    await manager.gc();

    expect(() => runGit(root, ['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', 'refs/goodvibes/compaction/cpt_fake'])).not.toThrow();
  });
});
