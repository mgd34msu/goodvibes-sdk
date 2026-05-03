/**
 * strategies/index.ts
 *
 * Barrel re-export for all compaction strategy modules.
 */

export { runMicrocompact } from './microcompact.js';
export { runCollapse } from './collapse.js';
export { runAutocompact } from './autocompact.js';
export { runReactive } from './reactive.js';
export { createBoundaryCommit, validateBoundaryCommit } from './boundary-commit.js';
export type { BoundaryCommitOptions } from './boundary-commit.js';
export {
  computeQualityScore,
  describeScore,
  escalateStrategy,
  LOW_QUALITY_THRESHOLD,
} from '../quality-score.js';
export type {
  CompactionQualityScore,
  CompactionQualityGrade,
  SemanticRetentionSignals,
} from '../quality-score.js';
