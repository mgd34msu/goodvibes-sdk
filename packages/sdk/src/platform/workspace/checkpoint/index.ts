/**
 * checkpoint/index.ts
 *
 * Public barrel for the workspace checkpoint engine.
 */

export {
  WorkspaceCheckpointManager,
  type CreateCheckpointOptions,
  type RestoreOptions,
  type ListCheckpointsFilter,
  type WorkspaceCheckpointManagerOptions,
  type CheckpointSessionResolveContext,
  type CheckpointSessionResolver,
} from './manager.js';
export type {
  WorkspaceCheckpoint,
  CheckpointKind,
  CheckpointDiff,
  CheckpointSessionChanges,
  RestoreResult,
} from './types.js';
export { SideGitRunner, CHECKPOINT_REF_PREFIX, EMPTY_TREE_HASH } from './side-git.js';
