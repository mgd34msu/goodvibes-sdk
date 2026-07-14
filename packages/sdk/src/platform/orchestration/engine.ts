/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * OrchestrationEngine (see CHANGELOG 0.38.0) — owns Workstream state and
 * drives the pipeline; the ONE engine review-derived fix graphs also feed. The
 * tick loop is reactive (every phase completion re-ticks); items are marked
 * 'in-phase' synchronously before any await, so re-entrant ticks never race
 * a concurrent claim.
 */
import { checkBudget } from './budget.js';
import { createCancellationRegistry, type CancellationRegistry } from './cancellation.js';
import type { PhaseRunnerAgentManagerLike, WrfcWorktreeOps } from './phase-runner.js';
import { runPhase } from './phase-runner.js';
import { snapshotDirtyTree, type DirtyLaunchSnapshot } from './dirty-guard.js';
import { createWorktreeIsolationManager, type WorktreeIsolationManager } from './worktree-isolation.js';
import { createAttemptsCoordinator, type AttemptsCoordinator } from './attempts.js';
import {
  deserializeWorkstream as deserializeWorkstreamModel,
  deserializeWorkstreamSnapshot,
  attachDebouncedWriter,
  listSnapshotWorkstreamIds,
  loadWorkstreamSnapshot,
  serializeWorkstreamSnapshot,
} from './persistence.js';
import { computeClaims, firstPhase, nextPhaseAfter, reviewPhaseBefore, sortedPhases } from './scheduler.js';
import { applyDependencyGates } from './dependency-gate.js';
import { addConflictSerializationEdges, addDependencyEdge, buildGraphSnapshot, detectOrphans, type EdgeAddResult, type WorkstreamGraphSnapshot } from './graph-dynamics.js';
import { gateClaimAgainstFleet, isElastic, isHardFailed, poolState, retirementEvent, shouldAutoRetry, type FleetCapacityFn } from './elastic-pool.js';
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
  type PriceProvenanceFn,
  type WorkItem,
  type WorkItemSpec,
  type WorkItemUsage,
  type Workstream,
  type WorkstreamIsolation,
  type WorkstreamProvenance,
  type ReleasePolicy,
  type AttemptJudge,
  type AttemptJudgment,
  type AttemptPickResult,
  type HeldMergeGroup,
} from './types.js';
import type { ConfigManager } from '../config/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { WorktreeRegistry } from '../runtime/worktree/registry.js';
import { runWorktreeSetup, resolveEffectiveWorktreeSetup } from '../runtime/worktree/setup.js';
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
  /** Provenance for the same resolution priceUsage prices with — stamped onto committed usage records at pricing time. */
  readonly priceProvenance?: PriceProvenanceFn | undefined;
  readonly skipClaimVerification?: boolean | undefined;
  /** Bounds re-review cycles through a dynamically-inserted fix phase. Default 5. */
  readonly maxPhaseVisits?: number | undefined;
  readonly now?: (() => number) | undefined;
  /** Set false to skip wiring the debounced disk writer (tests that don't want filesystem side effects). Default true. */
  readonly persist?: boolean | undefined;
  /** Kept-worktree retention bound before oldest-first eviction (worktree mode). Default 20. */
  readonly keptWorktreeCap?: number | undefined;
  /** Cold-start worktree setup hook (deps install, .env carry-over); wired by the composition root; a failing setup never fails creation. */
  readonly runWorktreeSetup?: ((worktreePath: string) => Promise<void> | void) | undefined;
  /** Optional best-of-N judge (PROPOSES a winner; never auto-picks unless the item opted in). Injectable — provider-agnostic. */
  readonly judgeAttempts?: AttemptJudge | undefined;
  /** Live probe of the ONE fleet ceiling (fleet.maxSize) for elastic workstreams; absent = ungated (legacy). */
  readonly fleetCapacity?: FleetCapacityFn | undefined;
  /** Bounded per-task auto-retries before hard-fail (elastic fix graphs). Default 0 = off (legacy). */
  readonly maxItemRetries?: number | undefined;
  /** In-phase items with no observed activity past this window carry the stalled tell. Default 10 minutes. */
  readonly stallAfterMs?: number | undefined;
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
  /** Workstream provenance (set by fromPlanProposal; omitted by compat callers). */
  readonly provenance?: WorkstreamProvenance | undefined;
  /** Edge-release policy; 'reviewed-and-merged' also engages the elastic pool. Absent = 'passed' (legacy). */
  readonly releasePolicy?: ReleasePolicy | undefined;
}

export interface OrchestrationEngine {
  createWorkstream(input: CreateWorkstreamInput): Workstream;
  getWorkstream(id: string): Workstream | null;
  listWorkstreams(): Workstream[];
  insertPhase(workstreamId: string, afterOrdinal: number, spec: PhaseSpec): Phase | null;
  /** Begin (or resume ticking) a workstream's pipeline. Idempotent. */
  start(workstreamId: string): void;
  /** Abort an item's in-flight agent and mark it terminally failed (siblings untouched). */
  kill(itemId: string): boolean;
  /** Replace/clear a workstream's budget ceiling and re-tick (the 'blocked-budget' recovery path). */
  updateBudget(workstreamId: string, ceiling: BudgetCeiling | undefined): boolean;
  /** Reset a terminally-FAILED item to re-run from its first phase (the failed-dependency recovery path); re-ticks immediately. */
  retryItem(itemId: string): boolean;
  getPhaseResults(workstreamId: string): readonly PhaseResult[];
  /** Best-of-N: held-merge groups awaiting a winner pick. */
  listHeldMergeGroups(workstreamId?: string): Promise<HeldMergeGroup[]>;
  /** Best-of-N: accept a winner (merges through the lane; losers cleaned). */
  pickAttemptWinner(groupId: string, winnerItemId: string): Promise<AttemptPickResult>;
  /** Best-of-N: judge the candidates and PROPOSE a winner (never auto-picks). */
  proposeAttemptWinner(groupId: string): Promise<AttemptJudgment>;
  /** Stamp the conflict-resolution session id onto a conflicted item. */
  stampConflictSession(itemId: string, sessionId: string): boolean;
  /** Re-attempt a conflicted item's merge through the same lane. */
  retryItemIntegration(itemId: string): Promise<'merged' | 'conflict' | 'not-conflicted'>;
  /** Add a dependency edge LIVE (a discovered missed dependency / manual serialization). Cycles are refused with a structured graph-cycle outcome. */
  addDependency(itemId: string, dependsOnId: string, reason: string): EdgeAddResult | null;
  /** Re-queue a non-terminal item to its first phase (the discovering task's "may re-queue"); cancels its in-flight agent. */
  requeueItem(itemId: string, reason: string): boolean;
  /** The surface-facing task graph: nodes, edges, states, elastic-pool state, stalled tells. */
  getGraphSnapshot(workstreamId: string): WorkstreamGraphSnapshot | null;
  serializeWorkstream(workstreamId: string): string | null;
  /** Import a serialized snapshot; refuses to clobber a non-terminal workstream unless forced. */
  importWorkstream(snapshotJson: string, force?: boolean): boolean;
  /** Import + start from the on-disk snapshot for one workstream id. */
  resumeWorkstream(workstreamId: string): boolean;
  /** Import + start every on-disk snapshot; returns the count resumed. */
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
  const maxItemRetries = deps.maxItemRetries ?? 0;
  const stallAfterMs = deps.stallAfterMs ?? 10 * 60 * 1000;
  /** Workstreams currently in the announced at-cap state (event fires once per transition). */
  const atCapNoted = new Set<string>();
  const requeuedInFlight = new Set<string>(); // requeued mid-flight: the settling run must not clobber the reset
  const workstreams = new Map<string, Workstream>();
  const completedResults = new Map<string, PhaseResult[]>();
  const cancellation: CancellationRegistry = createCancellationRegistry();
  const listeners = new Set<OrchestrationEventListener>();
  let disposed = false;

  function dispatch(event: OrchestrationEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn('orchestration engine: listener threw', { error: summarizeError(error) });
      }
    }
  }

  function emit(event: OrchestrationEvent): void {
    dispatch(event);
    // An integration conflict adds serialization edges (dynamic graph).
    if (event.type === 'item-merge-conflict') {
      const workstream = workstreams.get(event.workstreamId);
      const item = workstream?.items.find((i) => i.id === event.itemId);
      if (workstream && item && isElastic(workstream)) {
        addConflictSerializationEdges(workstream, item, event.files, dispatch);
      }
    }
  }

  function on(listener: OrchestrationEventListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // Dirty-residue guard: snapshot dirty paths+hashes ONCE at launch (sync —
  // see dirty-guard.ts) so a later scoped commit can tell prior-run residue
  // from this run's own changes.
  const launchDirtySnapshot: DirtyLaunchSnapshot = snapshotDirtyTree(deps.projectRoot);
  if (launchDirtySnapshot.size > 0) {
    emit({ type: 'dirty-tree-at-launch', paths: [...launchDirtySnapshot.keys()] });
  }

  // Worktree-isolation lane (worktree-mode workstreams only; no I/O until
  // used). Cold-start setup hook: injected override (tests) else the derived
  // per-project setup, outcome recorded onto the worktree registry.
  const runWorktreeSetupHook =
    deps.runWorktreeSetup ??
    (async (worktreePath: string): Promise<void> => {
      const registry = new WorktreeRegistry(deps.projectRoot);
      // Derived-by-default (lockfile → install, .env carry-over); user config overrides.
      const config = resolveEffectiveWorktreeSetup((key) => (deps.configManager.get as unknown as (k: string) => unknown)(key), deps.projectRoot);
      const result = await runWorktreeSetup(worktreePath, deps.projectRoot, config);
      registry.recordSetup(worktreePath, result);
    });

  const worktreeIsolation: WorktreeIsolationManager = createWorktreeIsolationManager({
    projectRoot: deps.projectRoot,
    emit,
    now,
    keptWorktreeCap: deps.keptWorktreeCap,
    runSetup: runWorktreeSetupHook,
  });

  function getWorkstream(id: string): Workstream | null {
    return workstreams.get(id) ?? null;
  }

  // Best-of-N sibling attempts (attempts.ts): coordinator owns the groups;
  // its delegates reuse the same worktree lane as the ordinary path.
  const attempts: AttemptsCoordinator = createAttemptsCoordinator({
    emit,
    getWorkstream,
    enqueueIntegration: (workstream, item) => { void worktreeIsolation.enqueueIntegration(workstream, item); },
    cleanupWorktree: (workstream, item) => worktreeIsolation.cleanupTerminated(workstream, item),
    diffItem: (item) => worktreeIsolation.diffItem(item),
    judge: deps.judgeAttempts,
  });

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
      ...(spec.cluster !== undefined ? { cluster: spec.cluster } : {}),
      ...(spec.files !== undefined ? { files: [...spec.files] } : {}),
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
      releasePolicy: input.releasePolicy,
      createdAt: now(),
    };
    const first = firstPhase(workstream)?.id ?? null;
    // Expand any `attempts:N` item into N sibling attempts (worktree isolation
    // only); every other item passes through unchanged (see attempts.ts).
    workstream.items = attempts.expandItems(workstream.id, workstream.isolation, input.items, (spec) => buildItem(spec, first));
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
    // Bounded auto-retry; past the bound the failure is HARD. Cancels never retry.
    if (shouldAutoRetry(item, reason, maxItemRetries)) {
      item.retryCount = (item.retryCount ?? 0) + 1;
      const first = firstPhase(workstream);
      if (first) {
        item.state = 'pending';
        item.currentPhaseId = first.id;
        item.failureReason = undefined;
        item.blockedReason = undefined;
        item.visits.clear();
        emit({ type: 'item-retried', workstreamId: workstream.id, itemId: item.id, reason: `auto-retry ${item.retryCount}/${maxItemRetries}: ${reason}` });
        queueMicrotask(() => { if (!disposed) tick(workstream.id); });
        return;
      }
    }
    item.state = 'failed';
    item.completedAt = now();
    item.failureReason = reason;
    emit({ type: 'item-failed', workstreamId: workstream.id, itemId: item.id, reason });
    // Worktree fail/kill cleanup: remove only if clean, else KEEP (data safety).
    if (workstream.isolation === 'worktree') {
      void worktreeIsolation.cleanupTerminated(workstream, item).catch((error) => {
        logger.error('orchestration engine: worktree cleanup after item failure did not complete', {
          itemId: item.id, error: summarizeError(error),
        });
      });
    }
    // A failed attempt still counts toward its best-of-N group's readiness.
    attempts.onItemFailedTerminal(workstream, item);
  }

  /** Record a NON-FATAL note on an item without touching terminal status (passed-with-caveats stays visible). */
  function warnItem(item: WorkItem, note: string): void {
    (item.warnings ??= []).push(note);
    logger.warn('orchestration engine: non-fatal bookkeeping warning on a passed work item', {
      itemId: item.id,
      note,
    });
  }

  /** Defeats TS's cross-await narrowing of item.state. */
  function currentState(item: WorkItem): WorkItem['state'] {
    return item.state;
  }

  async function runItemPhase(workstream: Workstream, item: WorkItem, phase: Phase): Promise<void> {
    recordVisit(item, phase.id);
    item.state = 'in-phase';
    item.currentPhaseId = phase.id;
    item.blockedReason = undefined;
    item.lastActivityAt = now();

    // Worktree mode: ensure the item's dedicated worktree BEFORE spawning
    // (idempotent). A setup failure is a genuine phase failure — never a
    // silent fallback to the shared tree.
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
      priceProvenance: deps.priceProvenance,
      skipClaimVerification: deps.skipClaimVerification,
      launchDirtySnapshot,
      itemWorktree,
    });

    // ── Bookkeeping region (AFTER the phase outcome) ────────────────────────
    // Everything below layers on a verdict already reached; a bookkeeping
    // fault becomes a warning on a passed item (or, for the narrow negating
    // set, an explicit fail) — never a silent contradiction of the gate.
    item.lastActivityAt = now();
    try {
      item.usage = mergeWorkItemUsage(item.usage, outcome.result.usage);
    } catch (error) {
      warnItem(item, `usage rollup skipped: ${summarizeError(error)}`);
    }
    const results = completedResults.get(workstream.id) ?? [];
    results.push(outcome.result);
    completedResults.set(workstream.id, results);
    emit({ type: 'workstream-persisted', workstreamId: workstream.id });

    // kill() may have transitioned the item to 'failed' while this phase was
    // in flight — read via currentState() to defeat stale narrowing and never
    // clobber that terminal state.
    if (currentState(item) === 'failed') return;

    if (outcome.agentStatus === 'cancelled') {
      // A deliberate requeue already reset this item — never clobber it.
      if (requeuedInFlight.delete(item.id)) return;
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

      // A fix phase's PASSING gate routes BACK to its review phase (never
      // forward past it); every other kind advances by ordinal.
      const forwardTarget = phase.kind === 'fix'
        ? (reviewPhaseBefore(workstream, phase) ?? nextPhaseAfter(workstream, phase.ordinal) ?? null)
        : (nextPhaseAfter(workstream, phase.ordinal) ?? null);
      routeItem(workstream, item, forwardTarget, phase.id);
      // Terminal pass in worktree mode: the branch enters the sequential
      // integration lane (fire-and-forget; the lane orders itself).
      if (forwardTarget === null && workstream.isolation === 'worktree') {
        // Best-of-N attempt → HOLD (park as a candidate, do not auto-merge);
        // an ordinary item → enqueue its integration. onItemPassedTerminal
        // decides which and routes accordingly.
        attempts.onItemPassedTerminal(workstream, item);
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

  function tick(workstreamId: string): void {
    if (disposed) return;
    const workstream = workstreams.get(workstreamId);
    if (!workstream) return;
    // Dependency gate FIRST — release/refuse first-phase items by their
    // dependencies before computeClaims decides capacity (which never sees a
    // 'blocked-dependency' item, see scheduler.ts computeClaims).
    applyDependencyGates(workstream, emit);
    if (isElastic(workstream)) { // orphan pass: hard-failed blockers surface on dependents immediately
      detectOrphans(workstream, (candidate) => isHardFailed(candidate, maxItemRetries), emit);
    }
    const claims = computeClaims(workstream);
    // One fleet probe per tick; claims allowed this tick count against it.
    const fleetProbe = isElastic(workstream) && deps.fleetCapacity ? deps.fleetCapacity() : null;
    let fleetActive = fleetProbe?.active ?? 0;
    for (const { item, phase } of claims) {
      if (item.orphaned) continue; // orphaned outcome already surfaced
      if (fleetProbe) {
        const decision = gateClaimAgainstFleet(workstream, item, { ...fleetProbe, active: fleetActive }, atCapNoted.has(workstreamId));
        if (!decision.allow) {
          if (decision.event) {
            if (decision.event.type === 'pool-at-cap') atCapNoted.add(workstreamId);
            emit(decision.event);
          }
          // The task stays VISIBLY ready with its reason — never a silent stall.
          item.state = 'awaiting-capacity';
          item.blockedReason = decision.reason;
          continue;
        }
        atCapNoted.delete(workstreamId);
        fleetActive += 1; // this claim spawns a fresh fleet agent
        item.blockedReason = undefined;
      }
      const budgetCheck = checkBudget(workstream, item);
      if (!budgetCheck.allowed) { // re-decided every tick; the event fires once per NEW block
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
          // A rejection here means no phase outcome exists (the run threw
          // before a verdict) — failing the item is honest.
          logger.error('orchestration engine: phase run threw before producing an outcome', {
            workstreamId, itemId: item.id, phaseId: phase.id, error: summarizeError(error),
          });
          failItem(workstream, item, summarizeError(error));
        })
        .finally(() => {
          if (disposed) return;
          tick(workstreamId);
          const retire = retirementEvent(workstream, item.agentId); // empty ready set + no imminent release = retire
          if (retire) emit(retire);
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
   * Reset a failed item to 'pending' at the first phase (fresh visit budget,
   * usage RETAINED — monotone). A KEPT worktree is reused; a removed one is
   * recreated at the next claim.
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

  function addDependency(itemId: string, dependsOnId: string, reason: string): EdgeAddResult | null {
    const found = findItemAndWorkstream(itemId);
    if (!found) return null;
    const result = addDependencyEdge(found.workstream, itemId, dependsOnId, reason, emit);
    if (result.added) tick(found.workstream.id); // re-gate immediately
    return result;
  }

  function requeueItem(itemId: string, reason: string): boolean {
    const found = findItemAndWorkstream(itemId);
    if (!found) return false;
    const { workstream, item } = found;
    if (item.state === 'passed' || item.state === 'failed') return false;
    if (item.state === 'in-phase') requeuedInFlight.add(itemId);
    cancellation.abort(itemId);
    if (item.agentId) deps.agentManager.cancel(item.agentId, 'interrupt');
    const first = firstPhase(workstream);
    if (!first) return false;
    item.state = 'pending';
    item.currentPhaseId = first.id;
    item.agentId = undefined;
    item.blockedReason = undefined;
    emit({ type: 'item-requeued', workstreamId: workstream.id, itemId, reason });
    tick(workstream.id);
    return true;
  }

  function getGraphSnapshot(workstreamId: string): WorkstreamGraphSnapshot | null {
    const workstream = workstreams.get(workstreamId);
    if (!workstream) return null;
    const probe = isElastic(workstream) && deps.fleetCapacity ? deps.fleetCapacity() : null;
    return buildGraphSnapshot(workstream, poolState(workstream, probe),
      (item) => item.state === 'in-phase' && item.lastActivityAt !== undefined && now() - item.lastActivityAt > stallAfterMs);
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
   * An imported 'in-phase' item is always a crash artifact (no prior-process
   * agent survives). Requeue as 'pending' and drop the stale agentId so it is
   * re-claimable instead of occupying a capacity slot forever.
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
    // Orphan worktree reconciliation (worktree mode) — synchronous, BEFORE any
    // tick can claim (see WorktreeIsolationManager.reconcileOrphans): adopt or
    // report crash-artifact trees, never delete on sight.
    if (workstream.isolation === 'worktree') {
      worktreeIsolation.reconcileOrphans(workstream);
    }
    // Rebuild the in-memory best-of-N group registry from the imported items so
    // held-merge groups are pickable again after a resume (attempts.ts).
    attempts.reconcileGroups(workstream);
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
    listHeldMergeGroups: (workstreamId) => attempts.listGroups(workstreamId),
    pickAttemptWinner: (groupId, winnerItemId) => attempts.pickWinner(groupId, winnerItemId),
    proposeAttemptWinner: (groupId) => attempts.proposeWinner(groupId),
    stampConflictSession: (itemId, sessionId) => {
      const found = findItemAndWorkstream(itemId);
      if (!found || found.item.mergeState !== 'conflict') return false;
      found.item.conflictSessionId = sessionId;
      return true;
    },
    retryItemIntegration: async (itemId) => {
      const found = findItemAndWorkstream(itemId);
      if (!found || found.item.mergeState !== 'conflict') return 'not-conflicted';
      // Same lane as first-pass integration; success clears markers + reclaims the tree.
      await worktreeIsolation.enqueueIntegration(found.workstream, found.item);
      const resulting: string | undefined = found.item.mergeState; // mutated by the lane
      return resulting === 'merged' ? 'merged' : 'conflict';
    },
    addDependency,
    requeueItem,
    getGraphSnapshot,
    serializeWorkstream,
    importWorkstream,
    resumeWorkstream,
    resumeAllFromDisk,
    on,
    dispose,
  };
}
