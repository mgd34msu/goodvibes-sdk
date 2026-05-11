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
import { AgentWorktree } from './worktree.js';
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
  getWrfcMaxFixAttempts,
  getWrfcScoreThreshold,
  type AgentManagerLike,
} from './wrfc-config.js';
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
  emitWrfcStateChanged,
  failWrfcOrchestrationNode,
  startWrfcOrchestrationNode,
} from './wrfc-runtime-events.js';
import { runWrfcGateChecks } from './wrfc-gate-runtime.js';

export { extractScoreFromText, extractPassedFromText, extractIssuesFromText } from './wrfc-reporting.js';

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
  private runtimeBus: RuntimeEventBus;
  private readonly messageBus: Pick<AgentMessageBus, 'registerAgent'>;
  private planManager: Pick<ExecutionPlanManager, 'getActive' | 'updateItem'> | null = null;
  private readonly agentManager: AgentManagerLike;
  private readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  private readonly createWorktree: () => WrfcWorktreeOps;
  private readonly selectChildRoute: WrfcChildRouteSelector | null;
  private workPlanService: WrfcWorkPlanService | null = null;
  private readonly workPlanTaskQueues = new Map<string, Promise<void>>();

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
    },
  ) {
    this.runtimeBus = runtimeBus;
    this.messageBus = messageBus;
    this.agentManager = deps.agentManager;
    this.configManager = deps.configManager;
    this.projectRoot = deps.projectRoot;
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
    if (!chain || chain.state === 'passed' || chain.state === 'failed') return false;
    if (this.hasRunningChild(chain)) {
      this.appendOwnerDecision(chain, 'resume_skipped', 'WRFC chain already has an active child agent');
      return true;
    }
    if (chain.state !== 'pending') {
      this.appendOwnerDecision(chain, 'resume_skipped', `WRFC chain state ${chain.state} cannot be resumed without an active phase result`);
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

  dispose(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
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
    if (to !== 'passed' && to !== 'failed') {
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
    if (record.status === 'pending' || record.status === 'running') {
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

  private keepOwnerAgentActive(chain: WrfcChain, reason?: string): void {
    if (chain.ownerTerminalEmitted || chain.state === 'passed' || chain.state === 'failed') return;
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
        this.onAgentFailed(payload.agentId, payload.error);
      },
    );
    const unsubCancelled = this.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_CANCELLED' }>>(
      'AGENT_CANCELLED',
      ({ payload }) => {
        this.onAgentCancelled(payload.agentId, payload.reason);
      },
    );
    this.unsubscribers.push(unsubComplete, unsubError, unsubCancelled);
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
    if (agentId === chain.ownerAgentId && (chain.state === 'passed' || chain.state === 'failed')) return;
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
    this.setWrfcWorkPlanTaskStatus(chain, agentId, 'failed', errorMessage ?? `Agent ${agentId} failed`);
    this.failChain(chain, errorMessage ?? `Agent ${agentId} failed`);
  }

  private onAgentCancelled(agentId: string, reason?: string): void {
    const chain = this.findChainByAgentId(agentId);
    if (!chain || chain.state === 'passed' || chain.state === 'failed') return;
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
    let reviewTask = buildReviewTask(chain.id, chain.task, report, getWrfcScoreThreshold(this.configManager), chain.constraints);
    if (chain.syntheticIssues && chain.syntheticIssues.length > 0) {
      const syntheticBlock = [
        `## Synthetic issues from controller`,
        ``,
        ...chain.syntheticIssues.map((issue) => `- [${issue.severity.toUpperCase()}] ${issue.description}`),
      ].join('\n');
      reviewTask = syntheticBlock + '\n\n---\n\n' + reviewTask;
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
    this.applyWrfcAgentMetadata(chain, reviewerRecord, 'reviewer');
    chain.allAgentIds.push(reviewerRecord.id);
    this.messageBus.registerAgent({
      agentId: reviewerRecord.id,
      role: 'reviewer',
      wrfcId: chain.id,
    });
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
    const passed = review.score >= threshold && !constraintFailure;

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
        emitWrfcCascadeAbort(
          this.runtimeBus,
          this.sessionId,
          chain.id,
          `Score regression warning: initial ${initial}/10, last two ${lastTwo[0]}/10, ${lastTwo[1]}/10 — both below initial. Fix quality may be degrading.`,
        );
      }
    }

    const maxFixAttempts = getWrfcMaxFixAttempts(this.configManager);
    if (chain.fixAttempts >= maxFixAttempts) {
      const failureReason = constraintFailure && review.score >= threshold
        ? `Unsatisfied constraints [${unsatisfiedConstraintIds.join(',')}] after ${chain.fixAttempts} fix attempt${chain.fixAttempts !== 1 ? 's' : ''}`
        : `Score ${review.score}/10 below threshold ${threshold}/10 after ${chain.fixAttempts} fix attempt${chain.fixAttempts !== 1 ? 's' : ''} — below threshold`;
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
    this.applyWrfcAgentMetadata(chain, fixerRecord, 'fixer');
    chain.allAgentIds.push(fixerRecord.id);
    this.messageBus.registerAgent({
      agentId: fixerRecord.id,
      role: 'fixer',
      wrfcId: chain.id,
    });
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

  private evaluateConstraints(chain: WrfcChain, review: ReviewerReport): ConstraintEvaluation {
    if (chain.constraints.length === 0) {
      return {
        constraintsSatisfied: 0,
        constraintsTotal: 0,
        unsatisfiedConstraintIds: [],
        ignoredConstraintFindingIds: [],
        constraintFailure: false,
      };
    }

    const expectedIds = new Set(chain.constraints.map((constraint) => constraint.id));
    const findingMap = new Map<string, NonNullable<ReviewerReport['constraintFindings']>[number]>();
    const ignoredConstraintFindingIds: string[] = [];
    for (const finding of review.constraintFindings ?? []) {
      if (!expectedIds.has(finding.constraintId)) {
        ignoredConstraintFindingIds.push(finding.constraintId);
        continue;
      }
      if (!findingMap.has(finding.constraintId)) {
        findingMap.set(finding.constraintId, finding);
      }
    }

    let constraintsSatisfied = 0;
    const unsatisfiedConstraintIds: string[] = [];
    for (const constraint of chain.constraints) {
      const finding = findingMap.get(constraint.id);
      if (finding?.satisfied === true) {
        constraintsSatisfied += 1;
      } else {
        unsatisfiedConstraintIds.push(constraint.id);
      }
    }

    return {
      constraintsSatisfied,
      constraintsTotal: chain.constraints.length,
      unsatisfiedConstraintIds,
      ignoredConstraintFindingIds,
      constraintFailure: unsatisfiedConstraintIds.length > 0,
    };
  }

  private evaluateSubtaskConstraints(subtask: WrfcSubtask, review: ReviewerReport): ConstraintEvaluation {
    if (subtask.constraints.length === 0) {
      return {
        constraintsSatisfied: 0,
        constraintsTotal: 0,
        unsatisfiedConstraintIds: [],
        ignoredConstraintFindingIds: [],
        constraintFailure: false,
      };
    }

    const expectedIds = new Set(subtask.constraints.map((constraint) => constraint.id));
    const findingMap = new Map<string, NonNullable<ReviewerReport['constraintFindings']>[number]>();
    const ignoredConstraintFindingIds: string[] = [];
    for (const finding of review.constraintFindings ?? []) {
      if (!expectedIds.has(finding.constraintId)) {
        ignoredConstraintFindingIds.push(finding.constraintId);
        continue;
      }
      if (!findingMap.has(finding.constraintId)) {
        findingMap.set(finding.constraintId, finding);
      }
    }

    let constraintsSatisfied = 0;
    const unsatisfiedConstraintIds: string[] = [];
    for (const constraint of subtask.constraints) {
      const finding = findingMap.get(constraint.id);
      if (finding?.satisfied === true) {
        constraintsSatisfied += 1;
      } else {
        unsatisfiedConstraintIds.push(constraint.id);
      }
    }

    return {
      constraintsSatisfied,
      constraintsTotal: subtask.constraints.length,
      unsatisfiedConstraintIds,
      ignoredConstraintFindingIds,
      constraintFailure: unsatisfiedConstraintIds.length > 0,
    };
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
      ...(chain.constraints.length > 0 ? { targetConstraintIds: chain.constraints.map((constraint) => constraint.id) } : {}),
    });

    const gateFixTask = buildGateFailureTask(chain.id, chain.task, failedGates, chain.constraints);
    const fixerRecord = this.spawnWrfcAgent(chain, 'fixer', 'engineer', gateFixTask, true);
    this.applyWrfcAgentMetadata(chain, fixerRecord, 'fixer');
    chain.fixerAgentId = fixerRecord.id;
    chain.allAgentIds.push(fixerRecord.id);
    this.messageBus.registerAgent({
      agentId: fixerRecord.id,
      role: 'fixer',
      wrfcId: chain.id,
    });
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
      if (chain.state === 'passed' || chain.state === 'failed') {
        this.chains.delete(chain.id);
      }
    }, CHAIN_CLEANUP_DELAY_MS);
    timer.unref?.();
  }

  private async checkAndRunGatesForAll(): Promise<void> {
    const allChains = Array.from(this.chains.values()).filter(
      (chain) => chain.state !== 'passed' && chain.state !== 'failed',
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
    for (const chain of readyChains) {
      if (chain.id !== gateRunner.id) {
        this.transition(chain, 'gating');
        chain.gateResults = results;
      }
      await this.processGateResults(chain, results);
    }
  }

  private async autoCommit(chain: WrfcChain): Promise<void> {
    this.transition(chain, 'committing');

    const commitCandidateIds = this.autoCommitCandidateAgentIds(chain);
    if (commitCandidateIds.length === 0) {
      this.failChain(chain, 'autoCommit: no write-capable WRFC agent found on chain');
      return;
    }

    if (!existsSync(join(this.projectRoot, '.git'))) {
      logger.debug('WrfcController.autoCommit: not a git repo, skipping commit', { chainId: chain.id });
      this.completeChainAsPassed(chain);
      return;
    }

    const worktree = this.createWorktree();
    let completed = false;
    try {
      const commitMessage = this.autoCommitMessage(chain);
      const directCommitHash = worktree.commitWorkingTree
        ? await worktree.commitWorkingTree(commitMessage)
        : null;
      let mergedCount = 0;
      for (const agentId of commitCandidateIds) {
        if (await worktree.merge(agentId)) {
          mergedCount += 1;
        }
      }
      const headHash = mergedCount > 0 && worktree.currentHead ? await worktree.currentHead() : directCommitHash;
      emitWrfcAutoCommitted(this.runtimeBus, this.sessionId, chain.id, headHash ?? undefined);
      this.completeChainAsPassed(chain);
      completed = true;
      logger.debug('WrfcController.autoCommit: success', {
        chainId: chain.id,
        commitCandidateIds,
        directCommitHash,
        mergedCount,
        headHash,
      });
    } catch (error) {
      const reason = summarizeError(error);
      logger.error('WrfcController.autoCommit: failed', { chainId: chain.id, error: reason });
      this.failChain(chain, `autoCommit failed: ${reason}`);
    } finally {
      const cleanupIds = completed
        ? chain.allAgentIds
        : chain.allAgentIds.filter((id) => !commitCandidateIds.includes(id));
      for (const id of cleanupIds) {
        worktree.cleanup(id).catch((error) => {
          logger.warn('WrfcController.autoCommit: cleanup failed', {
            agentId: id,
            error: summarizeError(error),
          });
        });
      }
    }
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
      const recordRole = this.agentManager.getStatus(agentId)?.wrfcRole;
      const role = recordRole ?? this.workPlanRoleForAgent(chain, agentId);
      if (role && writeRoles.has(role)) add(agentId);
    }
    return candidates;
  }

  private autoCommitMessage(chain: WrfcChain): string {
    const firstLine = chain.task.trim().replace(/\s+/g, ' ').slice(0, 72) || chain.id;
    return `WRFC: ${firstLine}`;
  }

  private failChain(chain: WrfcChain, reason: string): void {
    if (chain.state === 'pending') {
      this.chainQueue = this.chainQueue.filter((queued) => queued.record.id !== chain.ownerAgentId);
    }

    const wasActive = chain.state !== 'passed' && chain.state !== 'failed' && chain.state !== 'pending';
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
    chain.completedAt = Date.now();
    this.setWrfcWorkPlanTaskStatus(chain, chain.ownerAgentId, 'failed', reason);
    this.cancelRunningChildren(chain);
    this.appendOwnerDecision(chain, 'chain_failed', reason, {
      agentId: chain.ownerAgentId,
    });
    this.completeOwnerAgent(chain, 'failed', reason);
    this.workmap.append({ ts: new Date().toISOString(), wrfcId: chain.id, event: 'chain_failed', reason });
    emitWorkflowChainFailed(this.runtimeBus, createWrfcWorkflowContext(this.sessionId, chain.id), { chainId: chain.id, reason });

    logger.error('WrfcController.failChain', { chainId: chain.id, reason });
    this.scheduleChainCleanup(chain);
    this.safeDequeueNext();
  }

  private cancelRunningChildren(chain: WrfcChain): void {
    for (const agentId of chain.allAgentIds) {
      if (agentId === chain.ownerAgentId) continue;
      const record = this.agentManager.getStatus(agentId);
      if (record?.status === 'pending' || record?.status === 'running') {
        this.agentManager.cancel(agentId);
      }
    }
  }

  private hasRunningChild(chain: WrfcChain): boolean {
    return chain.allAgentIds.some((agentId) => {
      if (agentId === chain.ownerAgentId) return false;
      const record = this.agentManager.getStatus(agentId);
      return record?.status === 'pending' || record?.status === 'running';
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
    if (owner && (owner.status === 'pending' || owner.status === 'running')) {
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
      createdAt: Date.now(),
      ...(subtasks.length > 1 ? { subtasks } : {}),
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
    this.applyWrfcAgentMetadata(chain, engineerRecord, 'engineer');
    chain.engineerAgentId = engineerRecord.id;
    chain.allAgentIds.push(engineerRecord.id);
    this.messageBus.registerAgent({
      agentId: engineerRecord.id,
      role: 'engineer',
      wrfcId: chain.id,
    });
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
      this.applyWrfcAgentMetadata(chain, engineerRecord, 'engineer', subtask.id);
      subtask.engineerAgentId = engineerRecord.id;
      chain.allAgentIds.push(engineerRecord.id);
      this.messageBus.registerAgent({
        agentId: engineerRecord.id,
        role: 'engineer',
        wrfcId: chain.id,
      });
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

  private handleEngineerCompletion(chain: WrfcChain, agentId: string, report: CompletionReport): void {
    let reportForReview = report;
    this.completeCurrentNode(chain, report.summary);
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
    if (subtask.syntheticIssues && subtask.syntheticIssues.length > 0) {
      const syntheticBlock = [
        `## Synthetic issues from controller`,
        ``,
        ...subtask.syntheticIssues.map((issue) => `- [${issue.severity.toUpperCase()}] ${issue.description}`),
      ].join('\n');
      reviewTask = syntheticBlock + '\n\n---\n\n' + reviewTask;
      subtask.syntheticIssues = [];
    }

    const reviewerRecord = this.spawnWrfcAgent(chain, 'reviewer', 'reviewer', reviewTask, true, subtask.id);
    subtask.reviewerAgentId = reviewerRecord.id;
    this.applyWrfcAgentMetadata(chain, reviewerRecord, 'reviewer', subtask.id);
    chain.allAgentIds.push(reviewerRecord.id);
    this.messageBus.registerAgent({
      agentId: reviewerRecord.id,
      role: 'reviewer',
      wrfcId: chain.id,
    });
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
    const passed = review.score >= threshold && !constraintEvaluation.constraintFailure;
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
    this.applyWrfcAgentMetadata(chain, fixerRecord, 'fixer', subtask.id);
    chain.allAgentIds.push(fixerRecord.id);
    this.messageBus.registerAgent({
      agentId: fixerRecord.id,
      role: 'fixer',
      wrfcId: chain.id,
    });
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
    this.applyWrfcAgentMetadata(chain, integratorRecord, 'integrator');
    chain.allAgentIds.push(integratorRecord.id);
    this.messageBus.registerAgent({
      agentId: integratorRecord.id,
      role: 'integrator',
      wrfcId: chain.id,
    });
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
    return record;
  }

  private withRouteReason(baseReason: string, record: AgentRecord): string {
    return record.wrfcRouteReason ? `${baseReason}; route: ${record.wrfcRouteReason}` : baseReason;
  }

  private completeChainAsPassed(chain: WrfcChain): void {
    this.activeChainCount = Math.max(0, this.activeChainCount - 1);
    this.transition(chain, 'passed');
    chain.completedAt = Date.now();
    this.appendOwnerDecision(chain, 'chain_passed', 'WRFC full-scope review and quality gates passed', {
      agentId: chain.ownerAgentId,
    });
    this.setWrfcWorkPlanTaskStatus(chain, chain.ownerAgentId, 'done', 'WRFC full-scope review and quality gates passed');
    this.completeOwnerAgent(chain, 'completed', `WRFC chain ${chain.id} passed`);
    emitWrfcChainPassed(this.runtimeBus, this.sessionId, chain.id);
    this.scheduleChainCleanup(chain);
    this.safeDequeueNext();
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
    const role = this.workPlanRoleForAgent(chain, agentId);
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

  private safeDequeueNext(): void {
    this.dequeueNext().catch((error) => {
      logger.error('WrfcController.dequeueNext unhandled error', { error: summarizeError(error) });
    });
  }
}
