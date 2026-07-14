/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Orchestration engine — the model (see CHANGELOG 0.38.0).
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
  | 'blocked-budget'
  /**
   * Recoverable, not terminal — the item cannot be claimed yet because at
   * least one of its `dependsOn` items has not reached 'passed'. This is a
   * REFUSE-not-kill gate (BIG-3 item 2): the item sits here, out of the
   * claimable waiting set (computeClaims excludes it), until the engine's
   * per-tick dependency pre-pass (applyDependencyGates, engine.ts) finds every
   * dependency passed and flips it back to 'pending'. `blockedReason` is
   * recomputed every tick so it stays honest as dependencies change:
   *   - `waiting on: <titles>` while dependencies are still pending/running,
   *   - `dependency failed: <titles>` once a dependency has terminally failed.
   * A FAILED dependency does NOT terminally fail the dependent — it stays here,
   * recoverable: if that dependency is later retried (engine.retryItem) and
   * passes, the next tick clears this block and the item proceeds. Only ever
   * set on an item that has not started yet (no phase has run); once an item's
   * dependencies are all passed at its first claim they stay passed (passed is
   * terminal), so a mid-pipeline item is never re-gated.
   */
  | 'blocked-dependency'
  /**
   * A best-of-N attempt sibling that has PASSED every phase but is parked
   * pending the winner pick (see attempts.ts). Its worktree is KEPT (not merged,
   * not removed) so its diff can be inspected as a candidate; the engine never
   * auto-merges a best-of-N attempt. NON-TERMINAL on purpose — a workstream with
   * a held sibling is not "done" until a winner is picked (fleet.attempts.pick),
   * at which point the winner integrates and the losers are cleaned. Never in the
   * claimable set (computeClaims excludes it), so it is never re-run.
   */
  | 'held-merge';

/**
 * Where a usage rollup's priced dollars came from: 'user' (manual/registration
 * price), 'provider' (provider-served rates), 'catalog' (the dated pricing
 * catalog), or 'mixed' when priced contributors disagree. Absent when nothing
 * was priced — or on records committed before provenance stamping existed
 * (honest absence, never back-filled).
 */
export type WorkItemCostSource = 'user' | 'provider' | 'catalog' | 'mixed';

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
  readonly costSource?: WorkItemCostSource | undefined;
  /** Oldest ISO date (YYYY-MM-DD) among the dated (catalog/provider) pricing snapshots that contributed; absent when none carried a date. */
  readonly pricingAsOf?: string | undefined;
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
 * Combine two usage rollups into one running total. The SINGLE canonical merge
 * used everywhere a WorkItemUsage is accumulated — the phase-runner (folding a
 * completed phase into an item), the engine (same, at the phase boundary), and
 * the fleet rollup adapters (overlaying live in-flight usage onto committed
 * totals). Keeping one implementation is what makes the rollup MONOTONE in
 * presence: every count is summed (counts only grow) and a cost is retained
 * via `??` whenever either operand carries one, so once a real token or cost
 * value has appeared the merged result can never regress to absent/`null`
 * ("updating" is a state, never a data wipe).
 *
 * Cost state stays honest rather than optimistic: 'priced' only when BOTH
 * operands are priced; 'unpriced' only when NEITHER carries a cost; any mix is
 * 'estimated' — a real partial sum, explicitly flagged as incomplete.
 */
export function mergeWorkItemUsage(a: WorkItemUsage, b: WorkItemUsage): WorkItemUsage {
  const sawReasoning = a.reasoningTokens !== undefined || b.reasoningTokens !== undefined;
  const bothPriced = a.costState === 'priced' && b.costState === 'priced';
  const neitherPriced = a.costUsd === null && b.costUsd === null;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: sawReasoning ? (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) : undefined,
    llmCallCount: a.llmCallCount + b.llmCallCount,
    turnCount: a.turnCount + b.turnCount,
    toolCallCount: a.toolCallCount + b.toolCallCount,
    costUsd: a.costUsd !== null && b.costUsd !== null ? a.costUsd + b.costUsd : (a.costUsd ?? b.costUsd),
    costState: bothPriced ? 'priced' : neitherPriced ? 'unpriced' : 'estimated',
    costSource: mergeCostSource(a.costSource, b.costSource),
    pricingAsOf: mergePricingAsOf(a.pricingAsOf, b.pricingAsOf),
  };
}

/** One shared source reports itself; disagreement is 'mixed'; absence never overrides presence. */
export function mergeCostSource(a: WorkItemCostSource | undefined, b: WorkItemCostSource | undefined): WorkItemCostSource | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a === b ? a : 'mixed';
}

/** Oldest date wins: "priced with data at least as fresh as <date>". */
export function mergePricingAsOf(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a < b ? a : b;
}

/**
 * Provenance of one model's resolved price, stamped at the same instant the
 * dollars are computed (same resolver call), never re-derived later. Threaded
 * alongside `priceUsage` wherever usage is priced (the phase-runner, the
 * fleet agent adapter) so every priced value a verb serves can say where its
 * rates came from and, for dated sources, how fresh they are.
 */
export interface PricingProvenance {
  readonly source: 'user' | 'provider' | 'catalog';
  /** ISO date (YYYY-MM-DD) of the catalog/provider pricing snapshot; absent for user prices. */
  readonly asOf?: string | undefined;
}

export type PriceProvenanceFn = (model: string | undefined) => PricingProvenance | null;

/**
 * One unit of pipeline work. `visits` bounds re-review cycles the same way
 * WrfcController.retryTransportFailure/evaluateConstraints cap fix attempts —
 * keyed by phaseId so a dynamically-inserted 'fix' phase gets its own counter.
 */
export interface WorkItem {
  readonly id: string;
  title: string;
  readonly task: string;
  /**
   * IDs of the sibling work items this item depends on (BIG-3 item 2). The
   * item is not claimable until EVERY id here refers to an item that has
   * reached 'passed'; until then it sits in 'blocked-dependency' with an
   * honest `blockedReason`. Empty (the common case) ⇒ no dependency gate, the
   * item is claimable as soon as capacity and budget allow. Populated from a
   * PlanProposal's resolved `dependsOn` by `fromPlanProposal`
   * (proposal-workstream.ts); the assembly asserts these reference real items
   * and form no cycle. JSON-safe (a plain string[]), so it serializes with the
   * work item unchanged.
   */
  dependsOn: string[];
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
  /**
   * Non-fatal bookkeeping notes accrued while the item PASSED its phases — e.g.
   * a scoped commit that could not complete. Warnings NEVER
   * change the item's terminal status (that derives only from phase outcomes
   * plus the explicit negating set, see bookkeeping.ts); they make a
   * passed-with-caveats outcome legible instead of hiding it — or, worse,
   * misreporting a genuinely-passed item as failed.
   */
  warnings?: string[] | undefined;
  /**
   * Absolute path to this item's isolated git worktree (worktree mode only).
   * Set at first claim, cleared once the worktree is removed. Retained on a
   * KEPT worktree (merge conflict, or a dirty tree after fail/kill) so the
   * terminal summary and events can name exactly where the unmerged work lives.
   */
  worktreePath?: string | undefined;
  /** The item's branch name inside its worktree (worktree mode only), e.g. `ws/<wsShort>/<itemShort>`. */
  worktreeBranch?: string | undefined;
  /**
   * Integration state of the item branch relative to the base branch (worktree
   * mode). `'pending'` from the moment the passed item enters the integration
   * lane until its merge resolves; `'merged'` (with {@link mergeHash} set) on a
   * clean merge; `'conflict'` when the lane could not merge it — the worktree is
   * then KEPT and `blockedReason` carries `merge-conflict: <files>`.
   */
  mergeState?: ItemMergeState | undefined;
  /** The merge commit hash recorded on a clean integration (mergeState === 'merged'). */
  mergeHash?: string | undefined;
  /**
   * True when this item's worktree was deliberately KEPT rather than removed —
   * a merge conflict, or a dirty tree left after fail/kill (data safety, rule
   * 4). A kept worktree still lives at {@link worktreePath} for inspection.
   */
  worktreeKept?: boolean | undefined;
  /**
   * The STRUCTURED conflicting-path list recorded when mergeState becomes
   * 'conflict' — the same list the item-merge-conflict event carries, persisted
   * on the item so a resolution session is seeded from data, never from
   * parsing the blockedReason prose.
   */
  conflictFiles?: readonly string[] | undefined;
  /**
   * The real session id of the conflict-resolution session spawned for this
   * item's kept tree (fleet.conflicts.resolve), stamped when the seeded
   * session starts — the same honest real-id stamping the CI fix flow records.
   */
  conflictSessionId?: string | undefined;
  /**
   * Best-of-N grouping (see attempts.ts). Set on every sibling attempt item the
   * engine spawned from ONE work item declared with `attempts: N`. All siblings
   * of the same source item share this id; the fleet surfaces it (ProcessNode.
   * attemptGroup) so an operator sees the siblings as one group. Absent on an
   * ordinary (single-attempt) item.
   */
  attemptGroupId?: string | undefined;
  /** This attempt's index within its group, 0..N-1 (best-of-N only). */
  attemptIndex?: number | undefined;
  /** How many sibling attempts the group has (N), carried for display (best-of-N only). */
  attemptTotal?: number | undefined;
  /**
   * The id of the ORIGINAL spec this attempt was expanded from (best-of-N only).
   * Every sibling of a group shares it. It is what lets a NON-LEAF best-of-N work:
   * a dependent declared `dependsOn: [<sourceId>]` no longer dangles once the
   * source id is rewritten into sibling ids — the dependency gate
   * (scheduler.ts dependencyStatus) resolves the source id back to this group and
   * holds the dependent until the group's winner is picked AND merged. Absent on
   * an ordinary item and on an anonymous (no-id) best-of-N item (which stays a
   * leaf by construction — nothing can depend on it).
   */
  attemptSourceId?: string | undefined;
  /**
   * Set true on the ONE sibling accepted as the group's winner at pick time
   * (best-of-N only). Combined with `mergeState: 'merged'` it marks the winner
   * whose work has landed on the base branch, which is exactly the point a
   * dependent of the group may proceed. Losing siblings never carry it.
   */
  attemptWinner?: boolean | undefined;
  /**
   * When true, a judge proposal (fleet.attempts.judge) for this item's group may
   * auto-pick the proposed winner instead of only PROPOSING it. Opt-in per the
   * source item's spec; default (absent/false) means a human always picks.
   */
  autoAcceptWinner?: boolean | undefined;
  /**
   * Per-item budget ceiling (best-of-N attempts, or any item that opts in). When
   * set, the engine refuses a NEW phase claim for THIS item once its own usage
   * reaches the ceiling — independent of, and in addition to, the workstream
   * ceiling. A budget hint, never a mid-run kill (same semantics as the
   * workstream budget; see budget.ts).
   */
  itemBudget?: BudgetCeiling | undefined;
  /** File-cluster label from the planner pass (warm-adjacency scheduling; review-sourced tasks). */
  cluster?: string | undefined;
  /** The file citations this task carries (parser-derived; shared-file edges + conflict serialization read these). */
  files?: string[] | undefined;
  /** Bounded auto-retry count consumed before the item hard-fails (see engine maxItemRetries). */
  retryCount?: number | undefined;
  /** True once a transitive blocker hard-failed past its retry bound (structured item-orphaned outcome). */
  orphaned?: boolean | undefined;
  /** Epoch ms of the last observed phase activity — the stalled-tell timestamp. */
  lastActivityAt?: number | undefined;
}

export interface WorkItemSpec {
  readonly id?: string | undefined;
  readonly title: string;
  readonly task: string;
  /**
   * IDs of other items in the SAME workstream this item depends on (BIG-3
   * item 2). Omitted/empty ⇒ no dependency gate. Every id must match another
   * item's id in the same CreateWorkstreamInput; `fromPlanProposal` asserts
   * this (and acyclicity) at assembly, and the engine gates the claim path on
   * it (see the 'blocked-dependency' state doc).
   */
  readonly dependsOn?: readonly string[] | undefined;
  /**
   * Best-of-N: run this item as N sibling attempts in isolated worktrees (see
   * attempts.ts), then HOLD the merge and expose the candidates instead of
   * auto-merging. Omitted/1 ⇒ an ordinary single item (unchanged behavior).
   * Values above {@link MAX_ATTEMPTS} are clamped. Only honored when the
   * workstream is `worktree`-isolated — attempts need isolated trees to compare;
   * under `shared` isolation the value is ignored (a single item runs).
   *
   * A best-of-N item may be NON-LEAF. It MAY declare its own `dependsOn` (each
   * sibling inherits it, so every attempt waits for the same upstream items), and
   * other items MAY depend on it: a dependent's `dependsOn: [<thisId>]` is held by
   * the dependency gate until this group's winner is picked and merged, then
   * resolves to that winner (the losing attempts are cleaned, so the dependent
   * builds only on the selected result). The one requirement is that this item
   * carries a stable `id` (a dependency edge references an id); an anonymous
   * best-of-N item stays a leaf by construction because nothing can name it.
   */
  readonly attempts?: number | undefined;
  /** Best-of-N: allow a judge proposal for this item's group to auto-pick the winner (opt-in; default: a human picks). */
  readonly autoAcceptWinner?: boolean | undefined;
  /** Optional per-item budget ceiling (see WorkItem.itemBudget). Falls out naturally for best-of-N attempts; harmless on any item. */
  readonly budget?: BudgetCeiling | undefined;
  /** File-cluster label (planner pass). */
  readonly cluster?: string | undefined;
  /** File citations for shared-file edges + conflict serialization. */
  readonly files?: readonly string[] | undefined;
}

/**
 * When an edge RELEASES its dependent:
 * - 'passed' (default, legacy): the blocker reached 'passed'.
 * - 'reviewed-and-merged': the blocker passed its adversarial slice review AND
 *   its merge landed in the integration lane (worktree mode). Claimed-done —
 *   or even passed-but-unmerged — releases NOTHING.
 */
export type ReleasePolicy = 'passed' | 'reviewed-and-merged';

/** Sensible cap on best-of-N sibling attempts per work item — enough to compare, bounded against runaway fan-out/cost. */
export const MAX_ATTEMPTS = 5;

/**
 * Where a workstream's item phases run their file changes.
 *
 * - `shared` (DEFAULT): every item's phases run their agents in the ONE shared
 *   `projectRoot` working tree and scoped-commit straight onto its branch, as
 *   the engine has always behaved. Two items editing the same file serialize
 *   only by luck of scheduling — full behavioral back-compat, every pre-existing
 *   test passes untouched.
 * - `worktree`: at first claim each item gets its own git worktree branched
 *   from the base branch (see IsolatedWorktree, worktree.ts). Its phases commit
 *   onto the item branch INSIDE that worktree, so concurrent items never touch
 *   each other's working tree. When an item terminates passed its branch is
 *   merged back into the base branch through a single sequential integration
 *   lane (completion order). See the engine's WorktreeIsolationManager.
 */
export type WorkstreamIsolation = 'shared' | 'worktree';

/**
 * The integration state of an item's isolated worktree branch relative to the
 * base branch (worktree mode only; absent/`'n-a'` in shared mode). Distinct
 * from WorkItemState (the pipeline state): an item can be terminally `passed`
 * while its merge is still `pending` in the integration lane, or `conflict`
 * after the lane hit an unmergeable branch.
 */
export type ItemMergeState = 'n-a' | 'pending' | 'merged' | 'conflict';

export interface BudgetCeiling {
  readonly maxTokens?: number | undefined;
  readonly maxCostUsd?: number | undefined;
}

/**
 * Workstream-level provenance (BIG-3 item 1) — honest, machine-readable record
 * of where a workstream's items came from when it was assembled from an
 * approved PlanProposal by `fromPlanProposal` (proposal-workstream.ts). Absent
 * on workstreams built the compat way (`fromChainSpec`) or authored directly.
 * Carried through serialization and surfaced in status/fleet so a resumed or
 * observed workstream reports its origin without guessing.
 */
export interface WorkstreamProvenance {
  /** Whether a read-only planning agent decomposed the goal, or the heuristic single-item path did. Mirrors PlanProposal.decomposedBy. */
  readonly decomposedBy?: 'agent' | 'heuristic' | undefined;
  /** The id of the PlanProposal this workstream was assembled from. */
  readonly proposalId?: string | undefined;
  /** The proposal's execution strategy label (e.g. 'parallel', 'sequential'), for display. */
  readonly strategy?: string | undefined;
  /** Estimated dollar cost of the planning-agent decomposition run, when priced. */
  readonly agentCostUsd?: number | undefined;
  /** Wall-clock time the planning agent ran, in ms (when the agent path ran). */
  readonly elapsedMs?: number | undefined;
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
  /**
   * Where item phases run their file changes (see {@link WorkstreamIsolation}).
   * Absent is treated as `'shared'` everywhere — the default that preserves
   * full behavioral back-compat. Persisted with the workstream and surfaced in
   * events, so a resumed or observed workstream reports its isolation honestly.
   */
  readonly isolation?: WorkstreamIsolation | undefined;
  /**
   * Where this workstream's items came from (BIG-3 item 1). Set only when the
   * workstream was assembled from an approved PlanProposal via
   * `fromPlanProposal`; absent for compat/`fromChainSpec` or hand-authored
   * workstreams. Persisted and surfaced for honest origin reporting.
   */
  readonly provenance?: WorkstreamProvenance | undefined;
  /** Edge-release policy (see {@link ReleasePolicy}). Absent = 'passed' (legacy). */
  readonly releasePolicy?: ReleasePolicy | undefined;
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
 * Recorded on a PhaseResult when a scoped commit (see CHANGELOG 0.38.0)
 * excluded one or more candidate paths because they were already dirty
 * before this engine run launched and this phase never actually touched
 * them (see dirty-guard.ts's excludeUntouchedLaunchResidue). `skipped: true`
 * means every candidate was excluded and no commit was attempted at all.
 */
export interface CommitExclusion {
  readonly excludedPaths: readonly string[];
  readonly skipped: boolean;
}

/**
 * Honest record of the scoped-commit bookkeeping step that runs AFTER a
 * phase's gate has already passed (see phase-runner.ts commitPhaseWork). The
 * commit is a POST-gate step: its outcome never decides whether the phase
 * passed — the gate already did that — it only reports what happened to the
 * working tree afterward, so the fleet and transcript can state "committed
 * <hash>" or "commit skipped/failed" without ever contradicting the phase
 * verdict. Present on a PhaseResult only when the gate passed
 * and a commit was therefore attempted or deliberately skipped.
 */
export interface PhaseCommitOutcome {
  readonly status: 'committed' | 'skipped' | 'failed';
  /** The landed commit hash, present only for status 'committed'. */
  readonly hash?: string | undefined;
  /** Human-readable detail for 'skipped'/'failed', plus any gitignored-path note on 'committed'. */
  readonly reason?: string | undefined;
  /**
   * True ONLY for a 'failed' commit whose failure belongs to the NEGATING SET —
   * a bookkeeping failure (workspace/index corruption) that genuinely
   * invalidates the phase's passed work. A negating commit failure is the one
   * post-gate condition that DOES fail the item; every other commit failure is
   * a non-fatal warning on a passed item. See bookkeeping.ts for the set.
   */
  readonly negating?: boolean | undefined;
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
  /** Present only when a scoped commit excluded launch-dirty residue (see CommitExclusion). */
  readonly commitExclusion?: CommitExclusion | undefined;
  /**
   * Outcome of the post-gate scoped-commit step. Present only
   * when this phase's gate passed and a commit was attempted or deliberately
   * skipped; absent for a failed/cancelled phase (no commit is reached).
   */
  readonly commit?: PhaseCommitOutcome | undefined;
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

// ── Best-of-N held-merge candidates ─────────────────────────────────────────

/** The diff a best-of-N candidate carries — computed from its worktree branch vs base (the existing worktree diff plumbing). */
export interface AttemptCandidateDiff {
  readonly files: readonly string[];
  readonly unifiedDiff: string;
  readonly stat: string;
}

/** One best-of-N attempt as the held-merge surface exposes it: its outcome, its usage, and its diff. */
export interface AttemptCandidate {
  readonly itemId: string;
  readonly attemptIndex: number;
  /** 'held-merge' (passed, parked, mergeable) or 'failed' (ran but did not pass). Only these two are ever candidates. */
  readonly state: 'held-merge' | 'failed';
  readonly title: string;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly usage: WorkItemUsage;
  readonly failureReason: string | null;
  /** The candidate's diff, or null when its worktree could not be diffed (e.g. already cleaned). Only meaningful for 'held-merge'. */
  readonly diff: AttemptCandidateDiff | null;
}

/**
 * A model judge's verdict over a group's candidates. CLEARLY a model judgment,
 * not ground truth: `scoredBy` is always 'model', and the engine PROPOSES this
 * winner — it only auto-picks when the group's item opted into autoAcceptWinner.
 */
export interface AttemptJudgment {
  readonly proposedWinnerItemId: string | null;
  readonly reasons: readonly string[];
  readonly model: string | null;
  readonly scoredBy: 'model';
}

/** A best-of-N group in the held-merge state, exposing its candidates for a winner pick. */
export interface HeldMergeGroup {
  readonly groupId: string;
  readonly workstreamId: string;
  readonly sourceTitle: string;
  /** True once every sibling is terminal (held-merge or failed) — a winner may be picked. */
  readonly ready: boolean;
  readonly candidates: readonly AttemptCandidate[];
  /** Whether this group opted into judge auto-accept. */
  readonly autoAccept: boolean;
  /** The most recent judge proposal for this group, if judged; always PROPOSED, never a silent auto-pick unless autoAccept. */
  readonly judgment: AttemptJudgment | null;
}

/** Result of picking a best-of-N winner: the winner integrates via the merge lane; losers' worktrees are cleaned. */
export interface AttemptPickResult {
  readonly groupId: string;
  readonly winnerItemId: string;
  readonly loserItemIds: readonly string[];
  /** True when a judge proposal auto-picked (group opted in); false for an explicit operator pick. */
  readonly auto: boolean;
}

// ── The injectable judge (a model call) ─────────────────────────────────────

/** One candidate as handed to the judge model. */
export interface AttemptJudgeCandidate {
  readonly itemId: string;
  readonly attemptIndex: number;
  readonly state: 'held-merge' | 'failed';
  readonly diff: AttemptCandidateDiff | null;
  readonly usage: WorkItemUsage;
}

export interface AttemptJudgeInput {
  readonly task: string;
  readonly candidates: readonly AttemptJudgeCandidate[];
}

/** The judge's raw verdict; the engine wraps it into an AttemptJudgment (stamping scoredBy:'model'). */
export interface AttemptJudgeVerdict {
  /** The chosen candidate's item id, or null when the judge declines to choose. */
  readonly winnerItemId: string | null;
  readonly reasons: readonly string[];
  readonly model?: string | undefined;
}

/** The injectable judge: a model call that scores candidates. Kept out of the engine so it stays provider-agnostic and testable. */
export type AttemptJudge = (input: AttemptJudgeInput) => Promise<AttemptJudgeVerdict>;

/** Discriminated events the engine emits over its own lifecycle (persistence, budget, fleet). */
export type OrchestrationEvent =
  | { readonly type: 'phase-inserted'; readonly workstreamId: string; readonly phase: Phase }
  | { readonly type: 'item-advanced'; readonly workstreamId: string; readonly itemId: string; readonly fromPhaseId: string | null; readonly toPhaseId: string | null }
  | { readonly type: 'item-blocked-budget'; readonly workstreamId: string; readonly itemId: string; readonly phaseId: string; readonly reason: string }
  | { readonly type: 'item-cancelled'; readonly workstreamId: string; readonly itemId: string; readonly reason: string }
  | { readonly type: 'item-passed'; readonly workstreamId: string; readonly itemId: string; readonly warnings?: readonly string[] | undefined }
  | { readonly type: 'item-failed'; readonly workstreamId: string; readonly itemId: string; readonly reason: string }
  /**
   * Dependency-gating lifecycle (BIG-3 item 2). `item-blocked-dependency`
   * fires once per NEW block (not every idle tick), naming the unmet
   * dependencies by id in `deps` and carrying the current human-readable
   * `reason` ('waiting on: …' or 'dependency failed: …'). `item-dependency-cleared`
   * fires when a previously-blocked item's dependencies all reach passed and it
   * is released back to the claimable set. `item-retried` fires when a
   * terminally-failed item is deliberately reset to re-run via engine.retryItem
   * — the documented recovery path that lets a failed dependency (and its
   * stuck dependents) recover.
   */
  | { readonly type: 'item-blocked-dependency'; readonly workstreamId: string; readonly itemId: string; readonly phaseId: string; readonly reason: string; readonly deps: readonly string[] }
  | { readonly type: 'item-dependency-cleared'; readonly workstreamId: string; readonly itemId: string }
  | { readonly type: 'item-retried'; readonly workstreamId: string; readonly itemId: string; readonly reason: string }
  /** Emitted once per item on `importWorkstream` for every item reconciled from a crash-artifact 'in-phase' snapshot back to 'pending' — see the 'in-phase' state doc. */
  | { readonly type: 'item-requeued'; readonly workstreamId: string; readonly itemId: string; readonly reason: string }
  | { readonly type: 'workstream-persisted'; readonly workstreamId: string }
  /**
   * Worktree-isolation lifecycle events (worktree mode only). Each names the
   * item and, where relevant, the on-disk worktree path and branch so an
   * observer (TUI, transcript) can report isolation + merge state honestly and
   * point at KEPT worktrees for inspection. None of these ever fire in shared
   * mode.
   */
  | { readonly type: 'item-worktree-created'; readonly workstreamId: string; readonly itemId: string; readonly path: string; readonly branch: string }
  /** A passed item's branch merged cleanly into the base branch through the integration lane. */
  | { readonly type: 'item-merged'; readonly workstreamId: string; readonly itemId: string; readonly branch: string; readonly hash: string }
  /**
   * The integration lane could not merge a passed item's branch — the base
   * merge conflicted. The worktree + branch are KEPT (never auto-resolved,
   * never silently dropped); the lane continues with the next item.
   */
  | { readonly type: 'item-merge-conflict'; readonly workstreamId: string; readonly itemId: string; readonly branch: string; readonly path: string; readonly files: readonly string[] }
  /** An item's worktree + branch were removed (merged item, or a clean tree after fail/kill). */
  | { readonly type: 'item-worktree-removed'; readonly workstreamId: string; readonly itemId: string; readonly path: string }
  /**
   * An item's worktree was deliberately KEPT rather than removed — a merge
   * conflict, or a dirty tree left behind by a failed/killed item (data
   * safety). `reason` states which; `path` is where the work still lives.
   */
  | { readonly type: 'item-worktree-kept'; readonly workstreamId: string; readonly itemId: string; readonly path: string; readonly reason: string }
  /**
   * A KEPT worktree was evicted to stay under the kept-worktree cap —
   * oldest-first, and always announced (never a silent sweep). Eviction bounds
   * DISK usage, never work: any uncommitted state was first committed onto the
   * item branch (`preservedCommit` when such a commit was created), only the
   * directory at `path` was removed, and `branch` is KEPT for recovery.
   */
  | { readonly type: 'item-worktree-evicted'; readonly workstreamId: string; readonly itemId: string; readonly path: string; readonly branch: string; readonly preservedCommit?: string | undefined }
  /**
   * Reconciliation of an orphaned `ws/*` worktree found at import (a crash
   * artifact from a prior process). `disposition` is `'adopted'` when the
   * engine re-attached it to a re-queued item, or `'reported'` when it belongs
   * to no known item and was left in place for the operator (NEVER deleted on
   * sight).
   */
  | { readonly type: 'orphan-worktree-reconciled'; readonly workstreamId: string; readonly path: string; readonly branch: string; readonly disposition: 'adopted' | 'reported' }
  /**
   * Emitted once per engine instance (see CHANGELOG 0.38.0), right after the
   * launch-time dirty-tree snapshot resolves, ONLY when it is non-empty.
   * Engine-wide, not workstream-scoped — `workstreamId` is absent (unlike
   * every other variant above) because it fires before any workstream is
   * necessarily even created. See dirty-guard.ts.
   */
  | { readonly type: 'dirty-tree-at-launch'; readonly paths: readonly string[] }
  /**
   * Best-of-N lifecycle (attempts.ts). `item-attempts-spawned` fires once when a
   * work item declared with attempts:N is expanded into N sibling items (naming
   * their ids and the shared groupId). `item-attempt-held` fires when a sibling
   * PASSES and is parked in held-merge (its worktree kept, not merged).
   * `attempts-ready` fires once when every sibling in a group is terminal — a
   * winner may now be picked. `attempt-judge-proposed` fires when the optional
   * judge pass proposes a winner (always a PROPOSAL). `attempt-winner-picked`
   * fires when a winner is accepted (its branch enters the merge lane; losers'
   * worktrees are cleaned); `auto` distinguishes a judge auto-accept from an
   * explicit operator pick.
   */
  | { readonly type: 'item-attempts-spawned'; readonly workstreamId: string; readonly groupId: string; readonly itemIds: readonly string[]; readonly attempts: number }
  | { readonly type: 'item-attempt-held'; readonly workstreamId: string; readonly groupId: string; readonly itemId: string }
  | { readonly type: 'attempts-ready'; readonly workstreamId: string; readonly groupId: string; readonly candidateItemIds: readonly string[] }
  | { readonly type: 'attempt-judge-proposed'; readonly workstreamId: string; readonly groupId: string; readonly proposedWinnerItemId: string | null; readonly reasons: readonly string[] }
  | { readonly type: 'attempt-winner-picked'; readonly workstreamId: string; readonly groupId: string; readonly winnerItemId: string; readonly loserItemIds: readonly string[]; readonly auto: boolean }
  /** Runtime-dynamic graph lifecycle (1.4.3): live edges, structured cycle/orphan outcomes, elastic-pool state. */
  | { readonly type: 'item-edge-added'; readonly workstreamId: string; readonly itemId: string; readonly dependsOnId: string; readonly reason: string }
  | { readonly type: 'graph-cycle'; readonly workstreamId: string; readonly itemIds: readonly string[]; readonly cycle: readonly string[] }
  | { readonly type: 'item-orphaned'; readonly workstreamId: string; readonly itemId: string; readonly blockerItemId: string; readonly reason: string }
  | { readonly type: 'pool-at-cap'; readonly workstreamId: string; readonly ready: number; readonly running: number; readonly capKey: string; readonly maxSize: number }
  | { readonly type: 'pool-spawn-refused'; readonly workstreamId: string; readonly itemId: string; readonly reason: string }
  | { readonly type: 'agent-retired'; readonly workstreamId: string; readonly agentId: string; readonly reason: string };

export type OrchestrationEventListener = (event: OrchestrationEvent) => void;
