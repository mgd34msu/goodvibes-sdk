/**
 * WorkflowEvent — discriminated union for WRFC workflow lifecycle events.
 */

export interface Constraint {
  readonly id: string;
  readonly text: string;
  readonly source: 'prompt';
}

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

export type WorkflowEvent =
  | { type: 'WORKFLOW_CHAIN_CREATED'; chainId: string; task: string }
  | { type: 'WORKFLOW_STATE_CHANGED'; chainId: string; from: WrfcState; to: WrfcState }
  | {
      type: 'WORKFLOW_REVIEW_COMPLETED';
      chainId: string;
      score: number;
      passed: boolean;
      /** Number of satisfied constraint findings. Present when the chain has constraints. */
      constraintsSatisfied?: number | undefined;
      /** Total constraint findings evaluated. Present when the chain has constraints. */
      constraintsTotal?: number | undefined;
      /** IDs of constraints that were not satisfied. Present when the chain has constraints. */
      unsatisfiedConstraintIds?: string[] | undefined;
    }
  | {
      type: 'WORKFLOW_FIX_ATTEMPTED';
      chainId: string;
      attempt: number;
      maxAttempts: number;
      /** Constraint IDs this fix iteration is targeting. Present when unresolved constraints are being addressed. */
      targetConstraintIds?: string[] | undefined;
    }
  | { type: 'WORKFLOW_GATE_RESULT'; chainId: string; gate: string; passed: boolean }
  | { type: 'WORKFLOW_CHAIN_PASSED'; chainId: string }
  | {
      type: 'WORKFLOW_CHAIN_FAILED';
      chainId: string;
      reason: string;
      /**
       * Why the chain reached its terminal state. 'transport' means a transient
       * network/transport error that had already exhausted its automatic retry
       * budget (see WrfcChain.transportRetryCount); 'cancelled' means an operator
       * killed/interrupted the chain (an intended stop, NOT a failure — narrate it
       * as cancelled); 'max_turns' means a member agent spent its whole turn
       * budget (a machine-readable turn-budget exhaustion, distinct from an
       * infrastructure error, so a consumer never has to regex the reason);
       * absent/'other' covers ordinary review/gate rejections and anything else.
       * Optional so existing consumers keep working unchanged.
       */
      failureKind?: 'transport' | 'other' | 'cancelled' | 'max_turns' | undefined;
      /** On a 'max_turns' failure: the turn ceiling that applied. */
      turnLimit?: number | undefined;
      /** On a 'max_turns' failure: which input set the ceiling (default / spawn-override / policy-bound). */
      turnLimitSource?: 'default' | 'spawn-override' | 'policy-bound' | undefined;
      /**
       * Whether EVERY chain member (owner + children) was already terminal when
       * this outcome was emitted — the explicit quiescence signal. True means the
       * outcome landed at true quiescence and a consumer can finalize immediately;
       * false means members are still winding down (their own terminal AGENT_*
       * events are still to come), so a consumer that needs full quiescence should
       * await those before finalizing rather than polling. Absent on consumers
       * that predate the field.
       */
      membersSettled?: boolean | undefined;
    }
  | { type: 'WORKFLOW_AUTO_COMMITTED'; chainId: string; commitHash?: string | undefined }
  | { type: 'WORKFLOW_CASCADE_ABORTED'; chainId: string; reason: string }
  | { type: 'WORKFLOW_CONSTRAINTS_ENUMERATED'; chainId: string; constraints: Constraint[] }
  | { type: 'WORKFLOW_SCORE_REGRESSION'; chainId: string; reason: string };

export type WorkflowEventType = WorkflowEvent['type'];
