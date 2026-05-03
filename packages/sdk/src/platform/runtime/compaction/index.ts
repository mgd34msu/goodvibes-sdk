/**
 * src/runtime/compaction/index.ts
 *
 * Barrel re-export for the session compaction lifecycle engine.
 *
 * Main entry point: `createCompactionManager()`
 *
 * Usage:
 * ```ts
 * import { createCompactionManager } from '../runtime/compaction/index.js';
 *
 * const manager = createCompactionManager({ sessionId, bus, flags, contextWindow });
 * const result = await manager.compact({ messages, tokenCount, trigger: 'auto' });
 * ```
 */

import { CompactionManager } from './manager.js';
import type { CompactionManagerOptions } from './manager.js';

export { CompactionManager };
export type { CompactionManagerOptions };

export type {
  CompactionLifecycleState,
  CompactionStrategy,
  CompactionTrigger,
  StrategyInput,
  StrategyOutput,
  BoundaryCommit,
  CompactionLifecycleResult,
  RepairAction,
  RepairSeverity,
  ResumeRepairResult,
} from './types.js';

export type { BoundaryCommitOptions } from './strategies/boundary-commit.js';

export {
  canTransition,
  reachableFrom,
  applyTransition,
  isTerminal,
  isCompacting,
  selectStrategy,
  strategyToState,
} from './lifecycle.js';

export type { TransitionResult, StrategySelectionParams } from './lifecycle.js';

export { runResumeRepair } from './resume-repair.js';
export type { ResumeRepairOptions } from './resume-repair.js';

export {
  runMicrocompact,
  runCollapse,
  runAutocompact,
  runReactive,
  createBoundaryCommit,
  validateBoundaryCommit,
  computeQualityScore,
  describeScore,
  escalateStrategy,
  LOW_QUALITY_THRESHOLD,
} from './strategies/index.js';

export type {
  CompactionQualityScore,
  CompactionQualityGrade,
  SemanticRetentionSignals,
} from './strategies/index.js';

/**
 * Factory function for creating a CompactionManager instance.
 *
 * Convenience wrapper over `new CompactionManager(opts)` for symmetry
 * with other runtime subsystem factories.
 *
 * NOTE: This factory is not yet wired to a consumer in the bootstrap layer.
 * Integration with the session bootstrap pipeline is the next step — the
 * CompactionManager will be instantiated per-session during session init
 * and attached to the session context for lifecycle event routing.
 *
 * @param opts - Manager options (see CompactionManagerOptions).
 * @returns A new CompactionManager instance.
 */
export function createCompactionManager(
  opts: CompactionManagerOptions,
): CompactionManager {
  return new CompactionManager(opts);
}
