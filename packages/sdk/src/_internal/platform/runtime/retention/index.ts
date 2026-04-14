/**
 * retention/index.ts
 *
 * Public barrel for the snapshot retention and pruning policy subsystem.
 *
 * Consumers should import from this barrel rather than from individual modules
 * to remain insulated from internal refactors.
 *
 * @example
 * ```ts
 * import { RetentionPolicy, SnapshotPruner } from '../retention/index.js';
 * import type { RetentionClass, CheckpointRecord, PruneResult } from '../retention/index.js';
 * ```
 */

export { RetentionPolicy, DEFAULT_RETENTION_CONFIG } from './policy.js';
export { SnapshotPruner } from './pruner.js';
export type {
  RetentionClass,
  RetentionClassConfig,
  RetentionConfig,
  CheckpointRecord,
  PruneOptions,
  PruneResult,
  PerClassPruneResult,
  Pruner,
  RetentionStats,
} from './types.js';
