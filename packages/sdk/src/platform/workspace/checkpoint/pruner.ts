/**
 * pruner.ts
 *
 * `WorkspaceCheckpointPruner` — the `Pruner` implementation `RetentionPolicy`
 * drives to enforce retention limits on workspace checkpoints. Split out of
 * manager.ts (which was at the 800-line cap) as a self-contained collaborator;
 * see manager.ts's `gc()` for how it is wired and why reclamation only works on
 * parentless checkpoint commits.
 */

import { summarizeError } from '../../utils/error-display.js';
import {
  type RetentionClass,
  type CheckpointRecord,
  type Pruner,
  type PruneResult,
  type PruneOptions,
} from '../../runtime/retention/index.js';
import { SideGitRunner, CHECKPOINT_REF_PREFIX } from './side-git.js';

/**
 * `Pruner` implementation for `RetentionPolicy` that deletes checkpoint REFS
 * (not filesystem paths — that is what `SnapshotPruner`, the compaction-side
 * pruner, does, and reusing it here would be a no-op at best since our
 * "artifacts" are refs+objects, not files). Actual object reclamation is a
 * single `git gc --prune=now` run once by `WorkspaceCheckpointManager.gc()`
 * after refs are deleted, not per-record here.
 */
export class WorkspaceCheckpointPruner implements Pruner {
  constructor(
    private readonly sideGit: SideGitRunner,
    private readonly onDeleted: (id: string) => void,
  ) {}

  async delete(candidates: readonly CheckpointRecord[], options?: PruneOptions): Promise<PruneResult> {
    const dryRun = options?.dryRun ?? false;
    const deletedIds: string[] = [];
    const failedIds: string[] = [];
    const errors: Record<string, string> = {};
    let reclaimedBytes = 0;
    const byClass: Record<RetentionClass, { deletedCount: number; reclaimedBytes: number; deletedIds: string[]; candidateIds: string[]; failedIds: string[] }> = {
      short: { deletedCount: 0, reclaimedBytes: 0, deletedIds: [], candidateIds: [], failedIds: [] },
      standard: { deletedCount: 0, reclaimedBytes: 0, deletedIds: [], candidateIds: [], failedIds: [] },
      forensic: { deletedCount: 0, reclaimedBytes: 0, deletedIds: [], candidateIds: [], failedIds: [] },
    };
    for (const record of candidates) {
      byClass[record.retentionClass].candidateIds.push(record.id);
    }
    if (dryRun) {
      return {
        deletedCount: 0,
        reclaimedBytes: 0,
        deletedIds: [],
        candidateIds: candidates.map((c) => c.id),
        failedIds: [],
        errors: {},
        dryRun: true,
        byClass,
      };
    }
    for (const record of candidates) {
      try {
        await this.sideGit.deleteRef(`${CHECKPOINT_REF_PREFIX}${record.id}`);
        deletedIds.push(record.id);
        reclaimedBytes += record.sizeBytes;
        byClass[record.retentionClass].deletedCount += 1;
        byClass[record.retentionClass].reclaimedBytes += record.sizeBytes;
        byClass[record.retentionClass].deletedIds.push(record.id);
        this.onDeleted(record.id);
      } catch (err) {
        failedIds.push(record.id);
        errors[record.id] = summarizeError(err);
        byClass[record.retentionClass].failedIds.push(record.id);
      }
    }
    return {
      deletedCount: deletedIds.length,
      reclaimedBytes,
      deletedIds,
      candidateIds: [],
      failedIds,
      errors,
      dryRun: false,
      byClass,
    };
  }
}
