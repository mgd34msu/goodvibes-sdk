import type { CompletionReport, Constraint, ReviewerReport } from './completion-report.js';
import type { AgentRecord } from '../tools/agent/index.js';

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
  | 'resume_started';

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
  fixAttempts: number;
  reviewCycles: number;
  reviewScores: number[];
  constraints: Constraint[];
  constraintsEnumerated: boolean;
  syntheticIssues?: Array<{ severity: 'critical'; description: string }> | undefined;
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
  /** Buffered agent completion — set when agent finishes while chain is still queued/pending. */
  bufferedCompletion?: { agentId: string; fullOutput?: string | undefined } | undefined;
  /** True once the durable owner agent terminal event has been emitted. */
  ownerTerminalEmitted: boolean;
  /** Constraints propagated for this chain. Initialized to [] on construction. */
  constraints: Constraint[];
  /** True once constraints have been captured and WORKFLOW_CONSTRAINTS_ENUMERATED has been emitted. */
  constraintsEnumerated: boolean;
  /**
   * Synthetic critical issues injected by the controller (e.g. fixer constraint-continuity
   * violations). Prepended to the next review task body, then cleared so they fire once per cycle.
   */
  syntheticIssues?: Array<{ severity: 'critical'; description: string }> | undefined;
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
