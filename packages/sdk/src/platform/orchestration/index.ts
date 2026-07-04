/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

// ── Orchestration engine (W4.1, wo701) ──────────────────────────────────────
// Curated named-export barrel (no `export *`), mirroring runtime/fleet/
// index.ts's allowlist convention. TUI import path:
// '@pellux/goodvibes-sdk/platform/orchestration'.
export type {
  BudgetCeiling,
  CommitExclusion,
  GateOutcome,
  OrchestrationEvent,
  OrchestrationEventListener,
  Phase,
  PhaseGateSpec,
  PhaseKind,
  PhaseResult,
  PhaseRole,
  PhaseSpec,
  SerializedWorkItem,
  SerializedWorkstream,
  WorkItem,
  WorkItemSpec,
  WorkItemState,
  WorkItemUsage,
  Workstream,
  WorkstreamSnapshot,
} from './types.js';
export { CURRENT_WORKSTREAM_SCHEMA_VERSION, emptyWorkItemUsage } from './types.js';

export type { CreateWorkstreamInput, OrchestrationEngine, OrchestrationEngineDeps } from './engine.js';
export { createOrchestrationEngine } from './engine.js';

export type { CancellationRegistry } from './cancellation.js';
export { createCancellationRegistry } from './cancellation.js';

export type { BudgetCheck } from './budget.js';
export { checkBudget } from './budget.js';

export {
  deserializeWorkstream,
  deserializeWorkstreamSnapshot,
  listSnapshotWorkstreamIds,
  loadWorkstreamSnapshot,
  serializeWorkstream,
  serializeWorkstreamSnapshot,
  writeWorkstreamSnapshot,
} from './persistence.js';

export { fromChainSpec } from './controller-compat.js';

export type { PhaseRunnerAgentManagerLike, PhaseRunnerDeps, PhaseRunOutcome, WrfcWorktreeOps } from './phase-runner.js';
export { runPhase } from './phase-runner.js';

export type { DirtyLaunchSnapshot, ScopedCommitExclusion } from './dirty-guard.js';
export { excludeUntouchedLaunchResidue, hashWorkingTreeFile, snapshotDirtyTree } from './dirty-guard.js';

export {
  computeClaims,
  firstPhase,
  nextPhaseAfter,
  phaseById,
  reviewPhaseBefore,
  sortedPhases,
} from './scheduler.js';
export type { PhaseClaim } from './scheduler.js';
