/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

// ── Orchestration engine (see CHANGELOG 0.38.0) ─────────────────────────────
// Curated named-export barrel (no `export *`), mirroring runtime/fleet/
// index.ts's allowlist convention. TUI import path:
// '@pellux/goodvibes-sdk/platform/orchestration'.
export type {
  BudgetCeiling,
  CommitExclusion,
  GateOutcome,
  ItemMergeState,
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
  WorkstreamIsolation,
  WorkstreamProvenance,
  WorkstreamSnapshot,
  AttemptCandidate,
  AttemptCandidateDiff,
  AttemptJudge,
  AttemptJudgeCandidate,
  AttemptJudgeInput,
  AttemptJudgeVerdict,
  AttemptJudgment,
  AttemptPickResult,
  HeldMergeGroup,
} from './types.js';
export { CURRENT_WORKSTREAM_SCHEMA_VERSION, MAX_ATTEMPTS, emptyWorkItemUsage } from './types.js';

export type { AttemptsCoordinator, AttemptsCoordinatorDeps } from './attempts.js';
export { AttemptError, createAttemptsCoordinator } from './attempts.js';
export type { ProviderBackedAttemptJudgeOptions } from './judge.js';
export { createProviderBackedAttemptJudge, parseAttemptVerdict } from './judge.js';

export type { CreateWorkstreamInput, OrchestrationEngine, OrchestrationEngineDeps } from './engine.js';
export { createOrchestrationEngine } from './engine.js';

// The 1.4.3 fix-phase rework: review findings as a second task source, the
// dynamic-graph muscles, the elastic pool, and the planned-fix runner.
export { parseReviewIntoTasks, planTaskGraph, planFixWorkstream, clusterOf, ELASTIC_PHASE_CAPACITY } from './review-task-source.js';
export type { ReviewTask, ReviewTaskSource, SemanticEdgePlanner } from './review-task-source.js';
export { createFixWorkstreamRunner } from './fix-workstream-runner.js';
export type { FixWorkstreamRunner, FixWorkstreamOutcome, FixWorkstreamRunnerDeps } from './fix-workstream-runner.js';
export { addDependencyEdge, addConflictSerializationEdges, buildGraphSnapshot, detectOrphans, remainingDepths, wouldCreateCycle } from './graph-dynamics.js';
export type { EdgeAddResult, WorkstreamGraphSnapshot, GraphNodeSnapshot, GraphEdgeSnapshot, PoolStateSnapshot } from './graph-dynamics.js';
export { gateClaimAgainstFleet, isElastic, poolState, retirementEvent } from './elastic-pool.js';
export type { FleetCapacityProbe, FleetCapacityFn } from './elastic-pool.js';

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

export { engineerReviewPhases, fromChainSpec } from './controller-compat.js';

export { fromPlanProposal, approveAndLaunchProposal } from './proposal-workstream.js';
export type { FromPlanProposalOptions } from './proposal-workstream.js';

export type { PhaseRunnerAgentManagerLike, PhaseRunnerDeps, PhaseRunOutcome, WrfcWorktreeOps } from './phase-runner.js';
export { runPhase } from './phase-runner.js';

export type { DirtyLaunchSnapshot, ScopedCommitExclusion } from './dirty-guard.js';
export { excludeUntouchedLaunchResidue, hashWorkingTreeFile, snapshotDirtyTree } from './dirty-guard.js';

export {
  computeClaims,
  dependencyStatus,
  firstPhase,
  nextPhaseAfter,
  phaseById,
  reviewPhaseBefore,
  sortedPhases,
} from './scheduler.js';
export type { DependencyStatus, PhaseClaim } from './scheduler.js';
