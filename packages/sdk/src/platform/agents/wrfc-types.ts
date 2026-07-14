import type { CompletionReport, Constraint, ReviewerReport } from './completion-report.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { FanoutCollapseInfo } from '../tools/agent/schema.js';

/** Queued chain waiting to start. */
export interface QueuedChain {
  record: AgentRecord;
  queuedAt: number;
}

/** WRFC chain lifecycle states. */
export type WrfcState =
  | 'pending'
  | 'engineering'
  | 'integrating'
  | 'reviewing'
  | 'fixing'
  | 'awaiting_gates'
  | 'gating'
  | 'passed'
  | 'failed'
  | 'committing';

/** Agent role within a WRFC chain. The owner is the durable chain orchestrator. */
export type WrfcAgentRole = 'owner' | 'orchestrator' | 'engineer' | 'reviewer' | 'fixer' | 'integrator' | 'verifier';

export type WrfcSubtaskState = 'pending' | 'engineering' | 'reviewing' | 'fixing' | 'passed' | 'failed';

export type WrfcOwnerDecisionAction =
  | 'chain_created'
  | 'compound_started'
  | 'spawn_engineer'
  | 'spawn_reviewer'
  | 'spawn_fixer'
  | 'spawn_integrator'
  | 'spawn_gate_fixer'
  | 'subtask_review_passed'
  | 'subtask_review_failed'
  | 'review_passed'
  | 'review_failed'
  | 'gate_passed'
  | 'gate_failed'
  | 'chain_passed'
  | 'chain_failed'
  | 'chain_cancelled'
  | 'owner_completion_ignored'
  | 'owner_failure_ignored'
  | 'resume_skipped'
  | 'resume_started'
  | 'transport_retry';

/**
 * Why a chain reached the terminal 'failed' state. Distinguishes a transport/network
 * blip (which gets one automatic retry, see WrfcChain.transportRetryCount) from an
 * ordinary review/gate rejection and from an operator-initiated cancellation, so a
 * consumer (e.g. the TUI) can render the three differently instead of showing every
 * terminal-'failed' identically. 'cancelled' is an operator kill/interrupt of the
 * chain — an intended stop, not a failure — and must read as cancelled at every
 * surface (chain row, owner row, cohort tally, completion narration).
 */
export type WrfcChainFailureKind = 'transport' | 'other' | 'cancelled' | 'max_turns';

export interface WrfcOwnerDecision {
  id: string;
  ts: string;
  action: WrfcOwnerDecisionAction;
  state: WrfcState;
  reason: string;
  agentId?: string | undefined;
  role?: Exclude<WrfcAgentRole, 'owner'> | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  reasoningEffort?: AgentRecord['reasoningEffort'] | undefined;
  reviewScore?: number | undefined;
}

export interface WrfcChildRouteSelection {
  model?: string | undefined;
  provider?: string | undefined;
  fallbackModels?: string[] | undefined;
  routing?: AgentRecord['routing'] | undefined;
  reasoningEffort?: AgentRecord['reasoningEffort'] | undefined;
  reason?: string | undefined;
}

export type WrfcChildRouteSelector = (context: {
  readonly chain: WrfcChain;
  readonly role: Exclude<WrfcAgentRole, 'owner' | 'orchestrator' | 'verifier'>;
  readonly task: string;
  readonly ownerAgent: AgentRecord | null;
}) => WrfcChildRouteSelection | null | undefined;

export interface WrfcSubtask {
  id: string;
  title: string;
  task: string;
  state: WrfcSubtaskState;
  currentNodeId?: string | undefined;
  engineerAgentId?: string | undefined;
  reviewerAgentId?: string | undefined;
  fixerAgentId?: string | undefined;
  engineerReport?: CompletionReport | undefined;
  reviewerReport?: ReviewerReport | undefined;
  /** The CONTROLLER verdict on the latest review (gate-inclusive) — the reviewer's own passed claim can be overridden by the deterministic gates. */
  lastReviewVerdict?: { passed: boolean; score: number; at: number } | undefined;
  fixAttempts: number;
  reviewCycles: number;
  reviewScores: number[];
  constraints: Constraint[];
  constraintsEnumerated: boolean;
  syntheticIssues?: Array<{ severity: 'critical'; description: string }> | undefined;
  /**
   * Whether the engineer's self-reported work claims were verified on disk.
   * Undefined until claim verification runs (after engineering/fixing phase).
   * false = verification ran and found missing claims (phantom work detected).
   */
  claimsVerified?: boolean | undefined;
}

/** A single WRFC chain instance. */
export interface WrfcChain {
  id: string;
  state: WrfcState;
  task: string;
  ownerAgentId: string;
  currentNodeId?: string | undefined;
  engineerAgentId?: string | undefined;
  reviewerAgentId?: string | undefined;
  fixerAgentId?: string | undefined;
  integratorAgentId?: string | undefined;
  /** All agent IDs involved in this chain (for worktree cleanup). */
  allAgentIds: string[];
  engineerReport?: CompletionReport | undefined;
  reviewerReport?: ReviewerReport | undefined;
  /** The CONTROLLER verdict on the latest review (gate-inclusive) — the reviewer's own passed claim can be overridden by the deterministic gates. */
  lastReviewVerdict?: { passed: boolean; score: number; at: number } | undefined;
  integratorReport?: CompletionReport | undefined;
  subtasks?: WrfcSubtask[] | undefined;
  fixAttempts: number;
  reviewCycles: number;
  gateResults?: QualityGateResult[] | undefined;
  createdAt: number;
  completedAt?: number | undefined;
  /** Whether quality gates passed. Only meaningful when state is 'passed'. */
  gatesPassed?: boolean | undefined;
  /** Review scores history — used to detect regression (2 consecutive below initial). */
  reviewScores: number[];
  /** Durable audit of owner orchestration choices. */
  ownerDecisions: WrfcOwnerDecision[];
  error?: string | undefined;
  /**
   * Why the chain failed. Only meaningful when state is 'failed'. Optional field —
   * absent on chains persisted before this field was introduced (deserializeChain
   * treats it as undefined rather than requiring a schema-version bump).
   */
  failureKind?: WrfcChainFailureKind | undefined;
  /**
   * Number of times this chain has auto-retried a transport-classified child-agent
   * failure by respawning the same role (bounded by wrfc.transportRetryLimit).
   * Kept separate from fixAttempts/reviewCycles: a transport retry is not a fix
   * cycle and must not count against maxFixAttempts. Optional/defaults to 0 —
   * absent on chains persisted before this field was introduced.
   */
  transportRetryCount?: number | undefined;
  /**
   * Parameters used for the most recent spawnWrfcAgent call, kept so a
   * transport-classified failure of that same agent can be retried by respawning
   * with identical inputs. Overwritten on every subsequent spawn, so it only ever
   * describes the latest child. A chain resumed from persisted JSON that hasn't
   * spawned anything since resume simply has no retry candidate here and fails
   * closed via failChain, same as any other missing-optional-field case.
   */
  lastChildSpawn?: {
    agentId: string;
    role: 'engineer' | 'reviewer' | 'fixer' | 'integrator';
    template: 'engineer' | 'reviewer' | 'integrator';
    task: string;
    dangerouslyDisableWrfc: boolean;
    subtaskId?: string | undefined;
  } | undefined;
  /** Buffered agent completion — set when agent finishes while chain is still queued/pending. */
  bufferedCompletion?: { agentId: string; fullOutput?: string | undefined } | undefined;
  /** True once the durable owner agent terminal event has been emitted. */
  ownerTerminalEmitted: boolean;
  /** Constraints propagated for this chain. Initialized to [] on construction. */
  constraints: Constraint[];
  /** True once constraints have been captured and WORKFLOW_CONSTRAINTS_ENUMERATED has been emitted. */
  constraintsEnumerated: boolean;
  /**
   * Set when this chain was created by collapsing a requested multi-agent fan-out
   * into one owner chain (schema.ts FanoutCollapseInfo). Its presence is what makes
   * a parallelism/spawn-count constraint SYSTEM-UNSATISFIABLE — the collapse removed
   * the precondition, so no fix agent can ever satisfy it.
   */
  fanoutCollapse?: FanoutCollapseInfo | undefined;
  /**
   * Constraint ids that no fix agent can satisfy because the system itself removed
   * their precondition (e.g. the fan-out collapse invalidated a "separate agent per
   * file / in parallel" constraint). Derived mechanically from fanoutCollapse at
   * enumeration time. These are excluded from the review rubric, never counted as
   * unsatisfied, and never entered into the fix-loop target set — an un-loopable
   * constraint can never fail the review.
   */
  systemUnsatisfiableConstraintIds?: string[] | undefined;
  /**
   * Synthetic critical issues injected by the controller (e.g. fixer constraint-continuity
   * violations). Prepended to the next review task body, then cleared so they fire once per cycle.
   */
  syntheticIssues?: Array<{ severity: 'critical'; description: string }> | undefined;
  /**
   * Whether the engineer's self-reported work claims were verified on disk.
   * Undefined until claim verification runs (after engineering/fixing phase).
   * false = verification ran and found missing claims (phantom work detected).
   */
  claimsVerified?: boolean | undefined;
  /**
   * Running ledger of paths (filesCreated/filesModified/filesDeleted) self-reported by every
   * engineer/fixer/integrator completion across the chain's lifetime — including subtask
   * completions on compound chains. Appended to incrementally (not derived from a single
   * "latest report" field) so it still reflects fixer/re-fix passes after resume, and so a
   * pre-interruption pass is never lost. Consumed by collectChainTouchedPaths() to scope
   * the auto-commit `git add` when wrfc.commitScope is 'scoped'. Self-reported, not ground
   * truth — see verifyEngineerClaims for the same accuracy caveat.
   */
  touchedPaths?: string[] | undefined;
}

/** Quality gate definition. */
export interface QualityGate {
  name: string;
  command: string;
  enabled: boolean;
}

/** Result of running a quality gate. */
export interface QualityGateResult {
  gate: QualityGate['name'];
  passed: boolean;
  output: string;
  durationMs: number;
}
