export * from './daemon-home.js';
export * from './workspace-swap-manager.js';
export * from './registration/index.js';
export {
  WorkspaceCheckpointManager,
  type CreateCheckpointOptions,
  type RestoreOptions,
  type ListCheckpointsFilter,
  type WorkspaceCheckpointManagerOptions,
  type WorkspaceCheckpoint,
  type CheckpointKind,
  type CheckpointDiff,
  type RestoreResult,
  // Promoted from the checkpoint engine's deep (non-public) subpath: both the
  // TUI and the agent needed the resolver's exact shape to type a locally
  // structurally-mirrored callback (`resolveSessionId`) because only this
  // top-level `platform/workspace` barrel is a published exports-map entry —
  // `platform/workspace/checkpoint` is not. Publishing the real type here lets
  // a consumer's resolver be checked against the manager's actual option
  // instead of a hand-copied structural twin that can silently drift.
  type CheckpointSessionResolveContext,
  type CheckpointSessionResolver,
} from './checkpoint/index.js';
