/**
 * Multi-session orchestration — barrel exports.
 */

export type {
  CrossSessionTaskRef,
  TaskDependencyEdge,
  TaskHandoffRecord,
  CancellationScope,
  CancellationRequest,
  CancellationResult,
  SessionTaskGraphSnapshot,
} from './types.js';

export { makeRefKey, VALID_SCOPES } from './types.js';
export { SessionTaskGraph } from './graph.js';
export { CrossSessionTaskRegistry } from './registry.js';
