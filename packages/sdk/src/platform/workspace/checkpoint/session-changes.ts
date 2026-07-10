/**
 * session-changes.ts
 *
 * Pure computation for `WorkspaceCheckpointManager.sessionChanges` — the
 * aggregate file changes a single session made, joined over its
 * sessionId-stamped checkpoints. Split out of manager.ts (at the 800-line cap)
 * as a self-contained helper; the manager calls it while holding its index
 * lock, so the caller — not this function — is responsible for serialization.
 */

import type { SideGitRunner } from './side-git.js';
import { EMPTY_TREE_HASH } from './side-git.js';
import type { WorkspaceCheckpoint, CheckpointSessionChanges } from './types.js';

/**
 * Compute a session's aggregate change: the net diff from the state BEFORE the
 * session's earliest checkpoint (that checkpoint's parent, or the empty tree
 * when the session opened the store) to the session's LATEST checkpoint. A
 * session with no stamped checkpoints yields `checkpointCount: 0` with an empty
 * diff (from/to === 'EMPTY') — an honest "nothing recorded", never an error.
 */
export async function computeSessionChanges(
  checkpoints: ReadonlyMap<string, WorkspaceCheckpoint>,
  sideGit: SideGitRunner,
  sessionId: string,
): Promise<CheckpointSessionChanges> {
  // Oldest-first, so [0] is the session's first change and [last] its latest.
  const sessionCheckpoints = Array.from(checkpoints.values())
    .filter((c) => c.sessionId === sessionId)
    .sort((a, b) => a.createdAt - b.createdAt);

  if (sessionCheckpoints.length === 0) {
    return { sessionId, checkpointCount: 0, checkpointIds: [], from: 'EMPTY', to: 'EMPTY', files: [], unifiedDiff: '', stat: '' };
  }

  const earliest = sessionCheckpoints[0]!;
  const latest = sessionCheckpoints[sessionCheckpoints.length - 1]!;
  // The state before the session's first change is that checkpoint's parent;
  // when the session took the very first checkpoint ever, the base is the empty
  // tree so the aggregate includes everything the session introduced.
  const parent = earliest.parentId ? checkpoints.get(earliest.parentId) : undefined;
  const baseCommit = parent ? parent.commit : EMPTY_TREE_HASH;
  const fromLabel = parent ? parent.id : 'EMPTY';

  const [unifiedDiff, stat_, files] = await Promise.all([
    sideGit.diff(baseCommit, latest.commit),
    sideGit.diffStat(baseCommit, latest.commit),
    sideGit.diffNameOnly(baseCommit, latest.commit),
  ]);

  return {
    sessionId,
    checkpointCount: sessionCheckpoints.length,
    checkpointIds: sessionCheckpoints.map((c) => c.id),
    from: fromLabel,
    to: latest.id,
    files,
    unifiedDiff,
    stat: stat_,
  };
}
