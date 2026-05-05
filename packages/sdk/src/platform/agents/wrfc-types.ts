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
  | 'reviewing'
  | 'fixing'
  | 'awaiting_gates'
  | 'gating'
  | 'passed'
  | 'failed'
  | 'committing';

/** A single WRFC chain instance. */
export interface WrfcChain {
  id: string;
  state: WrfcState;
  task: string;
  currentNodeId?: string | undefined;
  engineerAgentId?: string | undefined;
  reviewerAgentId?: string | undefined;
  fixerAgentId?: string | undefined;
  /** All agent IDs involved in this chain (for worktree cleanup). */
  allAgentIds: string[];
  engineerReport?: CompletionReport | undefined;
  reviewerReport?: ReviewerReport | undefined;
  fixAttempts: number;
  reviewCycles: number;
  gateResults?: QualityGateResult[] | undefined;
  createdAt: number;
  completedAt?: number | undefined;
  parentChainId?: string | undefined;
  /** Whether quality gates passed. Only meaningful when state is 'passed'. */
  gatesPassed?: boolean | undefined;
  /** Fingerprint of gate failures: used for same-error detection across chained chains. */
  gateFailureFingerprint?: string | undefined;
  /** How many gate-failure retry cycles deep this chain is. 0 = original chain. */
  gateRetryDepth: number;
  /** Review scores history — used to detect regression (2 consecutive below initial). */
  reviewScores: number[];
  error?: string | undefined;
  /** Buffered agent completion — set when agent finishes while chain is still queued/pending. */
  bufferedCompletion?: { agentId: string; fullOutput?: string | undefined } | undefined;
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
