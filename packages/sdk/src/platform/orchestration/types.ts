/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Orchestration engine — the model (W4.1, wo701).
 *
 * A phase/work-item pipeline layered OVER (not replacing) WrfcController. The
 * hard departure from WrfcController is pipeline semantics: an item advances
 * to its next phase the instant its gate passes, claimed by WHATEVER capacity
 * slot is free — there is no pairwise binding of one reviewer to one
 * engineer's history (see wrfc-controller.ts startReview:883/startFix:1042,
 * which bind chain.reviewerAgentId/chain.fixerAgentId to a single chain).
 *
 * Float ordinals on Phase are load-bearing: inserting a phase mid-run assigns
 * an ordinal strictly between its neighbors, so existing phase ids — and
 * therefore existing PhaseResult resume-cache keys (itemId,phaseId) — never
 * shift or invalidate.
 */

import type { WrfcAgentRole, QualityGateResult } from '../agents/wrfc-types.js';
import type { WrfcCommitScope } from '../agents/wrfc-config.js';
import type { CompletionReport, ConstraintFinding } from '../agents/completion-report.js';

/** A named agent role, OR an archetype name loaded via ArchetypeLoader. */
export type PhaseRole = WrfcAgentRole | (string & {});

export type PhaseKind = 'plan' | 'engineer' | 'review' | 'fix' | 'gate' | 'integrate' | 'custom';

/** The gate policy a phase enforces before an item may advance past it. */
export interface PhaseGateSpec {
  readonly scope: WrfcCommitScope;
  readonly gates: readonly string[];
}

/**
 * One pipeline stage. `ordinal` is a float specifically so
 * `engine.insertPhase()` can slot a new phase strictly between two existing
 * ordinals without renumbering anything — renumbering would invalidate every
 * PhaseResult cache key already keyed off the old (itemId,phaseId) pairs.
 */
export interface Phase {
  readonly id: string;
  readonly ordinal: number;
  readonly role: PhaseRole;
  readonly capacity: number;
  readonly gate: PhaseGateSpec;
  readonly kind: PhaseKind;
  /** Epoch ms — set only for phases created via insertPhase() mid-run. */
  readonly insertedAt?: number | undefined;
}

/** Caller-supplied shape for engine.insertPhase() / seeding. `id` is generated when omitted. */
export interface PhaseSpec {
  readonly id?: string | undefined;
  readonly role: PhaseRole;
  readonly capacity: number;
  readonly gate: PhaseGateSpec;
  readonly kind: PhaseKind;
}

export type WorkItemState =
  | 'pending'
  | 'awaiting-capacity'
  /**
   * Live only while a phase's agent is actually running. `importWorkstream`
   * (engine.ts) reconciles any item persisted in this state back to
   * 'pending' and clears `agentId` before the workstream is registered — a
   * snapshot can only ever capture 'in-phase' as a crash artifact (the
   * process died mid-run), never a resumable one, since no agent from a
   * prior process is still alive to finish it. Without that reconciliation
   * an imported 'in-phase' item counts as an OCCUPIED capacity slot forever
   * (computeClaims, scheduler.ts) while never being in the re-claimable
   * waiting set, permanently starving its workstream.
   */
  | 'in-phase'
  | 'passed'
  | 'failed'
  /**
   * Recoverable, not terminal. computeClaims (scheduler.ts) includes
   * 'blocked-budget' items in its waiting set, so the item is automatically
   * reconsidered on the next tick(). Because usage only grows, in practice
   * that next tick only unblocks the item once the ceiling itself rises (or
   * is removed) via `engine.updateBudget()` — which calls tick() after
   * updating `workstream.budget` so the reconsideration happens immediately
   * rather than waiting on some unrelated sibling to complete. `blockedReason`
   * carries the human-readable reason for as long as the item stays blocked
   * (cleared the moment it reclaims a slot).
   */
  | 'blocked-budget';

/** Token/cost usage rolled up across every agent this work-item has ever spawned. */
export interface WorkItemUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens?: number | undefined;
  readonly llmCallCount: number;
  readonly turnCount: number;
  readonly toolCallCount: number;
  readonly costUsd: number | null;
  readonly costState: 'priced' | 'unpriced' | 'estimated';
}

export function emptyWorkItemUsage(): WorkItemUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    llmCallCount: 0,
    turnCount: 0,
    toolCallCount: 0,
    costUsd: null,
    costState: 'unpriced',
  };
}

/**
 * One unit of pipeline work. `visits` bounds re-review cycles the same way
 * WrfcController.retryTransportFailure/evaluateConstraints cap fix attempts —
 * keyed by phaseId so a dynamically-inserted 'fix' phase gets its own counter.
 */
export interface WorkItem {
  readonly id: string;
  title: string;
  readonly task: string;
  /** The phase this item is currently queued for or running in; null once terminal. */
  currentPhaseId: string | null;
  state: WorkItemState;
  branch?: string | undefined;
  /** The agent currently (or most recently) driving this item's active phase. */
  agentId?: string | undefined;
  /** Every agent ever spawned for this item, across all phases/retries — usage rollup roster. */
  allAgentIds: string[];
  /** phaseId -> number of times this item has been routed through that phase. */
  readonly visits: Map<string, number>;
  /** Deduped touched-path ledger for scoped commits, mirrors WrfcChain.touchedPaths. */
  touchedPaths: string[];
  usage: WorkItemUsage;
  /** Separate from `visits` — a transport blip must never eat into the fix-cycle budget. */
  transportRetryCount: number;
  readonly createdAt: number;
  completedAt?: number | undefined;
  failureReason?: string | undefined;
  /** Set only while state === 'blocked-budget'; cleared the instant the item reclaims a slot. See the 'blocked-budget' state doc for recovery semantics. */
  blockedReason?: string | undefined;
}

export interface WorkItemSpec {
  readonly id?: string | undefined;
  readonly title: string;
  readonly task: string;
}

export interface BudgetCeiling {
  readonly maxTokens?: number | undefined;
  readonly maxCostUsd?: number | undefined;
}

export interface Workstream {
  readonly id: string;
  title: string;
  readonly schemaVersion: number;
  phases: Phase[];
  items: WorkItem[];
  /**
   * Mutable (not readonly) specifically so `engine.updateBudget()` can raise,
   * lower, or clear (`undefined`) the ceiling on a live workstream. Every
   * update calls tick() immediately afterward, so any item already sitting
   * in 'blocked-budget' gets reconsidered right away rather than waiting on
   * an unrelated sibling to complete first.
   */
  budget?: BudgetCeiling | undefined;
  readonly createdAt: number;
}

/** Outcome of running a phase's configured gates for one item. */
export interface GateOutcome {
  readonly passed: boolean;
  readonly results: readonly QualityGateResult[];
  readonly constraintFindings?: readonly ConstraintFinding[] | undefined;
  readonly unsatisfiedConstraintIds?: readonly string[] | undefined;
}

/**
 * The resume-cache unit, keyed (itemId,phaseId). On resume, every
 * (itemId,phaseId) present in a snapshot's completedResults is hydrated
 * without re-spawning — this is what makes prefix-replay possible.
 */
export interface PhaseResult {
  readonly itemId: string;
  readonly phaseId: string;
  readonly agentId: string;
  readonly report: CompletionReport;
  readonly gate: GateOutcome;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly usage: WorkItemUsage;
}

/** Snapshot shape written to .goodvibes/orchestration/<workstreamId>.json. */
export interface WorkstreamSnapshot {
  readonly schemaVersion: number;
  readonly writtenAt: number;
  readonly workstream: SerializedWorkstream;
  readonly completedResults: readonly PhaseResult[];
}

/** JSON-safe mirror of Workstream (WorkItem.visits as an object, not a Map). */
export interface SerializedWorkstream extends Omit<Workstream, 'items'> {
  readonly items: readonly SerializedWorkItem[];
}

export interface SerializedWorkItem extends Omit<WorkItem, 'visits'> {
  readonly visits: Record<string, number>;
}

export const CURRENT_WORKSTREAM_SCHEMA_VERSION = 1;

/** Discriminated events the engine emits over its own lifecycle (persistence, budget, fleet). */
export type OrchestrationEvent =
  | { readonly type: 'phase-inserted'; readonly workstreamId: string; readonly phase: Phase }
  | { readonly type: 'item-advanced'; readonly workstreamId: string; readonly itemId: string; readonly fromPhaseId: string | null; readonly toPhaseId: string | null }
  | { readonly type: 'item-blocked-budget'; readonly workstreamId: string; readonly itemId: string; readonly phaseId: string; readonly reason: string }
  | { readonly type: 'item-cancelled'; readonly workstreamId: string; readonly itemId: string; readonly reason: string }
  | { readonly type: 'item-passed'; readonly workstreamId: string; readonly itemId: string }
  | { readonly type: 'item-failed'; readonly workstreamId: string; readonly itemId: string; readonly reason: string }
  /** Emitted once per item on `importWorkstream` for every item reconciled from a crash-artifact 'in-phase' snapshot back to 'pending' — see the 'in-phase' state doc. */
  | { readonly type: 'item-requeued'; readonly workstreamId: string; readonly itemId: string; readonly reason: string }
  | { readonly type: 'workstream-persisted'; readonly workstreamId: string };

export type OrchestrationEventListener = (event: OrchestrationEvent) => void;
