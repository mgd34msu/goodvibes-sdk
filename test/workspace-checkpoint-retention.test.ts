import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
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

/** Sum of `git count-objects -v`'s loose (`size`) and packed (`size-pack`) fields, in bytes (git reports both in KiB). */
function objectStoreBytes(root: string, gitDir: string): number {
  const out = runGit(root, ['--git-dir', gitDir, 'count-objects', '-v']);
  let totalKib = 0;
  for (const line of out.split('\n')) {
    const match = line.match(/^(size|size-pack):\s*(\d+)/);
    if (match) totalKib += Number(match[2]);
  }
  return totalKib * 1024;
}

describe('WorkspaceCheckpointManager retention/gc', () => {
  test('gc() prunes oldest standard checkpoints past maxCount, deletes their refs, and the pruned commits become genuinely unreachable (real byte reclaim, not just a dangling ref)', async () => {
    const root = tempWorkspace('wcp-retention-');
    const manager = new WorkspaceCheckpointManager({
      workspaceRoot: root,
      // Drive gc() manually here so this test isolates the pruning mechanics;
      // the automatic post-create sweep is covered by its own test.
      autoRetention: false,
      retention: { standard: { maxAgeMs: 24 * 60 * 60 * 1000, maxCount: 3, maxSizeBytes: 200 * 1024 * 1024 } },
    });

    const ids: string[] = [];
    const commits: string[] = [];
    for (let i = 0; i < 5; i++) {
      // Distinct, large-ish (~100KB) content per checkpoint: large enough
      // that a real object-store size delta is measurable (not rounding
      // noise), and distinct so checkpoints never dedupe to the same tree.
      writeFileSync(join(root, 'f.txt'), randomBytes(100_000).toString('hex'));
      const cp = await manager.create({ kind: 'turn', label: `turn ${i}`, retentionClass: 'standard' });
      expect(cp).not.toBeNull();
      ids.push(cp!.id);
      commits.push(cp!.commit);
    }

    const gitDir = join(root, '.goodvibes', 'checkpoints', 'git');
    const beforeBytes = objectStoreBytes(root, gitDir);

    const result = await manager.gc();
    expect(result.deletedCount).toBe(2);
    expect(new Set(result.deletedIds)).toEqual(new Set([ids[0], ids[1]]));

    const remaining = await manager.list();
    expect(remaining.map((c) => c.id).sort()).toEqual([ids[2], ids[3], ids[4]].sort());

    for (const prunedId of [ids[0], ids[1]]) {
      expect(() => runGit(root, ['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', `${CHECKPOINT_REF_PREFIX}${prunedId}`])).toThrow();
    }
    for (const survivingId of [ids[2], ids[3], ids[4]]) {
      expect(() => runGit(root, ['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', `${CHECKPOINT_REF_PREFIX}${survivingId}`])).not.toThrow();
    }

    // The core claim: pruned checkpoints' commits are not merely ref-less —
    // they are unreachable from every surviving ref (checkpoint commits are
    // parentless, so no surviving descendant's parent chain keeps them
    // alive) and `git gc --prune=now` has actually deleted the objects.
    for (const prunedCommit of [commits[0]!, commits[1]!]) {
      expect(() => runGit(root, ['--git-dir', gitDir, 'cat-file', '-e', prunedCommit])).toThrow();
    }
    for (const survivingCommit of [commits[2]!, commits[3]!, commits[4]!]) {
      expect(() => runGit(root, ['--git-dir', gitDir, 'cat-file', '-e', survivingCommit])).not.toThrow();
    }

    // And the object store itself is measurably smaller, not just missing refs.
    const afterBytes = objectStoreBytes(root, gitDir);
    expect(afterBytes).toBeLessThan(beforeBytes);
  });

  test('a forensic manual pin survives gc() even when many standard checkpoints are pruned', async () => {
    const root = tempWorkspace('wcp-forensic-');
    const manager = new WorkspaceCheckpointManager({
      workspaceRoot: root,
      autoRetention: false,
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
      autoRetention: false,
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
