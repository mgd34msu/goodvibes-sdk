/**
 * WorkflowEvent — discriminated union for WRFC workflow lifecycle events.
 */

export interface Constraint {
  readonly id: string;
  readonly text: string;
  readonly source: 'prompt' | 'inherited';
}

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

export type WorkflowEvent =
  | { type: 'WORKFLOW_CHAIN_CREATED'; chainId: string; task: string }
  | { type: 'WORKFLOW_STATE_CHANGED'; chainId: string; from: WrfcState; to: WrfcState }
  | {
      type: 'WORKFLOW_REVIEW_COMPLETED';
      chainId: string;
      score: number;
      passed: boolean;
      /** Number of constraints that were satisfied (optional; populated in Phase 2+). */
      constraintsSatisfied?: number;
      /** Total number of constraints evaluated (optional; populated in Phase 2+). */
      constraintsTotal?: number;
      /** IDs of constraints that were NOT satisfied (optional; populated in Phase 2+). */
      unsatisfiedConstraintIds?: string[];
    }
  | {
      type: 'WORKFLOW_FIX_ATTEMPTED';
      chainId: string;
      attempt: number;
      maxAttempts: number;
      /** Constraint IDs this fix iteration is targeting (optional; populated in Phase 2+). */
      targetConstraintIds?: string[];
    }
  | { type: 'WORKFLOW_GATE_RESULT'; chainId: string; gate: string; passed: boolean }
  | { type: 'WORKFLOW_CHAIN_PASSED'; chainId: string }
  | { type: 'WORKFLOW_CHAIN_FAILED'; chainId: string; reason: string }
  | { type: 'WORKFLOW_AUTO_COMMITTED'; chainId: string; commitHash?: string }
  | { type: 'WORKFLOW_CASCADE_ABORTED'; chainId: string; reason: string }
  | { type: 'WORKFLOW_CONSTRAINTS_ENUMERATED'; chainId: string; constraints: Constraint[] };

export type WorkflowEventType = WorkflowEvent['type'];
