/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * OrchestrationEngine (see CHANGELOG 0.38.0) — owns Workstream state and drives the
 * pipeline. WRAPS a canned/authored workstream; does not rewrite or touch
 * WrfcController (stage 1 of the 3-stage migration — see controller-compat.ts).
 *
 * The tick loop is reactive, not timer-driven: `start()` runs one tick;
 * every phase-run completion re-runs tick() for its workstream. Because JS
 * is single-threaded, computeClaims()'s synchronous read of in-flight counts
 * is never racing a concurrent claim — items are marked 'in-phase'
 * synchronously before any `await` inside the claim loop, so a re-entrant
 * tick() (triggered by an earlier completion resolving on a later turn of
 * the microtask queue) always sees up-to-date state.
 */
import { checkBudget } from './budget.js';
import { createCancellationRegistry, type CancellationRegistry } from './cancellation.js';
import type { PhaseRunnerAgentManagerLike, WrfcWorktreeOps } from './phase-runner.js';
import { runPhase } from './phase-runner.js';
import { snapshotDirtyTree, type DirtyLaunchSnapshot } from './dirty-guard.js';
import { createWorktreeIsolationManager, type WorktreeIsolationManager } from './worktree-isolation.js';
import {
  deserializeWorkstream as deserializeWorkstreamModel,
  deserializeWorkstreamSnapshot,
  attachDebouncedWriter,
  listSnapshotWorkstreamIds,
  loadWorkstreamSnapshot,
  serializeWorkstreamSnapshot,
} from './persistence.js';
import { computeClaims, dependencyStatus, firstPhase, nextPhaseAfter, reviewPhaseBefore, sortedPhases } from './scheduler.js';
import {
  CURRENT_WORKSTREAM_SCHEMA_VERSION,
  emptyWorkItemUsage,
  mergeWorkItemUsage,
  type BudgetCeiling,
  type OrchestrationEvent,
  type OrchestrationEventListener,
  type Phase,
  type PhaseResult,
  type PhaseSpec,
  type WorkItem,
  type WorkItemSpec,
  type WorkItemUsage,
  type Workstream,
  type WorkstreamIsolation,
  type WorkstreamProvenance,
} from './types.js';
import type { ConfigManager } from '../config/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export interface OrchestrationEngineDeps {
  readonly agentManager: PhaseRunnerAgentManagerLike;
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly runtimeBus: RuntimeEventBus;
  readonly projectRoot: string;
  readonly sessionId?: string | undefined;
  readonly createWorktree?: (() => WrfcWorktreeOps) | undefined;
  readonly priceUsage?: ((model: string | undefined, usage: WorkItemUsage) => number | null) | undefined;
  readonly skipClaimVerification?: boolean | undefined;
  /** Bounds re-review cycles through a dynamically-inserted fix phase. Default 5 (mirrors WrfcController's default maxFixAttempts). */
  readonly maxPhaseVisits?: number | undefined;
  readonly now?: (() => number) | undefined;
  /** Set false to skip wiring the debounced disk writer (tests that don't want filesystem side effects). Default true. */
  readonly persist?: boolean | undefined;
  /** Bounds how many KEPT (merge-conflict or dirty-after-fail/kill) worktrees a `worktree`-isolation workstream retains before oldest-first eviction. Default 20. Irrelevant to `shared`-isolation workstreams. */
  readonly keptWorktreeCap?: number | undefined;
}

export interface CreateWorkstreamInput {
  readonly id?: string | undefined;
  readonly title: string;
  readonly phases: readonly PhaseSpec[];
  readonly items: readonly WorkItemSpec[];
  readonly budget?: BudgetCeiling | undefined;
  /**
   * Where this workstream's item phases run their file changes. Omitted
   * (the default) ⇒ `'shared'` — every existing caller's behavior is
   * unchanged. See {@link WorkstreamIsolation} (types.ts) for the full
   * contrast with `'worktree'` mode.
   */
  readonly isolation?: WorkstreamIsolation | undefined;
  /**
   * Workstream-level provenance (BIG-3 item 1). Set by `fromPlanProposal` when
   * assembling from an approved PlanProposal; omitted by compat/`fromChainSpec`
   * callers. Stored verbatim on the created Workstream.
   */
  readonly provenance?: WorkstreamProvenance | undefined;
}

export interface OrchestrationEngine {
  createWorkstream(input: CreateWorkstreamInput): Workstream;
  getWorkstream(id: string): Workstream | null;
  listWorkstreams(): Workstream[];
  insertPhase(workstreamId: string, afterOrdinal: number, spec: PhaseSpec): Phase | null;
  /** Begin (or resume ticking) a workstream's pipeline. Idempotent — safe to call on an already-running workstream. */
  start(workstreamId: string): void;
  /** Abort a work item's in-flight agent (if any) and mark it terminally failed. Never affects sibling items. */
  kill(itemId: string): boolean;
  /**
   * Replace (or clear, via `undefined`) a workstream's budget ceiling and
   * immediately re-tick it, so any item already sitting in 'blocked-budget'
   * gets reconsidered right away — the only recovery path for that state
   * (see WorkItemState's 'blocked-budget' doc, types.ts). Returns false if
   * the workstream doesn't exist.
   */
  updateBudget(workstreamId: string, ceiling: BudgetCeiling | undefined): boolean;
  /**
   * Reset a terminally-FAILED work item so it re-runs from its first phase —
   * the documented recovery path (BIG-3 item 2) for a failed dependency and
   * the dependents it left stuck in 'blocked-dependency'. updateBudget-style:
   * mutates then immediately re-ticks, so the retry starts at once and any
   * dependents unblock on the next tick after it passes. Returns false if the
   * item doesn't exist or isn't in the 'failed' state (a passed or in-flight
   * item is never disturbed).
   */
  retryItem(itemId: string): boolean;
  getPhaseResults(workstreamId: string): readonly PhaseResult[];
  serializeWorkstream(workstreamId: string): string | null;
  /** Import a serialized snapshot (a full WorkstreamSnapshot JSON string, see persistence.ts). Refuses to overwrite a non-terminal in-memory workstream unless force=true. */
  importWorkstream(snapshotJson: string, force?: boolean): boolean;
  /** Import + start from the on-disk snapshot for one workstream id. */
  resumeWorkstream(workstreamId: string): boolean;
  /** Import + start every snapshot under .goodvibes/orchestration/. Returns the count resumed. */
  resumeAllFromDisk(): number;
  on(listener: OrchestrationEventListener): () => void;
  dispose(): void;
}

function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function createOrchestrationEngine(deps: OrchestrationEngineDeps): OrchestrationEngine {
  const now = deps.now ?? ((): number => Date.now());
  const sessionId = deps.sessionId ?? crypto.randomUUID().slice(0, 8);
  const maxPhaseVisits = deps.maxPhaseVisits ?? 5;
  const workstreams = new Map<string, Workstream>();
  const completedResults = new Map<string, PhaseResult[]>();
  const cancellation: CancellationRegistry = createCancellationRegistry();
  const listeners = new Set<OrchestrationEventListener>();
  let disposed = false;

  function emit(event: OrchestrationEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn('orchestration engine: listener threw', { error: summarizeError(error) });
      }
    }
  }

  function on(listener: OrchestrationEventListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // Dirty-residue guard (see CHANGELOG 0.38.0): snapshot the working tree's
  // dirty paths + content hashes ONCE, right at engine launch (synchronous —
  // see dirty-guard.ts's doc comment for why this must not be a promise
  // backed by real subprocess I/O), before any phase of this run has had a
  // chance to touch anything. A previously killed run sharing this same
  // projectRoot can leave uncommitted residue behind; this snapshot is what
  // lets a later scoped commit tell "residue from before this run" apart
  // from "this run's own changes" (see dirty-guard.ts and phase-runner.ts's
  // commitPhaseWork).
  const launchDirtySnapshot: DirtyLaunchSnapshot = snapshotDirtyTree(deps.projectRoot);
  if (launchDirtySnapshot.size > 0) {
    emit({ type: 'dirty-tree-at-launch', paths: [...launchDirtySnapshot.keys()] });
  }

  // Worktree-isolation lane (only ever exercised by a workstream created with
  // isolation: 'worktree' — see createWorkstream/runItemPhase/failItem below).
  // Constructing this unconditionally is cheap: it does no I/O until a
  // worktree-mode workstream actually calls into it.
  const worktreeIsolation: WorktreeIsolationManager = createWorktreeIsolationManager({
    projectRoot: deps.projectRoot,
    emit,
    now,
    keptWorktreeCap: deps.keptWorktreeCap,
  });

  function getWorkstream(id: string): Workstream | null {
    return workstreams.get(id) ?? null;
  }

  function listWorkstreams(): Workstream[] {
    return Array.from(workstreams.values());
  }

  function getPhaseResults(workstreamId: string): readonly PhaseResult[] {
    return completedResults.get(workstreamId) ?? [];
  }

  const unsubscribeWriter = deps.persist === false
    ? (): void => undefined
    : attachDebouncedWriter(deps.projectRoot, getWorkstream, getPhaseResults, on);

  function buildPhase(spec: PhaseSpec, ordinal: number, insertedAt?: number): Phase {
    return {
      id: spec.id ?? generateId('phase'),
      ordinal,
      role: spec.role,
      capacity: spec.capacity,
      gate: spec.gate,
      kind: spec.kind,
      ...(insertedAt !== undefined ? { insertedAt } : {}),
    };
  }

  function buildItem(spec: WorkItemSpec, startPhaseId: string | null): WorkItem {
    return {
      id: spec.id ?? generateId('item'),
      title: spec.title,
      task: spec.task,
      dependsOn: spec.dependsOn ? [...spec.dependsOn] : [],
      currentPhaseId: startPhaseId,
      state: startPhaseId ? 'pending' : 'passed',
      allAgentIds: [],
      visits: new Map(),
      touchedPaths: [],
      usage: emptyWorkItemUsage(),
      transportRetryCount: 0,
      createdAt: now(),
      ...(startPhaseId ? {} : { completedAt: now() }),
    };
  }

  function createWorkstream(input: CreateWorkstreamInput): Workstream {
    const phases = input.phases.map((spec, index) => buildPhase(spec, index + 1));
    const workstream: Workstream = {
      id: input.id ?? generateId('ws'),
      title: input.title,
      schemaVersion: CURRENT_WORKSTREAM_SCHEMA_VERSION,
      phases,
      items: [],
      budget: input.budget,
      isolation: input.isolation,
      provenance: input.provenance,
      createdAt: now(),
    };
    const first = firstPhase(workstream)?.id ?? null;
    workstream.items = input.items.map((spec) => buildItem(spec, first));
    workstreams.set(workstream.id, workstream);
    completedResults.set(workstream.id, []);
    return workstream;
  }

  function insertPhase(workstreamId: string, afterOrdinal: number, spec: PhaseSpec): Phase | null {
    const workstream = workstreams.get(workstreamId);
    if (!workstream) return null;
    const following = sortedPhases(workstream).filter((p) => p.ordinal > afterOrdinal);
    const nextOrdinal = following[0]?.ordinal ?? afterOrdinal + 1;
    const ordinal = (afterOrdinal + nextOrdinal) / 2;
    const phase = buildPhase(spec, ordinal, now());
    workstream.phases.push(phase);
    emit({ type: 'phase-inserted', workstreamId, phase });
    return phase;
  }

  function findOrInsertFixPhase(workstream: Workstream, reviewPhase: Phase): Phase {
    const existing = workstream.phases.find(
      (p) => p.kind === 'fix' && reviewPhaseBefore(workstream, p)?.id === reviewPhase.id,
    );
    if (existing) return existing;
    return insertPhase(workstream.id, reviewPhase.ordinal, {
      role: 'fixer',
      capacity: reviewPhase.capacity,
      gate: reviewPhase.gate,
      kind: 'fix',
    })!;
  }

  function visitsFor(item: WorkItem, phaseId: string): number {
    return item.visits.get(phaseId) ?? 0;
  }

  function recordVisit(item: WorkItem, phaseId: string): void {
    item.visits.set(phaseId, visitsFor(item, phaseId) + 1);
  }

  function routeItem(workstream: Workstream, item: WorkItem, toPhase: Phase | null, fromPhaseId: string): void {
    if (toPhase) {
      item.currentPhaseId = toPhase.id;
      item.state = 'awaiting-capacity';
      emit({ type: 'item-advanced', workstreamId: workstream.id, itemId: item.id, fromPhaseId, toPhaseId: toPhase.id });
    } else {
      item.currentPhaseId = null;
      item.state = 'passed';
      item.completedAt = now();
      emit({
        type: 'item-passed',
        workstreamId: workstream.id,
        itemId: item.id,
        ...(item.warnings && item.warnings.length > 0 ? { warnings: [...item.warnings] } : {}),
      });
    }
  }

  function failItem(workstream: Workstream, item: WorkItem, reason: string): void {
    item.state = 'failed';
    item.completedAt = now();
    item.failureReason = reason;
    emit({ type: 'item-failed', workstreamId: workstream.id, itemId: item.id, reason });
    // Worktree-mode fail/kill cleanup rule (remove only if clean, else KEEP —
    // data safety): covers every failItem call site uniformly, including
    // kill() and the tick()-catch path for a throw before any phase outcome.
    // No-op (instantly resolves) for a shared-isolation workstream, or an
    // item that never reached a claim and therefore never got a worktree.
    if (workstream.isolation === 'worktree') {
      void worktreeIsolation.cleanupTerminated(workstream, item).catch((error) => {
        logger.error('orchestration engine: worktree cleanup after item failure did not complete', {
          itemId: item.id, error: summarizeError(error),
        });
      });
    }
  }

  /**
   * Record a NON-FATAL bookkeeping note on an item without touching its
   * terminal status (DEBT-4 item 1). Used for post-gate faults that do not
   * negate the phase's passed work — e.g. a scoped commit that could not
   * complete. The item still passes/advances; the warning rides along on
   * `item.warnings` and, for a terminal pass, in the `item-passed` event, so a
   * passed-with-caveats outcome is visible instead of hidden or mislabelled.
   */
  function warnItem(item: WorkItem, note: string): void {
    (item.warnings ??= []).push(note);
    logger.warn('orchestration engine: non-fatal bookkeeping warning on a passed work item', {
      itemId: item.id,
      note,
    });
  }

  /** Indirection to defeat TS's cross-await narrowing of item.state — see the call site below. */
  function currentState(item: WorkItem): WorkItem['state'] {
    return item.state;
  }

  async function runItemPhase(workstream: Workstream, item: WorkItem, phase: Phase): Promise<void> {
    recordVisit(item, phase.id);
    item.state = 'in-phase';
    item.currentPhaseId = phase.id;
    item.blockedReason = undefined;

    // Worktree mode: ensure this item has its dedicated worktree BEFORE
    // spawning its phase agent (idempotent — a no-op from the item's second
    // phase onward, since the worktree persists across the item's whole run;
    // see WorktreeIsolationManager.ensureWorktree). A setup failure here is a
    // genuine phase-run failure (there is nowhere isolated for the agent to
    // work) — fail the item honestly rather than silently falling back to the
    // shared tree, which would defeat isolation's whole purpose.
    let itemWorktree: Awaited<ReturnType<WorktreeIsolationManager['ensureWorktree']>> | undefined;
    if (workstream.isolation === 'worktree') {
      try {
        itemWorktree = await worktreeIsolation.ensureWorktree(workstream, item);
      } catch (error) {
        logger.error('orchestration engine: failed to prepare item worktree', { itemId: item.id, error: summarizeError(error) });
        failItem(workstream, item, `worktree isolation setup failed: ${summarizeError(error)}`);
        return;
      }
    }

    const priorReports = getPhaseResults(workstream.id).filter((r) => r.itemId === item.id);
    const outcome = await runPhase(workstream, item, phase, priorReports, {
      agentManager: deps.agentManager,
      configManager: deps.configManager,
      runtimeBus: deps.runtimeBus,
      projectRoot: deps.projectRoot,
      sessionId,
      createWorktree: deps.createWorktree,
      cancellation,
      priceUsage: deps.priceUsage,
      skipClaimVerification: deps.skipClaimVerification,
      launchDirtySnapshot,
      itemWorktree,
    });

    // ── Bookkeeping region (AFTER the phase produced its outcome) ───────────
    // From here on everything is bookkeeping layered on top of a verdict the
    // phase has ALREADY reached (outcome.result.gate + agentStatus). It must
    // never be able to turn a passed phase into a failed item: the item's
    // terminal status derives ONLY from that phase outcome, plus the narrow
    // negating set (bookkeeping.ts). A bookkeeping fault becomes a warning on a
    // passed item (warnItem), never a failure — that is what makes "item failed
    // while every phase passed and the commit landed" unrepresentable
    // (DEBT-4 item 1). A throw BEFORE this point — inside runPhase, e.g. a gate
    // subprocess that never yielded a verdict — legitimately reaches tick()'s
    // catch and fails the item, because there is then no phase outcome to
    // stand on.
    try {
      item.usage = mergeWorkItemUsage(item.usage, outcome.result.usage);
    } catch (error) {
      warnItem(item, `usage rollup skipped: ${summarizeError(error)}`);
    }
    const results = completedResults.get(workstream.id) ?? [];
    results.push(outcome.result);
    completedResults.set(workstream.id, results);
    emit({ type: 'workstream-persisted', workstreamId: workstream.id });

    // kill() already transitioned the item to 'failed' synchronously before
    // this promise settled — don't clobber that terminal state. Read through
    // currentState() (not a direct `item.state` narrowing site) since TS's
    // control-flow analysis otherwise "remembers" the 'in-phase' assignment
    // above as if it still held after the `await`, even though kill() can
    // mutate the same object concurrently while this call was in flight.
    if (currentState(item) === 'failed') return;

    if (outcome.agentStatus === 'cancelled') {
      failItem(workstream, item, 'cancelled by operator');
      return;
    }

    if (outcome.agentStatus === 'failed') {
      failItem(workstream, item, outcome.result.report.summary);
      return;
    }

    if (outcome.result.gate.passed) {
      // The PHASE PASSED. Post-gate commit bookkeeping can only WARN this item
      // (or, for the narrow negating set, fail it) — it can never contradict
      // the passed verdict the gate already reached.
      const commit = outcome.result.commit;
      if (commit?.status === 'failed' && commit.negating) {
        // Negating set: the commit/merge left the workspace corrupted, so the
        // recorded pass can no longer be trusted — this is the one post-gate
        // condition that genuinely fails the item.
        failItem(
          workstream,
          item,
          `phase gate passed but the workspace was left unrecorded/corrupted: ${commit.reason ?? 'commit failed'}`,
        );
        return;
      }
      if (commit?.status === 'failed') {
        // Non-negating: the gate passed and the workspace is coherent, so the
        // work stands. Surface the miss as a warning, never a failure.
        warnItem(item, `scoped commit did not complete (non-fatal): ${commit.reason ?? 'commit failed'}`);
      }

      // A fix phase's PASSING gate routes BACK to the review phase it was
      // inserted after (dynamic insertion places 'fix' at an ordinal AFTER
      // its review, per design (b) — "inserts a fix phase after review and
      // re-routes that item back"), not forward past it. Every other kind
      // advances to the next phase by ordinal as usual.
      const forwardTarget = phase.kind === 'fix'
        ? (reviewPhaseBefore(workstream, phase) ?? nextPhaseAfter(workstream, phase.ordinal) ?? null)
        : (nextPhaseAfter(workstream, phase.ordinal) ?? null);
      routeItem(workstream, item, forwardTarget, phase.id);
      // The item just terminated PASSED (no further phase) — in worktree mode
      // its branch now enters the single sequential integration lane
      // (completion order, not claim order). Fire-and-forget: the lane
      // manages its own ordering and never rejects (see
      // WorktreeIsolationManager.enqueueIntegration), so tick() is never
      // blocked waiting on a merge that may itself await a sibling ahead of
      // it in the lane.
      if (forwardTarget === null && workstream.isolation === 'worktree') {
        void worktreeIsolation.enqueueIntegration(workstream, item);
      }
      return;
    }

    // A review's FAILING gate with unsatisfied constraints gets one more
    // cycle through a (found-or-inserted) fix phase, bounded by visits. A
    // fix phase's own FAILING gate (the fixer didn't actually fix anything —
    // phantom guard or quality gates caught it) is a genuine terminal
    // failure, not something to retry-loop.
    const unsatisfied = outcome.result.gate.unsatisfiedConstraintIds ?? [];
    if (phase.kind === 'review' && unsatisfied.length > 0 && visitsFor(item, phase.id) < maxPhaseVisits) {
      const fixPhase = findOrInsertFixPhase(workstream, phase);
      routeItem(workstream, item, fixPhase, phase.id);
      return;
    }

    failItem(
      workstream,
      item,
      outcome.result.gate.results.filter((r) => !r.passed).map((r) => `${r.gate}: ${r.output}`).join('; ') || 'gate failed',
    );
  }

  /**
   * Dependency-gate pre-pass (BIG-3 item 2), run at the top of every tick
   * BEFORE computeClaims. For each item still sitting at its FIRST phase in a
   * pre-claim state (pending / awaiting-capacity / blocked-dependency) with
   * declared dependencies, classify those dependencies and either release or
   * refuse the item:
   *   - every dependency 'passed' → RELEASE: if it was 'blocked-dependency',
   *     restore it to 'pending' and clear blockedReason (emit
   *     item-dependency-cleared) so computeClaims can pick it up this same tick.
   *   - any dependency unmet → REFUSE: set 'blocked-dependency' with an honest
   *     blockedReason ('waiting on: …' or 'dependency failed: …'), recomputed
   *     every tick so it stays current as dependencies change; emit
   *     item-blocked-dependency only on a NEW block (never once per idle tick).
   *
   * Only FIRST-phase items are gated. Once an item's dependencies are all
   * passed at its first claim they stay passed (passed is terminal), so a
   * mid-pipeline item (currentPhaseId past the first phase) is never re-gated.
   * A retried item (engine.retryItem) is reset back to the first phase and is
   * therefore re-gated here — which is exactly why a failed dependency's
   * dependents recover only once the dependency is retried AND passes.
   * A FAILED dependency keeps the dependent blocked (recoverable), never fails
   * it — refuse-not-kill.
   */
  function applyDependencyGates(workstream: Workstream): void {
    const first = firstPhase(workstream);
    if (!first) return;
    for (const item of workstream.items) {
      if (item.dependsOn.length === 0) continue;
      if (item.currentPhaseId !== first.id) continue; // only gate at entry (first phase)
      if (item.state !== 'pending' && item.state !== 'awaiting-capacity' && item.state !== 'blocked-dependency') continue;
      const status = dependencyStatus(workstream, item);
      if (status.ready) {
        if (item.state === 'blocked-dependency') {
          item.state = 'pending';
          item.blockedReason = undefined;
          emit({ type: 'item-dependency-cleared', workstreamId: workstream.id, itemId: item.id });
        }
        continue;
      }
      const reason = status.failed.length > 0
        ? `dependency failed: ${status.failed.join(', ')}`
        : `waiting on: ${status.waiting.join(', ')}`;
      const wasAlreadyBlocked = item.state === 'blocked-dependency';
      item.state = 'blocked-dependency';
      item.blockedReason = reason;
      if (!wasAlreadyBlocked) {
        emit({
          type: 'item-blocked-dependency',
          workstreamId: workstream.id,
          itemId: item.id,
          phaseId: item.currentPhaseId ?? '',
          reason,
          deps: [...item.dependsOn],
        });
      }
    }
  }

  function tick(workstreamId: string): void {
    if (disposed) return;
    const workstream = workstreams.get(workstreamId);
    if (!workstream) return;
    // Dependency gate FIRST — release/refuse first-phase items by their
    // dependencies before computeClaims decides capacity (which never sees a
    // 'blocked-dependency' item, see scheduler.ts computeClaims).
    applyDependencyGates(workstream);
    const claims = computeClaims(workstream);
    for (const { item, phase } of claims) {
      const budgetCheck = checkBudget(workstream);
      if (!budgetCheck.allowed) {
        // Re-checked on every tick (computeClaims keeps 'blocked-budget'
        // items in the waiting set — see scheduler.ts) rather than a
        // one-time transition: the reason can change between checks (e.g.
        // token ceiling was the blocker, then a cost ceiling is reached
        // too), so keep it current even though the event only fires once
        // per NEW block to avoid spamming listeners on every idle tick.
        const wasAlreadyBlocked = item.state === 'blocked-budget';
        item.state = 'blocked-budget';
        item.blockedReason = budgetCheck.reason;
        if (!wasAlreadyBlocked) {
          emit({ type: 'item-blocked-budget', workstreamId, itemId: item.id, phaseId: phase.id, reason: budgetCheck.reason ?? 'budget ceiling reached' });
        }
        continue;
      }
      void runItemPhase(workstream, item, phase)
        .catch((error) => {
          // Reaching here means runItemPhase rejected BEFORE the phase produced
          // an outcome — the run threw inside runPhase (spawn, gate execution,
          // etc.) with no gate verdict to stand on. That is a genuine phase
          // failure, so failing the item is honest. Post-outcome bookkeeping
          // faults never reach here: runItemPhase converts them to warnings on
          // a passed item (or, for the negating set, an explicit failItem) —
          // see its bookkeeping region (DEBT-4 item 1).
          logger.error('orchestration engine: phase run threw before producing an outcome', {
            workstreamId, itemId: item.id, phaseId: phase.id, error: summarizeError(error),
          });
          failItem(workstream, item, summarizeError(error));
        })
        .finally(() => {
          if (!disposed) tick(workstreamId);
        });
    }
  }

  function start(workstreamId: string): void {
    tick(workstreamId);
  }

  function findItemAndWorkstream(itemId: string): { workstream: Workstream; item: WorkItem } | null {
    for (const workstream of workstreams.values()) {
      const item = workstream.items.find((i) => i.id === itemId);
      if (item) return { workstream, item };
    }
    return null;
  }

  function kill(itemId: string): boolean {
    const found = findItemAndWorkstream(itemId);
    if (!found) return false;
    const { workstream, item } = found;
    if (item.state === 'passed' || item.state === 'failed') return false;
    cancellation.abort(itemId);
    if (item.agentId) deps.agentManager.cancel(item.agentId, 'kill');
    failItem(workstream, item, 'cancelled by operator');
    emit({ type: 'item-cancelled', workstreamId: workstream.id, itemId, reason: 'cancelled by operator' });
    return true;
  }

  function updateBudget(workstreamId: string, ceiling: BudgetCeiling | undefined): boolean {
    const workstream = workstreams.get(workstreamId);
    if (!workstream) return false;
    workstream.budget = ceiling;
    tick(workstreamId);
    return true;
  }

  /**
   * See the OrchestrationEngine.retryItem doc. Resets a failed item to
   * 'pending' at the first phase; clears the terminal fields and the per-phase
   * visit budget (a fresh fix-cycle allowance for the retry) but RETAINS
   * accumulated `usage` (monotone — a retry adds to the tally, never wipes it).
   * In worktree mode a still-present KEPT worktree is reused (ensureWorktree is
   * idempotent on worktreePath); a worktree already removed after the failure
   * is recreated at the next first claim.
   */
  function retryItem(itemId: string): boolean {
    const found = findItemAndWorkstream(itemId);
    if (!found) return false;
    const { workstream, item } = found;
    if (item.state !== 'failed') return false;
    const first = firstPhase(workstream);
    if (!first) return false;
    item.state = 'pending';
    item.currentPhaseId = first.id;
    item.failureReason = undefined;
    item.completedAt = undefined;
    item.blockedReason = undefined;
    item.visits.clear();
    emit({ type: 'item-retried', workstreamId: workstream.id, itemId, reason: 'reset to re-run after failure' });
    tick(workstream.id);
    return true;
  }

  function serializeWorkstream(workstreamId: string): string | null {
    const workstream = workstreams.get(workstreamId);
    if (!workstream) return null;
    return serializeWorkstreamSnapshot(workstream, getPhaseResults(workstreamId));
  }

  function isTerminalWorkstream(workstream: Workstream): boolean {
    return workstream.items.every((item) => item.state === 'passed' || item.state === 'failed');
  }

  /**
   * An item persisted as 'in-phase' was mid-run when the snapshot was
   * written (the debounced writer, persistence.ts, captures state
   * synchronously — see runItemPhase — so this is always a crash artifact,
   * never a live agent this process could still be waiting on). Left
   * verbatim, it would count as an OCCUPIED capacity slot forever
   * (computeClaims, scheduler.ts) while never being in the re-claimable
   * waiting set, permanently starving every sibling in the same phase.
   * Requeue it as 'pending' and drop the stale agentId so the next tick()
   * reclaims it like any other waiting item — its prior PhaseResult (if any)
   * was only ever pushed AFTER phase completion (see runItemPhase), so
   * re-running the phase from here cannot produce a duplicate result.
   */
  function reconcileImportedItems(workstream: Workstream): void {
    for (const item of workstream.items) {
      if (item.state !== 'in-phase') continue;
      item.state = 'pending';
      item.agentId = undefined;
      emit({
        type: 'item-requeued',
        workstreamId: workstream.id,
        itemId: item.id,
        reason: 're-queued after restart — was in-phase when the snapshot was written',
      });
    }
  }

  function importWorkstream(snapshotJson: string, force = false): boolean {
    const snapshot = deserializeWorkstreamSnapshot(snapshotJson);
    if (!snapshot) return false;
    const workstream = deserializeWorkstreamModel(snapshot.workstream);
    const existing = workstreams.get(workstream.id);
    if (existing && !isTerminalWorkstream(existing) && !force) {
      logger.warn('orchestration engine: importWorkstream refused — existing workstream is non-terminal; use force=true to overwrite', {
        workstreamId: workstream.id,
      });
      return false;
    }
    reconcileImportedItems(workstream);
    workstreams.set(workstream.id, workstream);
    completedResults.set(workstream.id, [...snapshot.completedResults]);
    // Orphan worktree reconciliation (worktree mode only) — SYNCHRONOUS and
    // done BEFORE this function returns, i.e. before any caller can call
    // start()/tick() on this workstream. An on-disk `ws/<wsShort>/*` worktree
    // not already recorded on one of the just-imported items is a crash
    // artifact from a prior process; adopt it onto a matching unresolved item
    // or report it for the operator (NEVER deleted on sight) — see
    // WorktreeIsolationManager.reconcileOrphans for why this must not race
    // the first tick()'s claim (it would otherwise risk creating a second
    // worktree at the same deterministic path).
    if (workstream.isolation === 'worktree') {
      worktreeIsolation.reconcileOrphans(workstream);
    }
    return true;
  }

  function resumeWorkstream(workstreamId: string): boolean {
    if (!workstreams.has(workstreamId)) {
      const snapshot = loadWorkstreamSnapshot(deps.projectRoot, workstreamId);
      if (!snapshot) return false;
      if (!importWorkstream(JSON.stringify(snapshot))) return false;
    }
    tick(workstreamId);
    return true;
  }

  function resumeAllFromDisk(): number {
    let count = 0;
    for (const workstreamId of listSnapshotWorkstreamIds(deps.projectRoot)) {
      if (resumeWorkstream(workstreamId)) count += 1;
    }
    return count;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    unsubscribeWriter();
    listeners.clear();
  }

  return {
    createWorkstream,
    getWorkstream,
    listWorkstreams,
    insertPhase,
    start,
    kill,
    updateBudget,
    retryItem,
    getPhaseResults,
    serializeWorkstream,
    importWorkstream,
    resumeWorkstream,
    resumeAllFromDisk,
    on,
    dispose,
  };
}
