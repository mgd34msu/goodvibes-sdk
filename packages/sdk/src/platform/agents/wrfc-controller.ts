import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentMessageBus } from './message-bus.js';
import { type CompletionReport, type Constraint, type EngineerReport, type ReviewerReport } from './completion-report.js';
import {
  buildGateFailureTask,
  buildFixTask,
  buildReviewTask,
  parseEngineerCompletionReport,
  parseReviewerCompletionReport,
  verifyEngineerClaims,
} from './wrfc-reporting.js';
import type {
  QualityGateResult,
  QueuedChain,
  WrfcChain,
  WrfcChildRouteSelector,
  WrfcAgentRole,
  WrfcOwnerDecision,
  WrfcOwnerDecisionAction,
  WrfcState,
  WrfcSubtask,
} from './wrfc-types.js';
import { WrfcWorkmap } from './wrfc-workmap.js';
import { AgentWorktree, type CommitWorkingTreeResult } from './worktree.js';
import { completePlanItemsForAgent } from './wrfc-plan-sync.js';
import type { ConfigManager } from '../config/manager.js';
import type { AgentRecord } from '../tools/agent/index.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { ExecutionPlanManager } from '../core/execution-plan.js';
import type { AgentEvent, RuntimeEventBus } from '../runtime/events/index.js';
import type {
  ProjectWorkPlanTaskCreateInput,
  ProjectWorkPlanTaskStatus,
  ProjectWorkPlanTaskUpdateInput,
} from '../knowledge/project-planning/index.js';
import {
  emitAgentCompleted,
  emitAgentFailed,
  emitAgentProgress,
  emitAgentRunning,
  emitWorkflowChainFailed,
  emitWorkflowFixAttempted,
  emitWorkflowReviewCompleted,
} from '../runtime/emitters/index.js';
import {
  getWrfcAutoCommit,
  getWrfcCommitScope,
  getWrfcMaxFixAttempts,
  getWrfcScoreThreshold,
  getWrfcAgentHeartbeatTimeoutMs,
  getWrfcTransportRetryLimit,
  getWrfcTransportRetryDelayMs,
  type AgentManagerLike,
  type WrfcCommitScope,
} from './wrfc-config.js';
import { isTransportFailureMessage } from '../types/errors.js';
import {
  buildEngineerConstraintAddendum,
} from './wrfc-prompt-addenda.js';
import {
  completeWrfcOrchestrationNode,
  createWrfcWorkflowContext,
  emitWrfcAutoCommitted,
  emitWrfcCascadeAbort,
  emitWrfcChainCreated,
  emitWrfcChainPassed,
  emitWrfcConstraintsEnumerated,
  emitWrfcGraphCreated,
  emitWrfcScoreRegression,
  emitWrfcStateChanged,
  failWrfcOrchestrationNode,
  startWrfcOrchestrationNode,
} from './wrfc-runtime-events.js';
import { runWrfcGateChecks } from './wrfc-gate-runtime.js';
import { isFanoutShapeConstraintText } from '../tools/agent/wrfc-batch-policy.js';

export { extractScoreFromText, extractPassedFromText, extractIssuesFromText } from './wrfc-reporting.js';

/**
 * Schema version for the serialized WRFC chain envelope.
 * Increment when the WrfcChain shape changes in an incompatible way.
 */
export const CURRENT_WRFC_CHAIN_SCHEMA_VERSION = 1;

const VALID_TRANSITIONS: Partial<Record<WrfcState, WrfcState[]>> = {
  pending: ['engineering'],
  engineering: ['integrating', 'reviewing', 'failed'],
  integrating: ['reviewing', 'failed'],
  reviewing: ['fixing', 'awaiting_gates', 'failed'],
  fixing: ['reviewing', 'failed'],
  awaiting_gates: ['gating', 'failed'],
  gating: ['passed', 'failed', 'committing', 'fixing'],
  committing: ['passed', 'failed'],
};

/** Returns true when a chain is in a terminal state (passed or failed). */
function isChainTerminal(state: WrfcState): boolean {
  return state === 'passed' || state === 'failed';
}
/** Returns true when a chain is actively executing (not terminal and not pending). */
function isChainActive(state: WrfcState): boolean {
  return !isChainTerminal(state) && state !== 'pending';
}
/** Type guard: returns true when an agent record is in-flight (pending or running). */
function isAgentInFlight<T extends Pick<AgentRecord, 'status'>>(record: T | null | undefined): record is T {
  return record != null && (record.status === 'pending' || record.status === 'running');
}

const MAX_ACTIVE_CHAINS = 6;
const CHAIN_CLEANUP_DELAY_MS = 60_000;
type WrfcWorktreeOps = Pick<AgentWorktree, 'merge' | 'cleanup'> & Partial<Pick<AgentWorktree, 'commitWorkingTree' | 'currentHead'>>;
type WrfcWorkPlanService = {
  createWorkPlanTask(input: ProjectWorkPlanTaskCreateInput): Promise<unknown>;
  updateWorkPlanTask(input: ProjectWorkPlanTaskUpdateInput): Promise<unknown>;
};
interface ConstraintEvaluation {
  constraintsSatisfied: number;
  constraintsTotal: number;
  unsatisfiedConstraintIds: string[];
  ignoredConstraintFindingIds: string[];
  constraintFailure: boolean;
}

export class WrfcController {
  private readonly chains = new Map<string, WrfcChain>();
  private chainQueue: QueuedChain[] = [];
  private unsubscribers: Array<() => void> = [];
  private activeChainCount = 0;
  private readonly sessionId: string;
  private readonly workmap: WrfcWorkmap;
  private readonly projectRoot: string;
  private readonly skipClaimVerification: boolean;
  /** Cached at construction time: whether projectRoot existed on disk when this controller was created. */
  private readonly projectRootExistedAtStartup: boolean;
  private runtimeBus: RuntimeEventBus;
  private readonly messageBus: Pick<AgentMessageBus, 'registerAgent'>;
  private planManager: Pick<ExecutionPlanManager, 'getActive' | 'updateItem'> | null = null;
  private readonly agentManager: AgentManagerLike;
  private readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  private readonly createWorktree: () => WrfcWorktreeOps;
  private readonly selectChildRoute: WrfcChildRouteSelector | null;
  private workPlanService: WrfcWorkPlanService | null = null;
  private readonly workPlanTaskQueues = new Map<string, Promise<void>>();
  /** Tracks last-seen timestamp per agent for watchdog timeout. */
  private readonly agentLastSeen = new Map<string, number>();
  /** Active watchdog timer handle, if any. */
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    runtimeBus: RuntimeEventBus,
    messageBus: Pick<AgentMessageBus, 'registerAgent'>,
    deps: {
      readonly agentManager: AgentManagerLike;
      readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
      readonly projectRoot: string;
      readonly surfaceRoot?: string | undefined;
      readonly createWorktree?: (() => WrfcWorktreeOps) | undefined;
      readonly selectChildRoute?: WrfcChildRouteSelector | undefined;
      /**
       * When true, skip verifyEngineerClaims for both engineer and fixer completions.
       * Use ONLY in test harnesses where projectRoot is a synthetic path without real files.
       * Production code must NEVER set this flag — it disables the phantom-work guard.
       * Prefer the environment-driven skip (nonexistent projectRoot) where possible.
       */
      readonly skipClaimVerification?: boolean;
    },
  ) {
    this.runtimeBus = runtimeBus;
    this.messageBus = messageBus;
    this.agentManager = deps.agentManager;
    this.configManager = deps.configManager;
    this.projectRoot = deps.projectRoot;
    this.skipClaimVerification = deps.skipClaimVerification ?? false;
    // Cache existsSync at construction time — the workmap will mkdir under projectRoot
    // during the first appendOwnerDecision, so checking later would always return true.
    this.projectRootExistedAtStartup = existsSync(deps.projectRoot);
    this.createWorktree = deps.createWorktree ?? (() => new AgentWorktree(this.projectRoot));
    this.selectChildRoute = deps.selectChildRoute ?? null;
    this.sessionId = crypto.randomUUID().slice(0, 8);
    this.workmap = new WrfcWorkmap(this.projectRoot, this.sessionId, { surfaceRoot: deps.surfaceRoot });
    this.setupListeners();
  }

  createChain(ownerRecord: AgentRecord): WrfcChain {
    logger.info('WrfcController.createChain: called', {
      agentId: ownerRecord.id,
      task: ownerRecord.task.slice(0, 60),
      activeChainCount: this.activeChainCount,
    });

    const chain = this.createBaseChain(ownerRecord);
    if (this.activeChainCount >= MAX_ACTIVE_CHAINS) {
      this.chainQueue.push({ record: ownerRecord, queuedAt: Date.now() });
      logger.debug('WrfcController.createChain: at cap, queued', {
        chainId: chain.id,
        agentId: ownerRecord.id,
        activeCount: this.activeChainCount,
        queueLength: this.chainQueue.length,
      });
      emitWrfcChainCreated(this.runtimeBus, this.sessionId, chain.id, chain.task);
      return chain;
    }

    this.startEngineeringChain(chain, true);
    logger.debug('WrfcController.createChain', { chainId: chain.id, agentId: ownerRecord.id });
    return chain;
  }

  getSessionId(): string { return this.sessionId; }

  getWorkmap(): WrfcWorkmap { return this.workmap; }

  setPlanManager(planManager: Pick<ExecutionPlanManager, 'getActive' | 'updateItem'>): void {
    this.planManager = planManager;
  }

  setRuntimeBus(runtimeBus: RuntimeEventBus): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.runtimeBus = runtimeBus;
    this.setupListeners();
  }

  setWorkPlanService(service: WrfcWorkPlanService | null | undefined): void {
    this.workPlanService = service ?? null;
  }

  getChain(chainId: string): WrfcChain | null { return this.chains.get(chainId) ?? null; }

  listChains(): WrfcChain[] { return Array.from(this.chains.values()); }

  resumeChain(chainId: string): boolean {
    const chain = this.chains.get(chainId);
    if (!chain || isChainTerminal(chain.state)) return false;
    if (this.hasRunningChild(chain)) {
      this.appendOwnerDecision(chain, 'resume_skipped', 'WRFC chain already has an active child agent');
      return true;
    }
    if (this.activeChainCount >= MAX_ACTIVE_CHAINS) {
      if (!this.chainQueue.some((queued) => queued.record.id === chain.ownerAgentId)) {
        const owner = this.agentManager.getStatus(chain.ownerAgentId);
        if (owner) this.chainQueue.push({ record: owner, queuedAt: Date.now() });
      }
      this.appendOwnerDecision(chain, 'resume_skipped', 'WRFC chain is queued because active chain capacity is full');
      return true;
    }
    // Item 3: Resume interrupted chains from their recorded state.
    if (chain.state === 'reviewing') {
      // Re-spawn reviewer using the last engineer report on record.
      const report = chain.engineerReport;
      if (report) {
        this.appendOwnerDecision(chain, 'resume_started', `WRFC owner re-spawning reviewer for interrupted chain (was reviewing)`);
        // MIN-6: Re-inject phantom-work synthetic issue on resume if claimsVerified was false,
        // so the flag is not silently laundered by the startReview synthetic-issue clear.
        // NOTE: We intentionally only re-inject for claimsVerified===false (kind='unverified').
        // The 'unverifiable_no_claims' path leaves claimsVerified===undefined; if that chain
        // was interrupted mid-review, the reviewer already received the synthetic issue in
        // its task text during startReview — it does not need re-injection on resume.
        if (chain.claimsVerified === false) {
          chain.syntheticIssues ??= [];
          const alreadyInjected = chain.syntheticIssues.some((issue) =>
            issue.description.includes('Claimed work not found on disk') ||
            issue.description.includes('No work claimed and no git diff')
          );
          if (!alreadyInjected) {
            chain.syntheticIssues.push({
              severity: 'critical',
              description: 'Claimed work not found on disk (re-injected on resume): claimsVerified=false from prior engineering phase',
            });
          }
        }
        // Reset to engineering so transition() accepts reviewing.
        chain.state = 'engineering';
        this.startReview(chain, report);
        return true;
      }
      this.appendOwnerDecision(chain, 'resume_skipped', 'WRFC chain in reviewing state but no engineer report found for re-review');
      return true;
    }
    if (chain.state === 'fixing') {
      // Re-spawn fixer using the last reviewer report.
      const reviewerReport = chain.reviewerReport;
      if (reviewerReport) {
        this.appendOwnerDecision(chain, 'resume_started', `WRFC owner re-spawning fixer for interrupted chain (was fixing)`);
        // Reset to reviewing so transition() will allow fixing.
        chain.state = 'reviewing';
        this.startFix(chain, reviewerReport);
        return true;
      }
      this.appendOwnerDecision(chain, 'resume_skipped', 'WRFC chain in fixing state but no reviewer report found for re-fix');
      return true;
    }
    if (chain.state === 'awaiting_gates') {
      this.appendOwnerDecision(chain, 'resume_started', `WRFC owner re-running gates for interrupted chain (was awaiting_gates)`);
      this.checkAndRunGatesForAll().catch((error) => {
        logger.error('WrfcController.resumeChain: gate phase error', { chainId: chain.id, error: summarizeError(error) });
        this.failChain(chain, `Gate phase error during resume: ${summarizeError(error)}`);
      });
      return true;
    }
    if (chain.state !== 'pending') {
      this.appendOwnerDecision(chain, 'resume_skipped', `WRFC chain state ${chain.state} cannot be resumed`);
      return true;
    }
    this.appendOwnerDecision(chain, 'resume_started', 'WRFC owner resumed pending chain');
    this.startEngineeringChain(chain, false);
    return true;
  }

  resumeAllActiveChains(): number {
    let resumed = 0;
    for (const chain of this.chains.values()) {
      if (this.resumeChain(chain.id)) resumed += 1;
    }
    return resumed;
  }

  /**
   * Item 3: Serialize a chain to a JSON string for durable storage.
   * Returns null if the chain does not exist.
   */
  serializeChain(chainId: string): string | null {
    const chain = this.chains.get(chainId);
    if (!chain) return null;
    try {
      return JSON.stringify({ schemaVersion: CURRENT_WRFC_CHAIN_SCHEMA_VERSION, chain });
    } catch (error) {
      logger.error('WrfcController.serializeChain: JSON serialization failed', { chainId, error: summarizeError(error) });
      return null;
    }
  }

  /**
   * Item 3: Deserialize a chain from a JSON string.
   * Returns null if the JSON is invalid, the required fields are missing, or
   * the schema version is newer than this runtime supports.
   *
   * Schema versioning:
   * - Missing schemaVersion (v0/legacy): accepted for back-compat — the JSON
   *   is the raw chain object directly.
   * - schemaVersion === CURRENT_WRFC_CHAIN_SCHEMA_VERSION (1): unwrap { schemaVersion, chain }.
   * - schemaVersion > CURRENT_WRFC_CHAIN_SCHEMA_VERSION: rejected — fail closed.
   */
  deserializeChain(json: string): WrfcChain | null {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (error) {
      logger.error('WrfcController.deserializeChain: JSON parse failed', { error: summarizeError(error) });
      return null;
    }

    // Unwrap schema-versioned envelope or treat as legacy (v0) raw chain.
    let candidate: unknown;
    if (
      raw !== null
      && typeof raw === 'object'
      && 'schemaVersion' in raw
      && typeof (raw as { schemaVersion: unknown }).schemaVersion === 'number'
    ) {
      const version = (raw as { schemaVersion: number }).schemaVersion;
      if (version > CURRENT_WRFC_CHAIN_SCHEMA_VERSION) {
        logger.error('WrfcController.deserializeChain: future schemaVersion rejected — upgrade runtime to read this payload', {
          schemaVersion: version,
          supportedVersion: CURRENT_WRFC_CHAIN_SCHEMA_VERSION,
        });
        return null;
      }
      // version <= current: unwrap the chain field.
      candidate = (raw as { chain?: unknown }).chain;
    } else {
      // Legacy v0: the JSON payload IS the chain directly.
      candidate = raw;
    }

    // Structural validation of required fields.
    if (
      !candidate
      || typeof candidate !== 'object'
      || !('id' in candidate) || typeof (candidate as { id: unknown }).id !== 'string'
      || !('state' in candidate) || typeof (candidate as { state: unknown }).state !== 'string'
      || !('ownerAgentId' in candidate) || typeof (candidate as { ownerAgentId: unknown }).ownerAgentId !== 'string'
      || !('task' in candidate) || typeof (candidate as { task: unknown }).task !== 'string'
    ) {
      logger.warn('WrfcController.deserializeChain: invalid chain JSON — missing required fields (id, state, ownerAgentId, task)');
      return null;
    }
    return candidate as WrfcChain;
  }

  /**
   * Item 3: Import a deserialized chain into this controller instance.
   * After importing, call resumeChain(chain.id) to continue from recorded state.
   *
   * Refuses to overwrite a non-terminal chain (state is not 'passed' or 'failed')
   * to prevent accidental clobber of live chains. Use force=true to override.
   * Always overwrites terminal chains (idempotent replay is safe for completed work).
   *
   * Returns true if the chain was imported, false if refused.
   */
  importChain(chain: WrfcChain, force = false): boolean {
    const existing = this.chains.get(chain.id);
    if (existing && !isChainTerminal(existing.state) && !force) {
      logger.warn('WrfcController.importChain: refused — existing chain is non-terminal; use force=true to overwrite', {
        chainId: chain.id,
        existingState: existing.state,
      });
      return false;
    }
    // Insert into the chain map BEFORE reapZombieChain runs. reapZombieChain
    // emits state-changed + chain-failed for a terminal transition, and every
    // other terminal transition in this controller operates on a chain already
    // present in this.chains — so a consumer that resolves the chain via
    // getChain(id) in response to those events finds it, consistent with the
    // rest of the lifecycle. (chain is a reference already held here, so
    // setting first and then mutating it in reapZombieChain is equivalent.)
    this.chains.set(chain.id, chain);
    if (!isChainTerminal(chain.state) && this.isZombieChain(chain)) {
      this.reapZombieChain(chain);
    }
    logger.info('WrfcController.importChain: chain imported', {
      chainId: chain.id,
      state: chain.state,
      overwroteExisting: existing !== undefined,
    });
    return true;
  }

  /**
   * Item d5 (Wave 6, wo-F): resurrection-safe zombie check for a chain about
   * to be imported at rehydrate. A non-terminal chain whose ENTIRE roster
   * (allAgentIds) is absent from THIS process's live AgentManager never
   * survived the restart — no in-process execution is coming back to finish
   * it, so it would otherwise show as "running" forever. If even ONE roster
   * agent id IS live (e.g. re-imported mid-session, not at a real process
   * restart), this returns false and the chain is left exactly as imported —
   * reaping only ever fires when NOTHING could possibly still be driving it.
   */
  private isZombieChain(chain: WrfcChain): boolean {
    if (chain.allAgentIds.length === 0) return false;
    return chain.allAgentIds.every((agentId) => this.agentManager.getStatus(agentId) === null);
  }

  /**
   * Item d5: mark a reimported zombie chain terminal at import time so it
   * presents as failed + prunable instead of stuck non-terminal forever.
   * Deliberately does NOT call failChain()/cancelChain(): those assume a
   * live in-memory execution (cancel running children, complete the owner
   * agent record, re-check gates for siblings) that makes no sense for a
   * chain whose entire roster is already confirmed dead — this is a direct,
   * minimal field mutation plus the same state-changed/chain-failed events
   * every other terminal transition emits, so consumers see one consistent
   * "chain failed" signal regardless of which path produced it.
   */
  private reapZombieChain(chain: WrfcChain): void {
    const from = chain.state;
    const reason = 'zombie chain reaped at rehydrate: no member agent survived the restart';
    chain.state = 'failed';
    chain.error = reason;
    chain.failureKind = 'other';
    chain.completedAt = Date.now();
    emitWrfcStateChanged(this.runtimeBus, this.sessionId, chain.id, from, 'failed');
    emitWorkflowChainFailed(this.runtimeBus, createWrfcWorkflowContext(this.sessionId, chain.id), {
      chainId: chain.id,
      reason,
      failureKind: 'other',
    });
    logger.warn('WrfcController.importChain: reaped zombie chain — no member agent survived restart', {
      chainId: chain.id,
      priorState: from,
      agentIds: chain.allAgentIds,
    });
  }

  dispose(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private transition(chain: WrfcChain, to: WrfcState): void {
    const allowed = VALID_TRANSITIONS[chain.state];
    if (!allowed || !allowed.includes(to)) {
      logger.error('WrfcController: illegal state transition', {
        chainId: chain.id,
        from: chain.state,
        to,
      });
      throw new Error(`Illegal WRFC transition: ${chain.state} -> ${to} for chain ${chain.id}`);
    }

    const from = chain.state;
    chain.state = to;
    if (!isChainTerminal(to)) {
      this.keepOwnerAgentActive(chain);
    }
    emitWrfcStateChanged(this.runtimeBus, this.sessionId, chain.id, from, to);
    logger.debug('WrfcController.transition', { chainId: chain.id, from, to });
  }

  private applyWrfcAgentMetadata(chain: WrfcChain, record: AgentRecord, role: WrfcAgentRole, subtaskId?: string): void {
    record.wrfcId = chain.id;
    record.wrfcRole = role;
    record.wrfcPhaseOrder = this.wrfcPhaseOrder(role);
    if (subtaskId) {
      record.wrfcSubtaskId = subtaskId;
    }
    if (role === 'owner') {
      record.progress = this.ownerProgress(chain);
    }
    if (isAgentInFlight(record)) {
      emitAgentProgress(this.runtimeBus, {
        sessionId: this.sessionId,
        traceId: `${this.sessionId}:wrfc-agent-metadata:${record.id}`,
        source: 'wrfc-controller',
        agentId: record.id,
      }, {
        agentId: record.id,
        progress: record.progress ?? `WRFC ${role} phase`,
        ...(record.parentAgentId ? { parentAgentId: record.parentAgentId } : {}),
        wrfcId: chain.id,
        wrfcRole: role,
        wrfcPhaseOrder: record.wrfcPhaseOrder,
      });
    }
  }

  /** Wire up a freshly spawned WRFC child agent in one canonical order:
   * stamp metadata, push to allAgentIds tracking list, register with message bus.
   * Keeps the role-field assignment at each call site to preserve clarity. */
  /** Prepend a formatted block of synthetic controller-injected issues to a review task body.
   * Returns the augmented task string; does NOT clear the issues array (caller's responsibility). */
  private prependSyntheticIssues(
    issues: ReadonlyArray<{ readonly severity: string; readonly description: string }>,
    reviewTask: string,
  ): string {
    if (issues.length === 0) return reviewTask;
    const syntheticBlock = [
      `## Synthetic issues from controller`,
      ``,
      ...issues.map((issue) => `- [${issue.severity.toUpperCase()}] ${issue.description}`),
    ].join('\n');
    return syntheticBlock + '\n\n---\n\n' + reviewTask;
  }

  private registerSpawnedChild(chain: WrfcChain, record: AgentRecord, role: Exclude<WrfcAgentRole, 'owner'>, subtaskId?: string): void {
    this.applyWrfcAgentMetadata(chain, record, role, subtaskId);
    chain.allAgentIds.push(record.id);
    this.messageBus.registerAgent({
      agentId: record.id,
      role,
      wrfcId: chain.id,
    });
  }

  private keepOwnerAgentActive(chain: WrfcChain, reason?: string): void {
    if (chain.ownerTerminalEmitted || isChainTerminal(chain.state)) return;
    const owner = this.agentManager.getStatus(chain.ownerAgentId);
    if (!owner) return;
    this.applyWrfcAgentMetadata(chain, owner, 'owner');
    owner.status = 'running';
    delete owner.completedAt;
    owner.progress = reason ? `${this.ownerProgress(chain)} - ${reason}` : this.ownerProgress(chain);
    emitAgentRunning(this.runtimeBus, {
      sessionId: this.sessionId,
      traceId: `${this.sessionId}:wrfc-owner-active:${chain.id}`,
      source: 'wrfc-controller',
      agentId: owner.id,
    }, {
      agentId: owner.id,
      wrfcId: chain.id,
      wrfcRole: 'owner',
      wrfcPhaseOrder: owner.wrfcPhaseOrder,
    });
    emitAgentProgress(this.runtimeBus, {
      sessionId: this.sessionId,
      traceId: `${this.sessionId}:wrfc-owner-progress:${chain.id}`,
      source: 'wrfc-controller',
      agentId: owner.id,
    }, {
      agentId: owner.id,
      progress: owner.progress,
      wrfcId: chain.id,
      wrfcRole: 'owner',
      wrfcPhaseOrder: owner.wrfcPhaseOrder,
    });
  }

  private ownerProgress(chain: WrfcChain): string {
    if (chain.subtasks && chain.subtasks.length > 0) {
      const passed = chain.subtasks.filter((subtask) => subtask.state === 'passed').length;
      return `WRFC owner supervising compound chain (${chain.state}, ${passed}/${chain.subtasks.length} deliverables passed)`;
    }
    return `WRFC owner supervising child agents (${chain.state})`;
  }

  private wrfcPhaseOrder(role: WrfcAgentRole): number {
    switch (role) {
      case 'owner':
        return 0;
      case 'orchestrator':
        return 0;
      case 'engineer':
        return 1;
      case 'reviewer':
        return 2;
      case 'fixer':
        return 3;
      case 'integrator':
        return 4;
      case 'verifier':
        return 5;
    }
  }

  private setupListeners(): void {
    const unsubComplete = this.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>(
      'AGENT_COMPLETED',
      ({ payload }) => {
        this.agentLastSeen.set(payload.agentId, Date.now());
        this.onAgentComplete(payload.agentId).catch((error) => {
          logger.error('WrfcController.onAgentComplete unhandled error', {
            agentId: payload.agentId,
            error: summarizeError(error),
          });
        });
      },
    );
    const unsubError = this.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>(
      'AGENT_FAILED',
      ({ payload }) => {
        this.agentLastSeen.set(payload.agentId, Date.now());
        this.onAgentFailed(payload.agentId, payload.error);
      },
    );
    const unsubCancelled = this.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_CANCELLED' }>>(
      'AGENT_CANCELLED',
      ({ payload }) => {
        this.agentLastSeen.set(payload.agentId, Date.now());
        this.onAgentCancelled(payload.agentId, payload.reason);
      },
    );
    const unsubRunning = this.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_RUNNING' }>>(
      'AGENT_RUNNING',
      ({ payload }) => {
        this.agentLastSeen.set(payload.agentId, Date.now());
      },
    );
    const unsubStreamDelta = this.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_STREAM_DELTA' }>>(
      'AGENT_STREAM_DELTA',
      ({ payload }) => {
        // MAJ-3: Reset agentLastSeen on streaming output so watchdog does not
        // time out a streaming-only agent that emits no PROGRESS events.
        this.agentLastSeen.set(payload.agentId, Date.now());
      },
    );
    const unsubProgress = this.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_PROGRESS' }>>(
      'AGENT_PROGRESS',
      ({ payload }) => {
        this.agentLastSeen.set(payload.agentId, Date.now());
      },
    );
    this.unsubscribers.push(unsubComplete, unsubError, unsubCancelled, unsubRunning, unsubProgress, unsubStreamDelta);
    this.resetWatchdog();
  }

  /**
   * Start (or restart) the watchdog timer based on current config.
   * Called once on setup and whenever the timeout config may have changed.
   */
  private resetWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    const timeoutMs = getWrfcAgentHeartbeatTimeoutMs(this.configManager);
    if (timeoutMs <= 0) return;
    // Check at 1/4 the timeout interval, but no less than 50ms (for testability)
    // and no more than 5 seconds (to avoid excessive polling in production).
    const intervalMs = Math.min(5_000, Math.max(50, Math.floor(timeoutMs / 4)));
    this.watchdogTimer = setInterval(() => {
      this.tickWatchdog(timeoutMs);
    }, intervalMs);
    this.watchdogTimer.unref?.();
  }

  /** Tick: fail any chain whose active child agent has been silent longer than timeoutMs. */
  private tickWatchdog(timeoutMs: number): void {
    const now = Date.now();
    for (const chain of this.chains.values()) {
      if (!isChainActive(chain.state)) continue;
      // Find the active child agent for this chain.
      const activeAgentId = this.activeChildAgentId(chain);
      if (!activeAgentId) continue;
      const record = this.agentManager.getStatus(activeAgentId);
      if (!record || (record.status !== 'running' && record.status !== 'pending')) continue;
      const lastSeen = this.agentLastSeen.get(activeAgentId) ?? record.startedAt ?? now;
      const silentMs = now - lastSeen;
      if (silentMs >= timeoutMs) {
        logger.error('WrfcController.watchdog: agent silent, failing chain', {
          chainId: chain.id,
          agentId: activeAgentId,
          silentMs,
          timeoutMs,
        });
        this.failChain(
          chain,
          `Agent ${activeAgentId} went silent for ${Math.round(silentMs / 1000)}s (timeout: ${Math.round(timeoutMs / 1000)}s)`,
        );
      }
    }
  }

  /**
   * Returns true when verifyEngineerClaims should be skipped for a completion event.
   *
   * Skip conditions (applied uniformly to engineer AND fixer completions):
   *   1. `this.skipClaimVerification` is true — explicit opt-out for test harnesses that
   *      use real /tmp paths (directories that exist on disk) where files are never actually
   *      written to disk by agents. Use this when the environment-driven skip does not apply.
   *   2. `!this.projectRootExistedAtStartup` — environment-driven skip: projectRoot did not
   *      exist on disk when this controller was constructed. Cached at construction time because
   *      the WrfcWorkmap mkdir's the directory tree on the first appendOwnerDecision call,
   *      making a late-bound existsSync check unreliable (would always return true after that).
   *      Preferred mechanism; harnesses should use nonexistent projectRoot paths when feasible.
   *
   * PRODUCTION INVARIANT: In any real GoodVibes session the projectRoot is the cloned
   * repo root which always exists at startup. Both skip conditions are false in production;
   * claim verification always runs for both engineer and fixer completions.
   */
  private shouldSkipClaimVerification(): boolean {
    return this.skipClaimVerification || !this.projectRootExistedAtStartup;
  }

  /** Returns the single currently-active child agent ID for a chain, if deterministic. */
  private activeChildAgentId(chain: WrfcChain): string | null {
    if (chain.state === 'reviewing') return chain.reviewerAgentId ?? null;
    if (chain.state === 'fixing') return chain.fixerAgentId ?? null;
    if (chain.state === 'engineering') return chain.engineerAgentId ?? null;
    if (chain.state === 'integrating') return chain.integratorAgentId ?? null;
    return null;
  }

  private async onAgentComplete(agentId: string): Promise<void> {
    const chain = this.findChainByAgentId(agentId);
    if (!chain) return;

    if (agentId === chain.ownerAgentId) {
      if (chain.ownerTerminalEmitted) return;
      this.keepOwnerAgentActive(chain, 'Ignored premature owner completion event; WRFC lifecycle is still active');
      this.appendOwnerDecision(
        chain,
        'owner_completion_ignored',
        'Ignored premature owner completion because WRFC owner remains active until the full chain is terminal',
        { agentId },
      );
      logger.warn('WrfcController: ignored premature owner completion before terminal chain state', {
        chainId: chain.id,
        agentId,
        state: chain.state,
      });
      return;
    }

    const record = this.agentManager.getStatus(agentId);
    const rawOutput = record?.fullOutput ?? '';

    logger.debug('WrfcController.onAgentComplete', {
      chainId: chain.id,
      agentId,
      state: chain.state,
      outputLength: rawOutput.length,
    });

    const subtask = this.findSubtaskByAgentId(chain, agentId);
    if (subtask) {
      await this.onCompoundSubtaskAgentComplete(chain, subtask, agentId, rawOutput, record ?? undefined);
      if (this.planManager) {
        completePlanItemsForAgent(agentId, this.planManager);
      }
      return;
    }

    if (agentId === chain.integratorAgentId) {
      const report = parseEngineerCompletionReport(rawOutput, record?.template);
      this.setWrfcWorkPlanTaskStatus(chain, agentId, 'done');
      this.handleIntegratorCompletion(chain, agentId, report);
      if (this.planManager) {
        completePlanItemsForAgent(agentId, this.planManager);
      }
      return;
    }

    if (chain.state === 'pending') {
      chain.bufferedCompletion = { agentId, fullOutput: rawOutput };
      logger.debug('WrfcController.onAgentComplete: chain pending, buffering completion', {
        chainId: chain.id,
        agentId,
      });
      return;
    }

    if (chain.state === 'engineering' || chain.state === 'fixing') {
      const report = parseEngineerCompletionReport(rawOutput, record?.template);
      this.setWrfcWorkPlanTaskStatus(chain, agentId, 'done');
      this.handleEngineerCompletion(chain, agentId, report);
    } else if (chain.state === 'reviewing') {
      const review = parseReviewerCompletionReport(chain.id, rawOutput, getWrfcScoreThreshold(this.configManager));
      chain.reviewerReport = review;
      chain.reviewCycles += 1;
      this.setWrfcWorkPlanTaskStatus(chain, agentId, 'done');
      await this.processReview(chain, review);
    }

    if (this.planManager) {
      completePlanItemsForAgent(agentId, this.planManager);
    }

    if (chain.state === 'gating' || chain.state === 'passed' || chain.state === 'committing') {
      return;
    }
    await this.checkAndRunGatesForAll();
  }

  private onAgentFailed(agentId: string, errorMessage?: string): void {
    const chain = this.findChainByAgentId(agentId);
    if (!chain) return;
    // A non-owner child failure on an already-terminal chain must be a no-op:
    // mirrors onAgentCancelled and prevents duplicate WORKFLOW_CHAIN_FAILED events
    // and passed→failed flips when a late/second child failure arrives.
    if (isChainTerminal(chain.state)) return;
    if (agentId === chain.ownerAgentId) {
      this.keepOwnerAgentActive(chain, 'Ignored premature owner failure event; WRFC lifecycle is still active');
      this.appendOwnerDecision(
        chain,
        'owner_failure_ignored',
        errorMessage
          ? `Ignored premature owner failure before terminal chain state: ${errorMessage}`
          : 'Ignored premature owner failure before terminal chain state',
        { agentId },
      );
      logger.warn('WrfcController: ignored premature owner failure before terminal chain state', {
        chainId: chain.id,
        agentId,
        state: chain.state,
        error: errorMessage,
      });
      return;
    }
    const reason = errorMessage ?? `Agent ${agentId} failed`;
    // A transport-classified failure of the most recently spawned child gets one
    // bounded automatic retry (respawn same role/task) before the chain is failed
    // outright — see retryTransportFailure. Guarding on lastChildSpawn.agentId
    // matching this exact agentId avoids acting on a stale/duplicate failure event
    // for an agent that isn't the chain's current active child.
    if (
      chain.lastChildSpawn?.agentId === agentId &&
      isTransportFailureMessage(reason) &&
      (chain.transportRetryCount ?? 0) < getWrfcTransportRetryLimit(this.configManager)
    ) {
      this.retryTransportFailure(chain, chain.lastChildSpawn, reason);
      return;
    }
    this.setWrfcWorkPlanTaskStatus(chain, agentId, 'failed', reason);
    this.failChain(chain, reason, isTransportFailureMessage(reason) ? 'transport' : 'other');
  }

  /**
   * Respawn the most recently spawned child agent after a transport-classified
   * failure, instead of failing the chain immediately. Bounded by
   * wrfc.transportRetryLimit (default 1) and tracked via chain.transportRetryCount,
   * kept separate from fixAttempts/reviewCycles so a transport blip never counts
   * against the ordinary fix-cycle budget.
   */
  private retryTransportFailure(
    chain: WrfcChain,
    spawn: NonNullable<WrfcChain['lastChildSpawn']>,
    reason: string,
  ): void {
    const limit = getWrfcTransportRetryLimit(this.configManager);
    const delayMs = getWrfcTransportRetryDelayMs(this.configManager);
    chain.transportRetryCount = (chain.transportRetryCount ?? 0) + 1;
    const attempt = chain.transportRetryCount;
    this.appendOwnerDecision(
      chain,
      'transport_retry',
      `Transport failure on ${spawn.role} (attempt ${attempt}/${limit}): ${reason}. Retrying in ${Math.round(delayMs / 1000)}s.`,
      { agentId: spawn.agentId, role: spawn.role },
    );
    logger.warn('WrfcController: transport failure, retrying child agent', {
      chainId: chain.id,
      agentId: spawn.agentId,
      role: spawn.role,
      attempt,
      limit,
      reason,
    });
    const timer = setTimeout(() => {
      // The chain may have reached a terminal state while this retry was waiting
      // (e.g. cancelled) — don't resurrect it.
      if (isChainTerminal(chain.state)) return;
      const record = this.spawnWrfcAgent(chain, spawn.role, spawn.template, spawn.task, spawn.dangerouslyDisableWrfc, spawn.subtaskId);
      this.registerSpawnedChild(chain, record, spawn.role, spawn.subtaskId);
      this.rewireChainChildAgentId(chain, spawn.role, record.id);
    }, delayMs);
    timer.unref?.();
  }

  /** Point the chain's role-specific agent-id field at a freshly (re)spawned child. */
  private rewireChainChildAgentId(
    chain: WrfcChain,
    role: 'engineer' | 'reviewer' | 'fixer' | 'integrator',
    agentId: string,
  ): void {
    switch (role) {
      case 'engineer': chain.engineerAgentId = agentId; break;
      case 'reviewer': chain.reviewerAgentId = agentId; break;
      case 'fixer': chain.fixerAgentId = agentId; break;
      case 'integrator': chain.integratorAgentId = agentId; break;
    }
  }

  private onAgentCancelled(agentId: string, reason?: string): void {
    const chain = this.findChainByAgentId(agentId);
    if (!chain || isChainTerminal(chain.state)) return;
    if (agentId === chain.ownerAgentId) {
      this.setWrfcWorkPlanTaskStatus(chain, agentId, 'cancelled', reason ?? 'WRFC owner agent cancelled');
      this.cancelChain(chain, reason ?? 'WRFC owner agent cancelled');
      return;
    }
    this.setWrfcWorkPlanTaskStatus(chain, agentId, 'cancelled', reason ?? `Agent ${agentId} cancelled`);
    this.failChain(chain, reason ?? `Agent ${agentId} cancelled`);
  }

  private startReview(chain: WrfcChain, report: CompletionReport): void {
    this.transition(chain, 'reviewing');

    // Prepend any synthetic issues from the controller (e.g. fixer constraint-continuity
    // violations) to the review task body, then clear them so they fire only once.
    let reviewTask = buildReviewTask(chain.id, chain.task, report, getWrfcScoreThreshold(this.configManager), this.reviewableConstraints(chain));
    if (chain.syntheticIssues?.length) {
      reviewTask = this.prependSyntheticIssues(chain.syntheticIssues, reviewTask);
      chain.syntheticIssues = [];
    }

    const reviewerRecord = this.spawnWrfcAgent(
      chain,
      'reviewer',
      'reviewer',
      reviewTask,
      true,
    );

    chain.reviewerAgentId = reviewerRecord.id;
    this.registerSpawnedChild(chain, reviewerRecord, 'reviewer');
    chain.currentNodeId = startWrfcOrchestrationNode(
      this.runtimeBus,
      this.sessionId,
      chain.id,
      `review:${chain.reviewCycles + 1}`,
      'reviewer',
      'Reviewer assessment',
      reviewerRecord.id,
    );

    logger.debug('WrfcController.startReview', {
      chainId: chain.id,
      reviewerAgentId: reviewerRecord.id,
    });
    this.appendOwnerDecision(chain, 'spawn_reviewer', this.withRouteReason(
      'Review full current result against the original WRFC ask',
      reviewerRecord,
    ), {
      agentId: reviewerRecord.id,
      role: 'reviewer',
      record: reviewerRecord,
    });
    this.upsertWrfcWorkPlanTask(chain, 'reviewer', reviewerRecord, 'in_progress');
  }

  private async processReview(chain: WrfcChain, review: ReviewerReport): Promise<void> {
    const threshold = getWrfcScoreThreshold(this.configManager);

    const constraintEvaluation = this.evaluateConstraints(chain, review);
    if (constraintEvaluation.ignoredConstraintFindingIds.length > 0) {
      review.issues ??= [];
      review.issues.push({
        severity: 'major',
        description: `Reviewer reported findings for unknown constraints; ignored ids=[${constraintEvaluation.ignoredConstraintFindingIds.join(',')}]`,
        pointValue: 2,
      });
      logger.warn('WrfcController: ignored unknown constraint findings', {
        chainId: chain.id,
        ignoredConstraintFindingIds: constraintEvaluation.ignoredConstraintFindingIds,
      });
    }
    const {
      constraintsSatisfied,
      constraintsTotal,
      unsatisfiedConstraintIds,
      constraintFailure,
    } = constraintEvaluation;
    // MIN-4: claimsVerified===false is a mechanical block — cannot pass review regardless of score.
    const passed = review.score >= threshold && !constraintFailure && chain.claimsVerified !== false;

    this.completeCurrentNode(chain, `Score ${review.score}/10${passed ? ' passed' : ' needs fixes'}`);

    emitWorkflowReviewCompleted(this.runtimeBus, createWrfcWorkflowContext(this.sessionId, chain.id), {
      chainId: chain.id,
      score: review.score,
      passed,
      ...(chain.constraints.length > 0
        ? {
            constraintsSatisfied,
            constraintsTotal,
            unsatisfiedConstraintIds,
          }
        : {}),
    });

    this.workmap.append({
      ts: new Date().toISOString(),
      wrfcId: chain.id,
      event: 'review_complete',
      agentId: chain.reviewerAgentId,
      score: review.score,
      passed,
      issues: review.issues?.slice(0, 10).map((issue) => ({
        severity: issue.severity,
        description: issue.description,
        file: issue.file,
      })),
    });

    logger.debug('WrfcController.processReview', {
      chainId: chain.id,
      score: review.score,
      threshold,
      fixAttempts: chain.fixAttempts,
      constraintFailure,
      unsatisfiedCount: unsatisfiedConstraintIds.length,
    });

    chain.reviewScores.push(review.score);
    if (passed) {
      this.appendOwnerDecision(chain, 'review_passed', `Review score ${review.score}/10 met threshold ${threshold}/10`, {
        agentId: chain.reviewerAgentId,
        role: 'reviewer',
        reviewScore: review.score,
      });
      this.transition(chain, 'awaiting_gates');
      await this.checkAndRunGatesForAll();
      return;
    }

    const scores = chain.reviewScores;
    if (scores.length >= 3) {
      const initial = scores[0]!;
      const lastTwo = scores.slice(-2);
      if (lastTwo[0]! < initial && lastTwo[1]! < initial) {
        emitWrfcScoreRegression(
          this.runtimeBus,
          this.sessionId,
          chain.id,
          `Score regression warning: initial ${initial}/10, last two ${lastTwo[0]}/10, ${lastTwo[1]}/10 — both below initial. Fix quality may be degrading.`,
        );
      }
    }

    const maxFixAttempts = getWrfcMaxFixAttempts(this.configManager);
    if (chain.fixAttempts >= maxFixAttempts) {
      const attemptsLabel = `${chain.fixAttempts} fix attempt${chain.fixAttempts !== 1 ? 's' : ''}`;
      const failureReason =
        chain.claimsVerified === false && review.score >= threshold && !constraintFailure
          ? `Engineer/fixer claims could not be verified on disk (suspected phantom work) after ${attemptsLabel}`
          : constraintFailure && review.score >= threshold
            ? `Unsatisfied constraints [${unsatisfiedConstraintIds.join(',')}] after ${attemptsLabel}`
            : `Score ${review.score}/10 below threshold ${threshold}/10 after ${attemptsLabel} — below threshold`;
      this.failChain(
        chain,
        failureReason,
      );
      return;
    }

    this.appendOwnerDecision(chain, 'review_failed', `Review score ${review.score}/10 did not pass full-scope WRFC review`, {
      agentId: chain.reviewerAgentId,
      role: 'reviewer',
      reviewScore: review.score,
    });
    this.startFix(chain, review);
  }

  private startFix(chain: WrfcChain, review: ReviewerReport): void {
    chain.fixAttempts += 1;
    this.transition(chain, 'fixing');

    const maxAttempts = getWrfcMaxFixAttempts(this.configManager);
    const targetConstraintIds = this.evaluateConstraints(chain, review).unsatisfiedConstraintIds;
    emitWorkflowFixAttempted(this.runtimeBus, createWrfcWorkflowContext(this.sessionId, chain.id), {
      chainId: chain.id,
      attempt: chain.fixAttempts,
      maxAttempts,
      ...(targetConstraintIds.length > 0 ? { targetConstraintIds } : {}),
    });

    const fixerRecord = this.spawnWrfcAgent(
      chain,
      'fixer',
      'engineer',
      buildFixTask(
        chain.id,
        chain.task,
        review,
        getWrfcScoreThreshold(this.configManager),
        chain.fixAttempts,
        chain.constraints,
        review.constraintFindings ?? [],
      ),
      true,
    );

    chain.fixerAgentId = fixerRecord.id;
    this.registerSpawnedChild(chain, fixerRecord, 'fixer');
    chain.currentNodeId = startWrfcOrchestrationNode(
      this.runtimeBus,
      this.sessionId,
      chain.id,
      `fix:${chain.fixAttempts}`,
      'fixer',
      `Fix attempt ${chain.fixAttempts}`,
      fixerRecord.id,
    );

    this.workmap.append({
      ts: new Date().toISOString(),
      wrfcId: chain.id,
      event: 'fix_started',
      agentId: fixerRecord.id,
      attempt: chain.fixAttempts,
    });

    logger.debug('WrfcController.startFix', {
      chainId: chain.id,
      fixerAgentId: fixerRecord.id,
      attempt: chain.fixAttempts,
    });
    this.appendOwnerDecision(chain, 'spawn_fixer', this.withRouteReason(
      'Fix review findings while preserving the full original WRFC ask',
      fixerRecord,
    ), {
      agentId: fixerRecord.id,
      role: 'fixer',
      record: fixerRecord,
    });
    this.upsertWrfcWorkPlanTask(chain, 'fixer', fixerRecord, 'in_progress');
  }

  private async runGates(chain: WrfcChain): Promise<QualityGateResult[]> {
    this.transition(chain, 'gating');
    chain.currentNodeId = startWrfcOrchestrationNode(
      this.runtimeBus,
      this.sessionId,
      chain.id,
      `gate:${chain.reviewCycles}:${chain.fixAttempts}`,
      'verifier',
      'Quality gates',
    );

    return runWrfcGateChecks({
      configManager: this.configManager,
      projectRoot: this.projectRoot,
      runtimeBus: this.runtimeBus,
      sessionId: this.sessionId,
      chainId: chain.id,
      onResult: (results) => {
        chain.gateResults = results.slice();
      },
    });
  }

  private evaluateConstraintSet(
    allConstraints: readonly Constraint[],
    review: ReviewerReport,
    systemUnsatisfiableIds: readonly string[] = [],
  ): ConstraintEvaluation {
    // System-unsatisfiable constraints (e.g. a "separate agent per file" constraint
    // that a fan-out collapse invalidated) are removed from the rubric BEFORE
    // accounting: they can never be counted as unsatisfied and can never force a
    // failure, because no fix agent can satisfy a constraint whose precondition the
    // system itself removed. This is the un-loopable guarantee (WO UX-A item 1c).
    const excluded = systemUnsatisfiableIds.length > 0 ? new Set(systemUnsatisfiableIds) : null;
    const constraints = excluded
      ? allConstraints.filter((constraint) => !excluded.has(constraint.id))
      : allConstraints;
    if (constraints.length === 0) {
      return {
        constraintsSatisfied: 0,
        constraintsTotal: 0,
        unsatisfiedConstraintIds: [],
        ignoredConstraintFindingIds: [],
        constraintFailure: false,
      };
    }

    const expectedIds = new Set(constraints.map((constraint) => constraint.id));
    const findingMap = new Map<string, NonNullable<ReviewerReport['constraintFindings']>[number]>();
    const ignoredConstraintFindingIds: string[] = [];
    for (const finding of review.constraintFindings ?? []) {
      if (!expectedIds.has(finding.constraintId)) {
        // A finding for a system-unsatisfiable constraint is known-but-excluded, not
        // unknown: drop it silently instead of injecting a "reviewed an unknown
        // constraint" penalty.
        if (excluded?.has(finding.constraintId)) continue;
        ignoredConstraintFindingIds.push(finding.constraintId);
        continue;
      }
      if (!findingMap.has(finding.constraintId)) {
        findingMap.set(finding.constraintId, finding);
      }
    }

    let constraintsSatisfied = 0;
    const unsatisfiedConstraintIds: string[] = [];
    for (const constraint of constraints) {
      const finding = findingMap.get(constraint.id);
      if (finding?.satisfied === true) {
        constraintsSatisfied += 1;
      } else {
        unsatisfiedConstraintIds.push(constraint.id);
      }
    }

    return {
      constraintsSatisfied,
      constraintsTotal: constraints.length,
      unsatisfiedConstraintIds,
      ignoredConstraintFindingIds,
      constraintFailure: unsatisfiedConstraintIds.length > 0,
    };
  }

  private evaluateConstraints(chain: WrfcChain, review: ReviewerReport): ConstraintEvaluation {
    return this.evaluateConstraintSet(chain.constraints, review, chain.systemUnsatisfiableConstraintIds ?? []);
  }

  /**
   * The constraints a reviewer/fixer is asked to verify: the full enumerated set
   * MINUS the ones a system action (a fan-out collapse) made unsatisfiable. Keeping
   * chain.constraints itself intact preserves fixer constraint-continuity checks;
   * only the rubric handed to review/gate-fix is narrowed.
   */
  private reviewableConstraints(chain: WrfcChain): Constraint[] {
    const excluded = chain.systemUnsatisfiableConstraintIds;
    if (!excluded || excluded.length === 0) return chain.constraints;
    const excludedSet = new Set(excluded);
    return chain.constraints.filter((constraint) => !excludedSet.has(constraint.id));
  }

  private evaluateSubtaskConstraints(subtask: WrfcSubtask, review: ReviewerReport): ConstraintEvaluation {
    return this.evaluateConstraintSet(subtask.constraints, review);
  }

  private async processGateResults(chain: WrfcChain, results: QualityGateResult[]): Promise<void> {
    if (!chain.currentNodeId?.includes(':gate:')) {
      chain.currentNodeId = startWrfcOrchestrationNode(
        this.runtimeBus,
        this.sessionId,
        chain.id,
        `gate:${chain.reviewCycles}:${chain.fixAttempts}`,
        'verifier',
        'Quality gates',
      );
    }

    const allPassed = results.length === 0 || results.every((result) => result.passed);
    const autoCommit = getWrfcAutoCommit(this.configManager);
    for (const result of results) {
      this.workmap.append({
        ts: new Date().toISOString(),
        wrfcId: chain.id,
        event: 'gate_result',
        gate: result.gate,
        passed: result.passed,
        gateOutput: result.output.slice(0, 200),
      });
    }
    this.completeCurrentNode(
      chain,
      allPassed
        ? 'All quality gates passed'
        : `${results.filter((result) => !result.passed).length} quality gate(s) failed`,
    );

    if (allPassed) {
      this.workmap.append({ ts: new Date().toISOString(), wrfcId: chain.id, event: 'chain_passed' });
      chain.gatesPassed = true;
      this.appendOwnerDecision(chain, 'gate_passed', 'All configured WRFC quality gates passed');
      if (autoCommit) {
        await this.autoCommit(chain);
      } else {
        this.completeChainAsPassed(chain);
      }
      return;
    }

    const failedGates = results.filter((result) => !result.passed);
    const maxGateRetries = getWrfcMaxFixAttempts(this.configManager);
    this.appendOwnerDecision(chain, 'gate_failed', `${failedGates.length} quality gate(s) failed and require same-chain fixing`);

    if (chain.fixAttempts >= maxGateRetries) {
      logger.error('WrfcController.processGateResults: gate retry limit reached, manual intervention required', {
        chainId: chain.id,
        fixAttempts: chain.fixAttempts,
        maxGateRetries,
      });
      emitWrfcCascadeAbort(
        this.runtimeBus,
        this.sessionId,
        chain.id,
        `Gate failures exceeded max retries (${chain.fixAttempts}/${maxGateRetries}). Manual intervention required.`,
      );
      this.failChain(chain, `Gate failures exceeded max retries (${chain.fixAttempts}/${maxGateRetries})`);
      return;
    }

    chain.fixAttempts += 1;
    this.transition(chain, 'fixing');
    emitWorkflowFixAttempted(this.runtimeBus, createWrfcWorkflowContext(this.sessionId, chain.id), {
      chainId: chain.id,
      attempt: chain.fixAttempts,
      maxAttempts: maxGateRetries,
      ...((() => {
        const reviewable = this.reviewableConstraints(chain);
        return reviewable.length > 0 ? { targetConstraintIds: reviewable.map((constraint) => constraint.id) } : {};
      })()),
    });

    const gateFixTask = buildGateFailureTask(chain.id, chain.task, failedGates, this.reviewableConstraints(chain));
    const fixerRecord = this.spawnWrfcAgent(chain, 'fixer', 'engineer', gateFixTask, true);
    chain.fixerAgentId = fixerRecord.id;
    this.registerSpawnedChild(chain, fixerRecord, 'fixer');
    chain.currentNodeId = startWrfcOrchestrationNode(
      this.runtimeBus,
      this.sessionId,
      chain.id,
      `fix:${chain.fixAttempts}:gates`,
      'fixer',
      `Gate fix attempt ${chain.fixAttempts}`,
      fixerRecord.id,
    );

    this.workmap.append({
      ts: new Date().toISOString(),
      wrfcId: chain.id,
      event: 'fix_started',
      agentId: fixerRecord.id,
      attempt: chain.fixAttempts,
      gate: failedGates.map((gate) => gate.gate).join(', '),
    });

    logger.debug('WrfcController.processGateResults: gate failure — spawned same-chain fixer', {
      chainId: chain.id,
      fixerAgentId: fixerRecord.id,
    });
    this.appendOwnerDecision(chain, 'spawn_gate_fixer', this.withRouteReason(
      'Fix failed quality gates in the same WRFC owner chain',
      fixerRecord,
    ), {
      agentId: fixerRecord.id,
      role: 'fixer',
      record: fixerRecord,
    });
    this.upsertWrfcWorkPlanTask(chain, 'fixer', fixerRecord, 'in_progress');
  }

  private scheduleChainCleanup(chain: WrfcChain): void {
    const timer = setTimeout(() => {
      if (isChainTerminal(chain.state)) {
        this.chains.delete(chain.id);
      }
    }, CHAIN_CLEANUP_DELAY_MS);
    timer.unref?.();
  }

  private async checkAndRunGatesForAll(): Promise<void> {
    const allChains = Array.from(this.chains.values()).filter(
      (chain) => !isChainTerminal(chain.state),
    );
    const activeWorkChains = allChains.filter((chain) => (
      chain.state === 'pending'
      || chain.state === 'engineering'
      || chain.state === 'integrating'
      || chain.state === 'reviewing'
      || chain.state === 'fixing'
    ));

    if (activeWorkChains.length > 0) {
      logger.debug('WrfcController.checkAndRunGatesForAll: waiting for active chains', {
        activeWork: activeWorkChains.length,
        awaitingGates: allChains.filter((chain) => chain.state === 'awaiting_gates').length,
      });
      return;
    }

    const readyChains = allChains.filter((chain) => chain.state === 'awaiting_gates');
    if (readyChains.length === 0) return;

    logger.debug('WrfcController.checkAndRunGatesForAll: all chains ready, running gates', {
      readyCount: readyChains.length,
    });

    const gateRunner = readyChains[0]!;
    const results = await this.runGates(gateRunner);
    const allGatesPassed = results.length === 0 || results.every((r) => r.passed);

    if (allGatesPassed) {
      // All gates passed: process each waiting chain so it can commit/pass.
      for (const chain of readyChains) {
        if (chain.id !== gateRunner.id) {
          this.transition(chain, 'gating');
          chain.gateResults = results;
        }
        await this.processGateResults(chain, results);
      }
    } else {
      // Gate failure: spawn exactly ONE fixer (for the gateRunner). Non-owner chains
      // stay in awaiting_gates — they will be committed/passed once the gateRunner's
      // fix→review cycle eventually brings gates back to passing.
      for (const chain of readyChains) {
        if (chain.id !== gateRunner.id) {
          chain.gateResults = results; // record for reporting; state stays awaiting_gates
        }
      }
      await this.processGateResults(gateRunner, results);
    }
  }

  private async autoCommit(chain: WrfcChain): Promise<void> {
    this.transition(chain, 'committing');

    const commitScope = getWrfcCommitScope(this.configManager);
    if (commitScope === 'off') {
      logger.debug('WrfcController.autoCommit: wrfc.commitScope is off, skipping commit and merge entirely', {
        chainId: chain.id,
      });
      this.completeChainAsPassed(chain);
      return;
    }

    const commitCandidateIds = this.autoCommitCandidateAgentIds(chain);
    if (commitCandidateIds.length === 0) {
      // A structurally odd chain (no engineer/fixer/integrator) cannot be auto-committed, but the
      // full-scope review and gates already passed — that is what determines success. Surface the
      // miss as a warning on a passing chain rather than flipping a green chain to FAILED.
      logger.warn('WrfcController.autoCommit: no write-capable WRFC agent found on chain; skipping commit', {
        chainId: chain.id,
      });
      this.completeChainAsPassed(chain, 'commit skipped: no write-capable WRFC agent on chain');
      return;
    }

    if (!existsSync(join(this.projectRoot, '.git'))) {
      logger.debug('WrfcController.autoCommit: not a git repo, skipping commit', { chainId: chain.id });
      this.completeChainAsPassed(chain, 'commit skipped: not a git repository');
      return;
    }

    const worktree = this.createWorktree();
    try {
      const commitMessage = this.buildAutoCommitMessage(chain, commitScope);
      let commitResult: CommitWorkingTreeResult = { hash: null, skippedIgnored: [] };
      let ledgerEmpty = false;
      if (worktree.commitWorkingTree) {
        if (commitScope === 'scoped') {
          const touchedPaths = this.collectChainTouchedPaths(chain);
          if (touchedPaths.length === 0) {
            // Do NOT fall back to a full-tree `--all` sweep here — an empty self-reported
            // ledger means we genuinely don't know what this chain touched, and committing
            // everything dirty in the working tree is exactly the trust bug this fixes.
            ledgerEmpty = true;
            logger.warn('WrfcController.autoCommit: commitScope is scoped but the chain edit ledger is empty; skipping commit rather than falling back to a full-tree sweep', {
              chainId: chain.id,
            });
          } else {
            commitResult = await worktree.commitWorkingTree(commitMessage, touchedPaths);
          }
        } else {
          // commitScope === 'all': legacy full-tree sweep, no paths argument.
          commitResult = await worktree.commitWorkingTree(commitMessage);
        }
      }
      let mergedCount = 0;
      for (const agentId of commitCandidateIds) {
        if (await worktree.merge(agentId)) {
          mergedCount += 1;
        }
      }
      const headHash = mergedCount > 0 && worktree.currentHead ? await worktree.currentHead() : commitResult.hash;
      emitWrfcAutoCommitted(this.runtimeBus, this.sessionId, chain.id, headHash ?? undefined);
      const commitNote = this.describeCommitOutcome(headHash, commitResult.skippedIgnored, ledgerEmpty);
      this.completeChainAsPassed(chain, commitNote);
      logger.debug('WrfcController.autoCommit: success', {
        chainId: chain.id,
        commitCandidateIds,
        commitHash: commitResult.hash,
        skippedIgnored: commitResult.skippedIgnored,
        mergedCount,
        headHash,
      });
    } catch (error) {
      const reason = summarizeError(error);
      // Non-fatal: the full-scope review and quality gates already passed, so the chain SUCCEEDED.
      // A commit that could not complete (permissions, a rejecting hook, a dirty/locked index) is a
      // warning on a passing chain, never a flip to FAILED. AgentWorktree.commitWorkingTree already
      // reset the paths it staged before rethrowing, so the user's staging area is left clean.
      logger.warn('WrfcController.autoCommit: commit did not complete; completing chain as passed with a warning', {
        chainId: chain.id,
        error: reason,
      });
      this.completeChainAsPassed(chain, `commit failed (non-fatal): ${reason}`);
    } finally {
      // The chain has completed (passed) on every path above, so every agent's worktree can be
      // released regardless of whether the commit succeeded.
      for (const id of chain.allAgentIds) {
        worktree.cleanup(id).catch((error) => {
          logger.warn('WrfcController.autoCommit: cleanup failed', {
            agentId: id,
            error: summarizeError(error),
          });
        });
      }
    }
  }

  /**
   * Render the commit outcome as an honest, single-line note for the chain-completion message.
   * Distinguishes a real commit (with any gitignored paths that were skipped) from the several
   * "nothing was committed" cases, so the completion message states the commit result plainly
   * instead of implying a commit happened when it did not.
   */
  private describeCommitOutcome(headHash: string | null, skippedIgnored: readonly string[], ledgerEmpty: boolean): string {
    const ignoredNote = skippedIgnored.length > 0
      ? `${skippedIgnored.length} ignored path${skippedIgnored.length === 1 ? '' : 's'} skipped`
      : null;
    if (headHash) {
      const shortHash = headHash.slice(0, 8);
      return ignoredNote ? `committed ${shortHash} (${ignoredNote})` : `committed ${shortHash}`;
    }
    if (ignoredNote) return `commit skipped: ${ignoredNote}`;
    if (ledgerEmpty) return 'commit skipped: chain edit ledger empty';
    return 'commit skipped: nothing to stage';
  }

  private autoCommitCandidateAgentIds(chain: WrfcChain): string[] {
    const candidates: string[] = [];

    const add = (agentId: string | undefined): void => {
      if (agentId && !candidates.includes(agentId)) candidates.push(agentId);
    };

    if (chain.subtasks && chain.subtasks.length > 0) {
      for (const subtask of chain.subtasks) {
        add(subtask.fixerAgentId ?? subtask.engineerAgentId);
      }
      add(chain.integratorAgentId);
      return candidates;
    }

    add(chain.fixerAgentId ?? chain.engineerAgentId);
    add(chain.integratorAgentId);
    if (candidates.length > 0) {
      return candidates;
    }

    const writeRoles = new Set(['engineer', 'fixer', 'integrator']);
    for (const agentId of chain.allAgentIds) {
      const role = this.resolveWrfcRole(chain, agentId);
      if (role && writeRoles.has(role)) add(agentId);
    }
    return candidates;
  }

  /**
   * Chain-wide "own edit ledger": every path self-reported as created/modified/deleted by
   * any engineer/fixer/integrator completion on this chain (including subtask completions),
   * deduplicated. Primary source is chain.touchedPaths, an incremental accumulator appended
   * to on every completion (see recordTouchedPaths) so fixer/re-fix passes and resumed
   * chains are represented, not just the first pass. Falls back to deriving from the
   * last-stored report slots (chain.engineerReport / chain.integratorReport /
   * subtask.engineerReport) for chains serialized before touchedPaths existed.
   *
   * Self-reported, not ground truth — same accuracy ceiling as verifyEngineerClaims. Per-agent
   * worktree isolation (AgentWorktree.create) is not wired up in this controller today, so
   * there is no git-branch-diff signal to corroborate against.
   */
  private collectChainTouchedPaths(chain: WrfcChain): string[] {
    const paths = new Set<string>(chain.touchedPaths ?? []);
    const fallbackReports: Array<CompletionReport | undefined> = [
      chain.engineerReport,
      chain.integratorReport,
      ...(chain.subtasks ?? []).map((subtask) => subtask.engineerReport),
    ];
    for (const report of fallbackReports) {
      if (report && report.archetype === 'engineer') {
        const engineerReport = report as EngineerReport;
        for (const path of [...engineerReport.filesCreated, ...engineerReport.filesModified, ...engineerReport.filesDeleted]) {
          paths.add(path);
        }
      }
    }
    return Array.from(paths);
  }

  private buildAutoCommitMessage(chain: WrfcChain, commitScope: WrfcCommitScope): string {
    const fullTask = chain.task.trim();
    const firstLine = fullTask.replace(/\s+/g, ' ').slice(0, 72) || chain.id;
    const subject = `WRFC: ${firstLine}`;

    // Subject is length-capped for git log readability; the body below is never truncated —
    // this is the fix for the "anything past 72 characters is silently discarded" bug.
    const bodyLines: string[] = ['', fullTask || chain.id];

    if (chain.constraints.length > 0) {
      bodyLines.push('', `Constraints: ${chain.constraints.length}`);
    }
    const gateNames = (chain.gateResults ?? []).map((result) => result.gate);
    if (gateNames.length > 0) {
      bodyLines.push(`Gates: ${gateNames.join(', ')}`);
    }
    if (chain.subtasks && chain.subtasks.length > 0) {
      bodyLines.push(`Subtasks: ${chain.subtasks.map((subtask) => subtask.title).join('; ')}`);
    }
    if (commitScope === 'scoped') {
      const touchedPaths = this.collectChainTouchedPaths(chain);
      bodyLines.push(touchedPaths.length > 0
        ? `Staged paths (${touchedPaths.length}): ${touchedPaths.join(', ')}`
        : 'Staged paths: (none — chain edit ledger empty)');
    }

    return [subject, ...bodyLines].join('\n');
  }

  private failChain(chain: WrfcChain, reason: string, failureKind: NonNullable<WrfcChain['failureKind']> = 'other'): void {
    if (chain.state === 'pending') {
      this.chainQueue = this.chainQueue.filter((queued) => queued.record.id !== chain.ownerAgentId);
    }

    const wasActive = isChainActive(chain.state);
    this.failCurrentNode(chain, reason);
    for (const subtask of chain.subtasks ?? []) {
      if (subtask.currentNodeId) {
        failWrfcOrchestrationNode(this.runtimeBus, this.sessionId, chain.id, subtask.currentNodeId, reason);
        subtask.currentNodeId = undefined;
      }
    }
    try {
      this.transition(chain, 'failed');
    } catch {
      chain.state = 'failed';
    }

    if (wasActive) {
      this.activeChainCount = Math.max(0, this.activeChainCount - 1);
    }

    chain.error = reason;
    chain.failureKind = failureKind;
    chain.completedAt = Date.now();
    this.setWrfcWorkPlanTaskStatus(chain, chain.ownerAgentId, 'failed', reason);
    this.cancelRunningChildren(chain);
    this.appendOwnerDecision(chain, 'chain_failed', reason, {
      agentId: chain.ownerAgentId,
    });
    this.completeOwnerAgent(chain, 'failed', reason);
    this.workmap.append({ ts: new Date().toISOString(), wrfcId: chain.id, event: 'chain_failed', reason });
    emitWorkflowChainFailed(this.runtimeBus, createWrfcWorkflowContext(this.sessionId, chain.id), { chainId: chain.id, reason, failureKind });

    logger.error('WrfcController.failChain', { chainId: chain.id, reason });
    this.scheduleChainCleanup(chain);
    this.safeDequeueNext();
    // Orphan safety: re-promote a gate-runner for any chains still in awaiting_gates
    // after this chain terminally fails (e.g. gate-retry exhaustion or fixer failure).
    this.safeCheckAndRunGatesForAll();
  }

  private cancelRunningChildren(chain: WrfcChain): void {
    for (const agentId of chain.allAgentIds) {
      if (agentId === chain.ownerAgentId) continue;
      const record = this.agentManager.getStatus(agentId);
      if (isAgentInFlight(record)) {
        this.agentManager.cancel(agentId);
      }
    }
  }

  private hasRunningChild(chain: WrfcChain): boolean {
    return chain.allAgentIds.some((agentId) => {
      if (agentId === chain.ownerAgentId) return false;
      const record = this.agentManager.getStatus(agentId);
      return isAgentInFlight(record);
    });
  }

  private cancelChain(chain: WrfcChain, reason: string): void {
    if (chain.state === 'pending') {
      this.chainQueue = this.chainQueue.filter((queued) => queued.record.id !== chain.ownerAgentId);
    }

    const wasActive = chain.state !== 'pending';
    this.failCurrentNode(chain, reason);
    try {
      this.transition(chain, 'failed');
    } catch {
      chain.state = 'failed';
    }
    if (wasActive) {
      this.activeChainCount = Math.max(0, this.activeChainCount - 1);
    }

    chain.error = reason;
    chain.completedAt = Date.now();
    chain.ownerTerminalEmitted = true;
    this.setWrfcWorkPlanTaskStatus(chain, chain.ownerAgentId, 'cancelled', reason);
    this.appendOwnerDecision(chain, 'chain_cancelled', reason, {
      agentId: chain.ownerAgentId,
    });
    const owner = this.agentManager.getStatus(chain.ownerAgentId);
    if (isAgentInFlight(owner)) {
      owner.status = 'cancelled';
      owner.completedAt = Date.now();
      owner.progress = reason;
    }
    this.cancelRunningChildren(chain);
    this.workmap.append({ ts: new Date().toISOString(), wrfcId: chain.id, event: 'chain_failed', reason });
    emitWorkflowChainFailed(this.runtimeBus, createWrfcWorkflowContext(this.sessionId, chain.id), { chainId: chain.id, reason });
    logger.warn('WrfcController.cancelChain', { chainId: chain.id, reason });
    this.scheduleChainCleanup(chain);
    this.safeDequeueNext();
  }

  private async dequeueNext(): Promise<void> {
    if (this.chainQueue.length === 0 || this.activeChainCount >= MAX_ACTIVE_CHAINS) return;

    const queued = this.chainQueue.shift()!;
    const chain = this.chains.get(queued.record.wrfcId ?? '');
    if (!chain) {
      logger.warn('WrfcController.dequeueNext: queued chain not found, discarding', {
        agentId: queued.record.id,
      });
      return;
    }

    logger.debug('WrfcController.dequeueNext: starting queued chain', {
      chainId: chain.id,
      agentId: queued.record.id,
      waitedMs: Date.now() - queued.queuedAt,
    });
    this.startEngineeringChain(chain, false);

    if (!chain.bufferedCompletion) return;
    const buffered = chain.bufferedCompletion;
    chain.bufferedCompletion = undefined;
    await this.onAgentComplete(buffered.agentId);
  }

  private findChainByAgentId(agentId: string): WrfcChain | null {
    for (const chain of this.chains.values()) {
      if (chain.allAgentIds.includes(agentId)) return chain;
    }
    return null;
  }

  private generateWrfcId(): string { return `wrfc-${crypto.randomUUID().slice(0, 8)}`; }

  private generateDecisionId(): string { return `wrfc-decision-${crypto.randomUUID().slice(0, 8)}`; }

  private appendOwnerDecision(
    chain: WrfcChain,
    action: WrfcOwnerDecisionAction,
    reason: string,
    details: {
      readonly agentId?: string | undefined;
      readonly role?: Exclude<WrfcOwnerDecision['role'], undefined> | undefined;
      readonly record?: AgentRecord | undefined;
      readonly reviewScore?: number | undefined;
    } = {},
  ): void {
    const record = details.record ?? (details.agentId ? this.agentManager.getStatus(details.agentId) ?? undefined : undefined);
    const decision: WrfcOwnerDecision = {
      id: this.generateDecisionId(),
      ts: new Date().toISOString(),
      action,
      state: chain.state,
      reason,
      ...(details.agentId ? { agentId: details.agentId } : {}),
      ...(details.role ? { role: details.role } : {}),
      ...(record?.model ? { model: record.model } : {}),
      ...(record?.provider ? { provider: record.provider } : {}),
      ...(record?.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
      ...(typeof details.reviewScore === 'number' ? { reviewScore: details.reviewScore } : {}),
    };
    chain.ownerDecisions.push(decision);
    this.workmap.append({
      ts: decision.ts,
      wrfcId: chain.id,
      event: 'owner_decision',
      action,
      state: chain.state,
      reason,
      ...(decision.agentId ? { agentId: decision.agentId } : {}),
      ...(decision.role ? { role: decision.role } : {}),
      ...(decision.model ? { model: decision.model } : {}),
      ...(decision.provider ? { provider: decision.provider } : {}),
      ...(decision.reasoningEffort ? { reasoningEffort: decision.reasoningEffort } : {}),
      ...(typeof decision.reviewScore === 'number' ? { score: decision.reviewScore } : {}),
    });
  }

  private completeCurrentNode(chain: WrfcChain, summary?: string): void {
    if (!chain.currentNodeId) return;
    completeWrfcOrchestrationNode(this.runtimeBus, this.sessionId, chain.id, chain.currentNodeId, summary);
    chain.currentNodeId = undefined;
  }

  private failCurrentNode(chain: WrfcChain, error: string): void {
    if (!chain.currentNodeId) return;
    failWrfcOrchestrationNode(this.runtimeBus, this.sessionId, chain.id, chain.currentNodeId, error);
    chain.currentNodeId = undefined;
  }

  private completeSubtaskNode(chain: WrfcChain, subtask: WrfcSubtask, summary?: string): void {
    if (!subtask.currentNodeId) return;
    completeWrfcOrchestrationNode(this.runtimeBus, this.sessionId, chain.id, subtask.currentNodeId, summary);
    subtask.currentNodeId = undefined;
  }

  private createBaseChain(ownerRecord: AgentRecord): WrfcChain {
    const subtasks = (ownerRecord.wrfcSubtasks ?? [])
      .filter((task) => typeof task.task === 'string' && task.task.trim().length > 0)
      .map<WrfcSubtask>((task, index) => ({
        id: `deliverable-${index + 1}`,
        title: task.task.trim().slice(0, 80),
        task: task.task.trim(),
        state: 'pending',
        fixAttempts: 0,
        reviewCycles: 0,
        reviewScores: [],
        constraints: [],
        constraintsEnumerated: false,
      }));
    const chain: WrfcChain = {
      id: this.generateWrfcId(),
      state: 'pending',
      task: ownerRecord.task,
      ownerAgentId: ownerRecord.id,
      allAgentIds: [ownerRecord.id],
      fixAttempts: 0,
      reviewCycles: 0,
      reviewScores: [],
      ownerDecisions: [],
      ownerTerminalEmitted: false,
      constraints: [],
      constraintsEnumerated: false,
      touchedPaths: [],
      createdAt: Date.now(),
      transportRetryCount: 0,
      ...(subtasks.length > 1 ? { subtasks } : {}),
      ...(ownerRecord.fanoutCollapse ? { fanoutCollapse: ownerRecord.fanoutCollapse } : {}),
    };
    this.chains.set(chain.id, chain);
    emitWrfcGraphCreated(this.runtimeBus, this.sessionId, chain.id, `WRFC: ${ownerRecord.task}`);
    this.applyWrfcAgentMetadata(chain, ownerRecord, 'owner');
    this.keepOwnerAgentActive(chain);
    this.messageBus.registerAgent({
      agentId: ownerRecord.id,
      template: ownerRecord.template,
      wrfcId: chain.id,
    });
    this.appendOwnerDecision(chain, 'chain_created', 'WRFC owner created for original ask', {
      agentId: ownerRecord.id,
    });
    this.upsertWrfcWorkPlanTask(chain, 'owner', ownerRecord, 'pending');
    return chain;
  }

  private startEngineeringChain(chain: WrfcChain, emitCreated: boolean): void {
    if (chain.subtasks && chain.subtasks.length > 1) {
      this.startCompoundEngineeringChain(chain, emitCreated);
      return;
    }
    this.activeChainCount += 1;
    this.transition(chain, 'engineering');
    this.setWrfcWorkPlanTaskStatus(chain, chain.ownerAgentId, 'in_progress');
    const engineerRecord = this.spawnWrfcAgent(
      chain,
      'engineer',
      'engineer',
      chain.task,
      true,
    );
    chain.engineerAgentId = engineerRecord.id;
    this.registerSpawnedChild(chain, engineerRecord, 'engineer');
    chain.currentNodeId = startWrfcOrchestrationNode(
      this.runtimeBus,
      this.sessionId,
      chain.id,
      `engineer:${chain.fixAttempts}`,
      'engineer',
      'Engineer implementation',
      engineerRecord.id,
    );
    if (emitCreated) {
      emitWrfcChainCreated(this.runtimeBus, this.sessionId, chain.id, chain.task);
    }
    this.appendOwnerDecision(chain, 'spawn_engineer', this.withRouteReason(
      'Start WRFC implementation child for the original ask',
      engineerRecord,
    ), {
      agentId: engineerRecord.id,
      role: 'engineer',
      record: engineerRecord,
    });
    this.upsertWrfcWorkPlanTask(chain, 'engineer', engineerRecord, 'in_progress');
  }

  private startCompoundEngineeringChain(chain: WrfcChain, emitCreated: boolean): void {
    this.activeChainCount += 1;
    this.transition(chain, 'engineering');
    this.setWrfcWorkPlanTaskStatus(chain, chain.ownerAgentId, 'in_progress');
    if (emitCreated) {
      emitWrfcChainCreated(this.runtimeBus, this.sessionId, chain.id, chain.task);
    }
    this.appendOwnerDecision(
      chain,
      'compound_started',
      `Compound WRFC owner supervising ${chain.subtasks?.length ?? 0} deliverables under one chain`,
      { agentId: chain.ownerAgentId },
    );
    for (const subtask of chain.subtasks ?? []) {
      subtask.state = 'engineering';
      const engineerRecord = this.spawnWrfcAgent(
        chain,
        'engineer',
        'engineer',
        this.buildSubtaskEngineerTask(chain, subtask),
        true,
        subtask.id,
      );
      subtask.engineerAgentId = engineerRecord.id;
      this.registerSpawnedChild(chain, engineerRecord, 'engineer', subtask.id);
      subtask.currentNodeId = startWrfcOrchestrationNode(
        this.runtimeBus,
        this.sessionId,
        chain.id,
        `subtask:${subtask.id}:engineer:0`,
        'engineer',
        `Engineer ${subtask.title}`,
        engineerRecord.id,
      );
      this.appendOwnerDecision(chain, 'spawn_engineer', this.withRouteReason(
        `Start compound WRFC engineer child for ${subtask.id}`,
        engineerRecord,
      ), {
        agentId: engineerRecord.id,
        role: 'engineer',
        record: engineerRecord,
      });
      this.upsertWrfcWorkPlanTask(chain, 'engineer', engineerRecord, 'in_progress', subtask.id);
    }
  }

  /**
   * Appends a completion report's self-reported filesCreated/filesModified/filesDeleted
   * into the chain's running edit ledger (chain.touchedPaths). Called for every engineer,
   * fixer, and integrator completion — not just the first pass — so a chain that goes
   * through gate-fix or review-fix cycles still has the fixer's edits represented. This is
   * why it is a standalone accumulator rather than reading the last-stored report field:
   * chain.engineerReport / subtask.engineerReport are last-write slots that do not reliably
   * retain every fixer pass (see collectChainTouchedPaths for the consuming side).
   */
  private recordTouchedPaths(chain: WrfcChain, report: CompletionReport): void {
    if (report.archetype !== 'engineer') return;
    const engineerReport = report as EngineerReport;
    const claimed = [
      ...engineerReport.filesCreated,
      ...engineerReport.filesModified,
      ...engineerReport.filesDeleted,
    ];
    if (claimed.length === 0) return;
    chain.touchedPaths ??= [];
    const seen = new Set(chain.touchedPaths);
    for (const path of claimed) {
      if (!seen.has(path)) {
        seen.add(path);
        chain.touchedPaths.push(path);
      }
    }
  }

  private handleEngineerCompletion(chain: WrfcChain, agentId: string, report: CompletionReport): void {
    let reportForReview = report;
    this.completeCurrentNode(chain, report.summary);
    this.recordTouchedPaths(chain, report);
    if (chain.state === 'engineering') {
      chain.engineerReport = report;
      this.workmap.append({
        ts: new Date().toISOString(),
        wrfcId: chain.id,
        event: 'engineer_complete',
        agentId,
        task: chain.task,
      });
    }

    // Capture constraints from the engineer report and emit the enumeration event.
    // Only emit once per chain — the initial engineer completion, not fixer re-runs.
    //
    // Note on narrowing: EngineerReport.archetype is the literal 'engineer', but
    // GenericReport.archetype is a wide `string`. A bare `report.archetype === 'engineer'`
    // check does NOT narrow away GenericReport under strict TS because 'engineer'
    // is assignable to `string`. We use a type predicate to force the narrow.
    const isEngineerReportShape = (r: CompletionReport): r is EngineerReport =>
      r.archetype === 'engineer';

    if (!chain.constraintsEnumerated) {
      chain.constraints = isEngineerReportShape(report) ? (report.constraints ?? []) : [];
      chain.constraintsEnumerated = true;
      // Mechanically derive the system-unsatisfiable constraints from the collapse
      // action: only when this chain was created by collapsing a requested fan-out,
      // and only for constraints whose text describes the parallelism/spawn-count
      // topology the collapse removed. Such a constraint cannot be satisfied by ANY
      // fix agent (the precondition is gone), so it is excluded from the rubric and
      // can never fail the review — no fix-loop re-billing while chasing it.
      if (chain.fanoutCollapse) {
        const unsatisfiable = chain.constraints
          .filter((constraint) => isFanoutShapeConstraintText(constraint.text))
          .map((constraint) => constraint.id);
        if (unsatisfiable.length > 0) {
          chain.systemUnsatisfiableConstraintIds = unsatisfiable;
          logger.warn('WrfcController: excluded fan-out-collapse-invalidated constraints from review', {
            chainId: chain.id,
            systemUnsatisfiableConstraintIds: unsatisfiable,
            requestedAgentCount: chain.fanoutCollapse.requestedAgentCount,
          });
        }
      }
      emitWrfcConstraintsEnumerated(this.runtimeBus, this.sessionId, chain.id, chain.constraints);
    } else {
      // Fixer continuity validation: verify the fixer returned the same constraint id-set.
      // If it diverged, inject a synthetic critical issue for the next review pass.
      const fixerConstraints: Constraint[] = isEngineerReportShape(report) ? (report.constraints ?? []) : [];
      if (isEngineerReportShape(report)) {
        reportForReview = this.canonicalizeFixerReportConstraints(report, chain.constraints);
      }
      if (chain.constraints.length === 0) {
        if (fixerConstraints.length > 0) {
          logger.warn('WrfcController: ignored fixer-invented constraints for unconstrained chain', {
            chainId: chain.id,
            extra: fixerConstraints.map((constraint) => constraint.id),
          });
        }
      } else if (isEngineerReportShape(report)) {
        const expectedIds = new Set(chain.constraints.map((c) => c.id));
        const actualIds = new Set(fixerConstraints.map((c) => c.id));
        const missing = [...expectedIds].filter((id) => !actualIds.has(id));
        const extra = [...actualIds].filter((id) => !expectedIds.has(id));
        if (missing.length > 0 || extra.length > 0) {
          const description = `Fixer regressed constraint continuity: missing=[${missing.join(',')}] extra=[${extra.join(',')}]`;
          logger.warn('WrfcController: fixer constraint-continuity violation', {
            chainId: chain.id,
            missing,
            extra,
          });
          chain.syntheticIssues ??= [];
          chain.syntheticIssues.push({ severity: 'critical', description });
        }
      } else {
        const description = `Fixer regressed constraint continuity: missing=[${chain.constraints.map((c) => c.id).join(',')}] extra=[]`;
        logger.warn('WrfcController: fixer constraint-continuity violation', {
          chainId: chain.id,
          missing: chain.constraints.map((constraint) => constraint.id),
          extra: [],
        });
        chain.syntheticIssues ??= [];
        chain.syntheticIssues.push({ severity: 'critical', description });
      }
      // The authoritative constraint list is NOT overwritten — chain.constraints remains the
      // original enumeration from the initial engineer turn.
    }

    // Item 2 / MAJ-1 / MAJ-9: Verify claims before handing off to reviewer.
    // Runs for BOTH the initial engineer pass (chain.state === 'engineering') AND fixer
    // re-runs (chain.state === 'fixing'). A lying fixer that claims files it did not write
    // is the same phantom-work pattern as a lying engineer — the same tri-state logic applies.
    //
    // Skip conditions (see shouldSkipClaimVerification for full rationale):
    //   - Explicit opt-out (skipClaimVerification constructor flag) — harness use only.
    //   - Environment-driven: projectRoot does not exist on disk (existsSync false).
    //
    // Tri-state kind logic (same for engineer and fixer passes):
    //   'files_verified'          → claimsVerified=true,     no synthetic issue.
    //   'git_corroborated'        → claimsVerified=true,     no synthetic issue.
    //   'verified_empty'          → claimsVerified=true,     no synthetic issue (git confirms real work, no file list required).
    //   'unverifiable_no_claims'  → claimsVerified=undefined, inject advisory synthetic issue.
    //                               NOTE: claimsVerified is left undefined (not false) because we cannot confirm
    //                               work WAS done, but we also cannot confirm it WASN't. The synthetic issue
    //                               is the enforcement mechanism — the mechanical MIN-4 gate is NOT applied.
    //                               For fixers, a zero-claims completion is MORE suspicious (a fix round
    //                               by definition follows concrete reviewer findings) — but we keep the same
    //                               advisory contract for consistency; the reviewer sees the synthetic issue.
    //   'unverified'              → claimsVerified=false,    inject synthetic issue; MIN-4 gate will block pass.
    if (!this.shouldSkipClaimVerification()) {
      const claimVerification = verifyEngineerClaims(reportForReview, this.projectRoot);
      if (claimVerification.kind === 'unverifiable_no_claims') {
        // Leave chain.claimsVerified as undefined — not a confirmed false, but suspicious.
        const agentClass = chain.state === 'fixing' ? 'fixer' : 'engineer';
        logger.warn(`WrfcController: ${agentClass} sent success prose with no claims and no git diff — suspected phantom work`, {
          chainId: chain.id,
          kind: claimVerification.kind,
          summary: claimVerification.summary,
        });
        chain.syntheticIssues ??= [];
        chain.syntheticIssues.push({
          severity: 'critical',
          description: `No work claimed and no git diff detected — suspected phantom work: ${claimVerification.summary}`,
        });
      } else {
        chain.claimsVerified = claimVerification.verified;
        if (!claimVerification.verified) {
          // kind === 'unverified': claims present but missing on disk and no git corroboration.
          const agentClass = chain.state === 'fixing' ? 'fixer' : 'engineer';
          logger.warn(`WrfcController: ${agentClass} claim verification failed — phantom work detected`, {
            chainId: chain.id,
            kind: claimVerification.kind,
            summary: claimVerification.summary,
            missingPaths: claimVerification.missingPaths,
          });
          chain.syntheticIssues ??= [];
          chain.syntheticIssues.push({
            severity: 'critical',
            description: `Claimed work not found on disk: ${claimVerification.summary}`,
          });
        }
      }
    }
    this.startReview(chain, reportForReview);
  }

  private buildSubtaskEngineerTask(chain: WrfcChain, subtask: WrfcSubtask): string {
    return [
      `Compound WRFC engineer task`,
      `Parent WRFC ask (authoritative whole):`,
      chain.task,
      ``,
      `Sub-deliverable ${subtask.id}:`,
      subtask.task,
      ``,
      `Instructions:`,
      `1. Implement only this sub-deliverable, but keep the parent ask in mind for compatibility.`,
      `2. Do not review or verify sibling deliverables. The WRFC owner controls review/fix phases after your output exists.`,
      `3. Return a structured EngineerReport JSON block.`,
    ].join('\n');
  }

  private buildCompoundIntegrationTask(chain: WrfcChain): string {
    const subtaskSummaries = (chain.subtasks ?? []).map((subtask) => [
      `## ${subtask.id}: ${subtask.title}`,
      `Task: ${subtask.task}`,
      `Review cycles: ${subtask.reviewCycles}`,
      `Last score: ${subtask.reviewScores.at(-1) ?? 'n/a'}`,
      `Engineer summary: ${subtask.engineerReport?.summary ?? '(no summary)'}`,
      `Reviewer summary: ${subtask.reviewerReport?.summary ?? '(no review)'}`,
    ].join('\n')).join('\n\n');
    return [
      `Compound WRFC integration task`,
      `Parent WRFC ask (authoritative full scope):`,
      chain.task,
      ``,
      `All sub-deliverables have individually passed review. Integrate them into one coherent final result.`,
      ``,
      subtaskSummaries,
      ``,
      `Instructions:`,
      `1. Inspect the current workspace and the sub-deliverable outputs before editing.`,
      `2. Resolve cross-deliverable API, export, documentation, and test consistency issues.`,
      `3. Preserve all accepted sub-deliverable behavior; do not start unrelated new work.`,
      `4. Return a structured EngineerReport JSON block so the final reviewer can inspect integration changes.`,
    ].join('\n');
  }

  private findSubtaskByAgentId(chain: WrfcChain, agentId: string): WrfcSubtask | null {
    for (const subtask of chain.subtasks ?? []) {
      if (
        subtask.engineerAgentId === agentId
        || subtask.reviewerAgentId === agentId
        || subtask.fixerAgentId === agentId
      ) {
        return subtask;
      }
    }
    return null;
  }

  private async onCompoundSubtaskAgentComplete(
    chain: WrfcChain,
    subtask: WrfcSubtask,
    agentId: string,
    rawOutput: string,
    record: AgentRecord | undefined,
  ): Promise<void> {
    if (agentId === subtask.engineerAgentId || agentId === subtask.fixerAgentId) {
      const report = parseEngineerCompletionReport(rawOutput, record?.template);
      this.setWrfcWorkPlanTaskStatus(chain, agentId, 'done');
      this.handleCompoundEngineerCompletion(chain, subtask, agentId, report);
      return;
    }
    if (agentId === subtask.reviewerAgentId) {
      const review = parseReviewerCompletionReport(chain.id, rawOutput, getWrfcScoreThreshold(this.configManager));
      subtask.reviewerReport = review;
      subtask.reviewCycles += 1;
      this.setWrfcWorkPlanTaskStatus(chain, agentId, 'done');
      await this.processCompoundSubtaskReview(chain, subtask, review);
    }
  }

  private handleCompoundEngineerCompletion(
    chain: WrfcChain,
    subtask: WrfcSubtask,
    agentId: string,
    report: CompletionReport,
  ): void {
    let reportForReview = report;
    this.completeSubtaskNode(chain, subtask, report.summary);
    this.recordTouchedPaths(chain, report);
    if (subtask.state === 'engineering') {
      subtask.engineerReport = report;
      this.workmap.append({
        ts: new Date().toISOString(),
        wrfcId: chain.id,
        event: 'engineer_complete',
        agentId,
        task: subtask.task,
        subtaskId: subtask.id,
      });
    }

    const isEngineerReportShape = (r: CompletionReport): r is EngineerReport =>
      r.archetype === 'engineer';

    if (!subtask.constraintsEnumerated) {
      subtask.constraints = isEngineerReportShape(report) ? (report.constraints ?? []) : [];
      subtask.constraintsEnumerated = true;
    } else if (isEngineerReportShape(report)) {
      const fixerConstraints = report.constraints ?? [];
      reportForReview = this.canonicalizeFixerReportConstraints(report, subtask.constraints);
      if (subtask.constraints.length === 0) {
        if (fixerConstraints.length > 0) {
          logger.warn('WrfcController: ignored compound fixer-invented constraints for unconstrained subtask', {
            chainId: chain.id,
            subtaskId: subtask.id,
            extra: fixerConstraints.map((constraint) => constraint.id),
          });
        }
      } else {
        const expectedIds = new Set(subtask.constraints.map((constraint) => constraint.id));
        const actualIds = new Set(fixerConstraints.map((constraint) => constraint.id));
        const missing = [...expectedIds].filter((id) => !actualIds.has(id));
        const extra = [...actualIds].filter((id) => !expectedIds.has(id));
        if (missing.length > 0 || extra.length > 0) {
          const description = `Fixer regressed constraint continuity for ${subtask.id}: missing=[${missing.join(',')}] extra=[${extra.join(',')}]`;
          logger.warn('WrfcController: compound fixer constraint-continuity violation', {
            chainId: chain.id,
            subtaskId: subtask.id,
            missing,
            extra,
          });
          subtask.syntheticIssues ??= [];
          subtask.syntheticIssues.push({ severity: 'critical', description });
        }
      }
    } else if (subtask.constraints.length > 0) {
      const description = `Fixer regressed constraint continuity for ${subtask.id}: missing=[${subtask.constraints.map((constraint) => constraint.id).join(',')}] extra=[]`;
      logger.warn('WrfcController: compound fixer constraint-continuity violation', {
        chainId: chain.id,
        subtaskId: subtask.id,
        missing: subtask.constraints.map((constraint) => constraint.id),
        extra: [],
      });
      subtask.syntheticIssues ??= [];
      subtask.syntheticIssues.push({ severity: 'critical', description });
    }

    subtask.engineerReport = reportForReview;
    // Item 2 / MAJ-1: Verify engineer claims for compound subtask before handing off to reviewer.
    // Tri-state kind logic (mirrors handleEngineerCompletion):
    //   'files_verified'          → claimsVerified=true,     no synthetic issue.
    //   'git_corroborated'        → claimsVerified=true,     no synthetic issue.
    //   'verified_empty'          → claimsVerified=true,     no synthetic issue.
    //   'unverifiable_no_claims'  → claimsVerified=undefined, inject advisory synthetic issue only (no MIN-4 mechanical block).
    //   'unverified'              → claimsVerified=false,    inject synthetic issue; MIN-4 gate blocks pass.
    const subtaskClaimVerification = verifyEngineerClaims(reportForReview, this.projectRoot);
    if (subtaskClaimVerification.kind === 'unverifiable_no_claims') {
      // Leave subtask.claimsVerified as undefined — suspicious but not a confirmed false.
      logger.warn('WrfcController: compound subtask engineer sent success prose with no claims and no git diff — suspected phantom work', {
        chainId: chain.id,
        subtaskId: subtask.id,
        kind: subtaskClaimVerification.kind,
        summary: subtaskClaimVerification.summary,
      });
      subtask.syntheticIssues ??= [];
      subtask.syntheticIssues.push({
        severity: 'critical',
        description: `No work claimed and no git diff detected for subtask ${subtask.id} — suspected phantom work: ${subtaskClaimVerification.summary}`,
      });
    } else {
      subtask.claimsVerified = subtaskClaimVerification.verified;
      if (!subtaskClaimVerification.verified) {
        // kind === 'unverified': claims present but missing on disk and no git corroboration.
        logger.warn('WrfcController: compound engineer claim verification failed — phantom work detected', {
          chainId: chain.id,
          subtaskId: subtask.id,
          kind: subtaskClaimVerification.kind,
          summary: subtaskClaimVerification.summary,
          missingPaths: subtaskClaimVerification.missingPaths,
        });
        subtask.syntheticIssues ??= [];
        subtask.syntheticIssues.push({
          severity: 'critical',
          description: `Claimed work not found on disk (${subtask.id}): ${subtaskClaimVerification.summary}`,
        });
      }
    }
    this.startCompoundSubtaskReview(chain, subtask, reportForReview);
  }

  private startCompoundSubtaskReview(chain: WrfcChain, subtask: WrfcSubtask, report: CompletionReport): void {
    subtask.state = 'reviewing';
    let reviewTask = buildReviewTask(
      chain.id,
      `Parent WRFC ask:\n${chain.task}\n\nSub-deliverable ${subtask.id}:\n${subtask.task}`,
      report,
      getWrfcScoreThreshold(this.configManager),
      subtask.constraints,
    );
    if (subtask.syntheticIssues?.length) {
      reviewTask = this.prependSyntheticIssues(subtask.syntheticIssues, reviewTask);
      subtask.syntheticIssues = [];
    }

    const reviewerRecord = this.spawnWrfcAgent(chain, 'reviewer', 'reviewer', reviewTask, true, subtask.id);
    subtask.reviewerAgentId = reviewerRecord.id;
    this.registerSpawnedChild(chain, reviewerRecord, 'reviewer', subtask.id);
    subtask.currentNodeId = startWrfcOrchestrationNode(
      this.runtimeBus,
      this.sessionId,
      chain.id,
      `subtask:${subtask.id}:review:${subtask.reviewCycles + 1}`,
      'reviewer',
      `Review ${subtask.title}`,
      reviewerRecord.id,
    );
    this.appendOwnerDecision(chain, 'spawn_reviewer', this.withRouteReason(
      `Review compound sub-deliverable ${subtask.id} after engineer output exists`,
      reviewerRecord,
    ), {
      agentId: reviewerRecord.id,
      role: 'reviewer',
      record: reviewerRecord,
    });
    this.upsertWrfcWorkPlanTask(chain, 'reviewer', reviewerRecord, 'in_progress', subtask.id);
  }

  private async processCompoundSubtaskReview(
    chain: WrfcChain,
    subtask: WrfcSubtask,
    review: ReviewerReport,
  ): Promise<void> {
    const threshold = getWrfcScoreThreshold(this.configManager);
    const constraintEvaluation = this.evaluateSubtaskConstraints(subtask, review);
    // MIN-4: claimsVerified===false is a mechanical block on compound subtasks too.
    const passed = review.score >= threshold && !constraintEvaluation.constraintFailure && subtask.claimsVerified !== false;
    this.completeSubtaskNode(chain, subtask, `Score ${review.score}/10${passed ? ' passed' : ' needs fixes'}`);

    emitWorkflowReviewCompleted(this.runtimeBus, createWrfcWorkflowContext(this.sessionId, chain.id), {
      chainId: chain.id,
      score: review.score,
      passed,
      ...(subtask.constraints.length > 0
        ? {
            constraintsSatisfied: constraintEvaluation.constraintsSatisfied,
            constraintsTotal: constraintEvaluation.constraintsTotal,
            unsatisfiedConstraintIds: constraintEvaluation.unsatisfiedConstraintIds,
          }
        : {}),
    });

    this.workmap.append({
      ts: new Date().toISOString(),
      wrfcId: chain.id,
      event: 'review_complete',
      agentId: subtask.reviewerAgentId,
      score: review.score,
      passed,
      subtaskId: subtask.id,
      issues: review.issues?.slice(0, 10).map((issue) => ({
        severity: issue.severity,
        description: issue.description,
        file: issue.file,
      })),
    });

    subtask.reviewScores.push(review.score);
    const subtaskScores = subtask.reviewScores;
    if (subtaskScores.length >= 3) {
      const initial = subtaskScores[0]!;
      const lastTwo = subtaskScores.slice(-2);
      if (lastTwo[0]! < initial && lastTwo[1]! < initial) {
        emitWrfcScoreRegression(
          this.runtimeBus,
          this.sessionId,
          chain.id,
          `Score regression warning (subtask ${subtask.id}): initial ${initial}/10, last two ${lastTwo[0]}/10, ${lastTwo[1]}/10 — both below initial. Fix quality may be degrading.`,
        );
      }
    }
    if (passed) {
      subtask.state = 'passed';
      this.appendOwnerDecision(chain, 'subtask_review_passed', `Sub-deliverable ${subtask.id} passed review with ${review.score}/10`, {
        agentId: subtask.reviewerAgentId,
        role: 'reviewer',
        reviewScore: review.score,
      });
      if ((chain.subtasks ?? []).every((candidate) => candidate.state === 'passed')) {
        this.startIntegration(chain);
      }
      return;
    }

    const maxFixAttempts = getWrfcMaxFixAttempts(this.configManager);
    if (subtask.fixAttempts >= maxFixAttempts) {
      subtask.state = 'failed';
      this.failChain(chain, `Sub-deliverable ${subtask.id} review score ${review.score}/10 below threshold ${threshold}/10 after ${subtask.fixAttempts} fix attempt${subtask.fixAttempts !== 1 ? 's' : ''}`);
      return;
    }

    this.appendOwnerDecision(chain, 'subtask_review_failed', `Sub-deliverable ${subtask.id} review did not pass`, {
      agentId: subtask.reviewerAgentId,
      role: 'reviewer',
      reviewScore: review.score,
    });
    this.startCompoundSubtaskFix(chain, subtask, review);
  }

  private startCompoundSubtaskFix(chain: WrfcChain, subtask: WrfcSubtask, review: ReviewerReport): void {
    subtask.fixAttempts += 1;
    subtask.state = 'fixing';
    const targetConstraintIds = this.evaluateSubtaskConstraints(subtask, review).unsatisfiedConstraintIds;
    emitWorkflowFixAttempted(this.runtimeBus, createWrfcWorkflowContext(this.sessionId, chain.id), {
      chainId: chain.id,
      attempt: subtask.fixAttempts,
      maxAttempts: getWrfcMaxFixAttempts(this.configManager),
      ...(targetConstraintIds.length > 0 ? { targetConstraintIds } : {}),
    });

    const fixerRecord = this.spawnWrfcAgent(
      chain,
      'fixer',
      'engineer',
      buildFixTask(
        chain.id,
        `Parent WRFC ask:\n${chain.task}\n\nSub-deliverable ${subtask.id}:\n${subtask.task}`,
        review,
        getWrfcScoreThreshold(this.configManager),
        subtask.fixAttempts,
        subtask.constraints,
        review.constraintFindings ?? [],
      ),
      true,
      subtask.id,
    );
    subtask.fixerAgentId = fixerRecord.id;
    this.registerSpawnedChild(chain, fixerRecord, 'fixer', subtask.id);
    subtask.currentNodeId = startWrfcOrchestrationNode(
      this.runtimeBus,
      this.sessionId,
      chain.id,
      `subtask:${subtask.id}:fix:${subtask.fixAttempts}`,
      'fixer',
      `Fix ${subtask.title}`,
      fixerRecord.id,
    );
    this.appendOwnerDecision(chain, 'spawn_fixer', this.withRouteReason(
      `Fix compound sub-deliverable ${subtask.id}`,
      fixerRecord,
    ), {
      agentId: fixerRecord.id,
      role: 'fixer',
      record: fixerRecord,
    });
    this.upsertWrfcWorkPlanTask(chain, 'fixer', fixerRecord, 'in_progress', subtask.id);
  }

  private startIntegration(chain: WrfcChain): void {
    this.transition(chain, 'integrating');
    const integratorRecord = this.spawnWrfcAgent(
      chain,
      'integrator',
      'integrator',
      this.buildCompoundIntegrationTask(chain),
      true,
    );
    chain.integratorAgentId = integratorRecord.id;
    this.registerSpawnedChild(chain, integratorRecord, 'integrator');
    chain.currentNodeId = startWrfcOrchestrationNode(
      this.runtimeBus,
      this.sessionId,
      chain.id,
      `integrator:${Date.now()}`,
      'integrator',
      'Integrate passed deliverables',
      integratorRecord.id,
    );
    this.appendOwnerDecision(chain, 'spawn_integrator', this.withRouteReason(
      'Integrate all passed compound WRFC deliverables before final full-scope review',
      integratorRecord,
    ), {
      agentId: integratorRecord.id,
      role: 'integrator',
      record: integratorRecord,
    });
    this.upsertWrfcWorkPlanTask(chain, 'integrator', integratorRecord, 'in_progress');
  }

  private handleIntegratorCompletion(chain: WrfcChain, agentId: string, report: CompletionReport): void {
    chain.integratorReport = report;
    this.recordTouchedPaths(chain, report);
    this.completeCurrentNode(chain, report.summary);
    this.workmap.append({
      ts: new Date().toISOString(),
      wrfcId: chain.id,
      event: 'integrator_complete',
      agentId,
      task: chain.task,
    });
    this.startReview(chain, report);
  }

  private canonicalizeFixerReportConstraints(report: EngineerReport, constraints: readonly Constraint[]): EngineerReport & { reviewableOutput?: string } {
    const canonical: EngineerReport & { reviewableOutput?: string } = {
      ...report,
      constraints: constraints.map((constraint) => ({ ...constraint })),
    };
    const { reviewableOutput: _ignored, ...jsonReport } = canonical;
    canonical.reviewableOutput = [
      'Controller-canonicalized EngineerReport for WRFC review.',
      'The constraint list below is the authoritative chain constraint list; fixer-invented or renamed constraints were not forwarded to the reviewer.',
      '',
      '```json',
      JSON.stringify(jsonReport, null, 2),
      '```',
    ].join('\n');
    return canonical;
  }

  private spawnWrfcAgent(
    chain: WrfcChain,
    role: 'engineer' | 'reviewer' | 'fixer' | 'integrator',
    template: 'engineer' | 'reviewer' | 'integrator',
    task: string,
    dangerouslyDisableWrfc: boolean,
    subtaskId?: string,
  ): AgentRecord {
    const owner = this.agentManager.getStatus(chain.ownerAgentId);
    const selectedRoute = this.selectChildRoute?.({ chain, role, task, ownerAgent: owner }) ?? null;
    const model = selectedRoute?.model ?? owner?.model;
    const provider = selectedRoute?.provider ?? owner?.provider;
    const fallbackModels = selectedRoute?.fallbackModels ?? owner?.fallbackModels;
    const routing = selectedRoute?.routing ?? owner?.routing;
    const reasoningEffort = selectedRoute?.reasoningEffort ?? owner?.reasoningEffort;
    const record = this.agentManager.spawn({
      mode: 'spawn',
      task,
      template,
      parentAgentId: chain.ownerAgentId,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(fallbackModels?.length ? { fallbackModels: [...fallbackModels] } : {}),
      ...(routing ? { routing } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(template === 'engineer' ? { systemPromptAddendum: '\n\n---\n\n' + buildEngineerConstraintAddendum() } : {}),
      ...(template === 'integrator' ? { systemPromptAddendum: '\n\n---\n\n' + buildEngineerConstraintAddendum() } : {}),
      ...(dangerouslyDisableWrfc ? { dangerously_disable_wrfc: true } : {}),
    });
    record.wrfcId = chain.id;
    if (subtaskId) {
      record.wrfcSubtaskId = subtaskId;
    }
    if (selectedRoute?.reason) {
      record.wrfcRouteReason = selectedRoute.reason;
    }
    // Remember how this child was spawned so a transport-classified failure of
    // this exact agent can be retried later by respawning with identical inputs
    // (see retryTransportFailure). Overwritten on every spawn — only ever
    // describes the most recent child.
    chain.lastChildSpawn = { agentId: record.id, role, template, task, dangerouslyDisableWrfc, subtaskId };
    return record;
  }

  private withRouteReason(baseReason: string, record: AgentRecord): string {
    return record.wrfcRouteReason ? `${baseReason}; route: ${record.wrfcRouteReason}` : baseReason;
  }

  /**
   * Terminal success path — the ONE derivation point for a passing chain (its counterpart is
   * failChain). The chain's terminal status derives here from the full-scope review and quality
   * gates, never from the auto-commit result: the optional `commitNote` states the commit outcome
   * SEPARATELY in the completion message so a skipped/failed commit reads as a warning on a passing
   * chain, and can never contradict the "succeeded" verdict the transcript already showed.
   */
  private completeChainAsPassed(chain: WrfcChain, commitNote?: string): void {
    this.activeChainCount = Math.max(0, this.activeChainCount - 1);
    this.transition(chain, 'passed');
    chain.completedAt = Date.now();
    const reviewOutcome = this.describeReviewOutcome(chain);
    const summary = commitNote
      ? `WRFC chain ${chain.id} passed (${reviewOutcome}); ${commitNote}`
      : `WRFC chain ${chain.id} passed (${reviewOutcome})`;
    this.appendOwnerDecision(chain, 'chain_passed', 'WRFC full-scope review and quality gates passed', {
      agentId: chain.ownerAgentId,
    });
    this.setWrfcWorkPlanTaskStatus(chain, chain.ownerAgentId, 'done', 'WRFC full-scope review and quality gates passed');
    this.completeOwnerAgent(chain, 'completed', summary);
    emitWrfcChainPassed(this.runtimeBus, this.sessionId, chain.id);
    this.scheduleChainCleanup(chain);
    this.safeDequeueNext();
  }

  /** The review outcome for the completion message — the last recorded review score out of 10, or a plain "review passed" for a chain with no numeric score on record. */
  private describeReviewOutcome(chain: WrfcChain): string {
    const lastScore = chain.reviewScores.at(-1);
    return typeof lastScore === 'number' ? `review ${lastScore}/10` : 'review passed';
  }

  private completeOwnerAgent(chain: WrfcChain, status: 'completed' | 'failed', message: string): void {
    if (chain.ownerTerminalEmitted) return;
    const owner = this.agentManager.getStatus(chain.ownerAgentId);
    if (!owner) return;
    this.applyWrfcAgentMetadata(chain, owner, 'owner');
    owner.status = status;
    owner.completedAt = Date.now();
    owner.progress = message;
    owner.fullOutput = message;
    // The owner never runs an LLM turn itself (it only supervises phase
    // children), so its own usage/toolCallCount stay at the spawn-time zero
    // default forever unless rolled up here from the real numbers its phase
    // agents accumulated. This is what makes AgentManager.getStatus()/list()
    // — the read path TUI per-agent surfaces actually use — return real data
    // for the owner instead of the never-updated zeros (WO-305 wired the
    // AGENT_COMPLETED.usage forwarding but nothing populated the source).
    owner.usage = this.aggregateChainUsage(chain);
    owner.toolCallCount = this.aggregateChainToolCallCount(chain);
    chain.ownerTerminalEmitted = true;
    const context = {
      sessionId: this.sessionId,
      traceId: `${this.sessionId}:wrfc-owner:${chain.id}:${status}`,
      source: 'wrfc-controller',
      agentId: owner.id,
    };
    if (status === 'completed') {
      emitAgentCompleted(this.runtimeBus, context, {
        agentId: owner.id,
        durationMs: Math.max(0, owner.completedAt - owner.startedAt),
        output: message,
        toolCallsMade: owner.toolCallCount,
        usage: owner.usage,
      });
    } else {
      owner.error = message;
      emitAgentFailed(this.runtimeBus, context, {
        agentId: owner.id,
        durationMs: Math.max(0, owner.completedAt - owner.startedAt),
        error: message,
      });
    }
  }

  /**
   * Roll up token usage across every agent that has ever run under this
   * chain (the owner plus all phase/subtask children, across every review
   * and fix cycle — `chain.allAgentIds` already tracks the full roster for
   * worktree cleanup, so it doubles as the usage-aggregation source). Each
   * contributor's usage is added in, including the owner's own (normally
   * zero, but summed rather than ignored in case it is ever populated
   * directly). Optional fields (reasoningTokens/reasoningSummaryCount) are
   * only included in the result if at least one contributor reported them,
   * matching AgentUsage's undefined-means-no-data convention for those.
   */
  private aggregateChainUsage(chain: WrfcChain): NonNullable<AgentRecord['usage']> {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let llmCallCount = 0;
    let turnCount = 0;
    let reasoningTokens = 0;
    let hasReasoningTokens = false;
    let reasoningSummaryCount = 0;
    let hasReasoningSummaryCount = false;

    for (const agentId of chain.allAgentIds) {
      const usage = this.agentManager.getStatus(agentId)?.usage;
      if (!usage) continue;
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      cacheReadTokens += usage.cacheReadTokens;
      cacheWriteTokens += usage.cacheWriteTokens;
      llmCallCount += usage.llmCallCount;
      turnCount += usage.turnCount;
      if (usage.reasoningTokens !== undefined) {
        hasReasoningTokens = true;
        reasoningTokens += usage.reasoningTokens;
      }
      if (usage.reasoningSummaryCount !== undefined) {
        hasReasoningSummaryCount = true;
        reasoningSummaryCount += usage.reasoningSummaryCount;
      }
    }

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(hasReasoningTokens ? { reasoningTokens } : {}),
      llmCallCount,
      turnCount,
      ...(hasReasoningSummaryCount ? { reasoningSummaryCount } : {}),
    };
  }

  /** Roll up tool-call counts across every agent that has ever run under this chain. */
  private aggregateChainToolCallCount(chain: WrfcChain): number {
    let total = 0;
    for (const agentId of chain.allAgentIds) {
      total += this.agentManager.getStatus(agentId)?.toolCallCount ?? 0;
    }
    return total;
  }

  private upsertWrfcWorkPlanTask(
    chain: WrfcChain,
    role: 'owner' | 'engineer' | 'reviewer' | 'fixer' | 'integrator' | 'verifier',
    record: AgentRecord,
    status: ProjectWorkPlanTaskStatus,
    subtaskId?: string,
  ): void {
    if (!this.workPlanService) return;
    const taskId = this.workPlanTaskIdForAgent(chain, record.id, role);
    const task = {
      taskId,
      title: this.workPlanTaskTitle(role, role === 'owner' ? chain.task : record.task),
      notes: role === 'owner'
        ? 'WRFC owner chain supervising lifecycle child agents.'
        : subtaskId
          ? `WRFC ${role} phase for compound deliverable ${subtaskId}.`
          : `WRFC ${role} phase for the owner chain.`,
      owner: role,
      status,
      source: 'wrfc',
      chainId: chain.id,
      phaseId: role,
      agentId: record.id,
      originSurface: 'daemon',
      tags: ['wrfc', role],
      parentTaskId: role === 'owner' ? undefined : this.workPlanTaskIdForAgent(chain, chain.ownerAgentId, 'owner'),
      metadata: {
        wrfcState: chain.state,
        agentTemplate: record.template,
        ...(subtaskId ? { wrfcSubtaskId: subtaskId } : {}),
      },
    };
    this.enqueueWrfcWorkPlanTaskOperation(taskId, async () => {
      try {
        await this.workPlanService?.createWorkPlanTask({ task });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('already exists')) throw error;
        await this.workPlanService?.updateWorkPlanTask({
          taskId,
          patch: {
            ...task,
            taskId: undefined,
          } as ProjectWorkPlanTaskUpdateInput['patch'],
        });
      }
    }, {
      chainId: chain.id,
      agentId: record.id,
      role,
      action: 'upsert',
    });
  }

  private setWrfcWorkPlanTaskStatus(
    chain: WrfcChain,
    agentId: string,
    status: ProjectWorkPlanTaskStatus,
    reason?: string,
  ): void {
    if (!this.workPlanService) return;
    const role = this.resolveWrfcRole(chain, agentId);
    if (!role) return;
    const taskId = this.workPlanTaskIdForAgent(chain, agentId, role);
    this.enqueueWrfcWorkPlanTaskOperation(taskId, async () => {
      await this.workPlanService?.updateWorkPlanTask({
        taskId,
        patch: {
          status,
          metadata: {
            wrfcState: chain.state,
            ...(reason ? { statusReason: reason } : {}),
          },
        },
      });
    }, {
      chainId: chain.id,
      agentId,
      role,
      action: 'status',
    });
  }

  private enqueueWrfcWorkPlanTaskOperation(
    taskId: string,
    operation: () => Promise<void>,
    context: {
      readonly chainId: string;
      readonly agentId: string;
      readonly role: string;
      readonly action: string;
    },
  ): void {
    const previous = this.workPlanTaskQueues.get(taskId) ?? Promise.resolve();
    let next: Promise<void>;
    next = previous
      .catch(() => undefined)
      .then(operation)
      .catch((error: unknown) => {
        logger.warn('WrfcController: failed to sync work-plan task', {
          chainId: context.chainId,
          agentId: context.agentId,
          role: context.role,
          action: context.action,
          error: summarizeError(error),
        });
      })
      .finally(() => {
        if (this.workPlanTaskQueues.get(taskId) === next) {
          this.workPlanTaskQueues.delete(taskId);
        }
      });
    this.workPlanTaskQueues.set(taskId, next);
  }

  /**
   * Resolve the work-plan-visible role for an agent in a chain.
   *
   * Primary source: the durable `record.wrfcRole` stamped by
   * `applyWrfcAgentMetadata`. This preserves superseded-agent identity
   * (e.g. an earlier fixer whose `fixerAgentId` slot was reassigned still
   * resolves to 'fixer', so autoCommit continues to include its worktree).
   *
   * Structural fallback: `workPlanRoleForAgent`, which matches against the
   * CURRENT chain/subtask agent-id slots. Returns null for any agent no
   * longer in a current slot.
   *
   * Note: 'orchestrator' and 'verifier' are filtered out because they have
   * no work-plan task representation; workPlanTaskIdForAgent does not
   * accept those roles.
   */
  private resolveWrfcRole(
    chain: WrfcChain,
    agentId: string,
  ): 'owner' | 'engineer' | 'reviewer' | 'fixer' | 'integrator' | null {
    const recordRole = this.agentManager.getStatus(agentId)?.wrfcRole;
    if (recordRole && recordRole !== 'orchestrator' && recordRole !== 'verifier') {
      return recordRole;
    }
    return this.workPlanRoleForAgent(chain, agentId);
  }

  private workPlanRoleForAgent(
    chain: WrfcChain,
    agentId: string,
  ): 'owner' | 'engineer' | 'reviewer' | 'fixer' | 'integrator' | null {
    if (agentId === chain.ownerAgentId) return 'owner';
    if (agentId === chain.engineerAgentId) return 'engineer';
    if (agentId === chain.reviewerAgentId) return 'reviewer';
    if (agentId === chain.fixerAgentId) return 'fixer';
    if (agentId === chain.integratorAgentId) return 'integrator';
    for (const subtask of chain.subtasks ?? []) {
      if (agentId === subtask.engineerAgentId) return 'engineer';
      if (agentId === subtask.reviewerAgentId) return 'reviewer';
      if (agentId === subtask.fixerAgentId) return 'fixer';
    }
    return null;
  }

  private workPlanTaskIdForAgent(
    chain: WrfcChain,
    agentId: string,
    role: 'owner' | 'engineer' | 'reviewer' | 'fixer' | 'integrator' | 'verifier',
  ): string {
    return `wrfc-${chain.id}-${role}-${agentId}`;
  }

  private workPlanTaskTitle(role: 'owner' | 'engineer' | 'reviewer' | 'fixer' | 'integrator' | 'verifier', task: string): string {
    const label = role === 'owner'
      ? 'WRFC owner'
      : role.charAt(0).toUpperCase() + role.slice(1);
    return `${label}: ${task.slice(0, 120)}`;
  }

  private safeCheckAndRunGatesForAll(): void {
    this.checkAndRunGatesForAll().catch((error) => {
      logger.error('WrfcController.checkAndRunGatesForAll unhandled error', { error: summarizeError(error) });
    });
  }

  private safeDequeueNext(): void {
    this.dequeueNext().catch((error) => {
      logger.error('WrfcController.dequeueNext unhandled error', { error: summarizeError(error) });
    });
  }
}
