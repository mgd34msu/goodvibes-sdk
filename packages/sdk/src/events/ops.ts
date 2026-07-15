/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * OpsEvent — discriminated union covering all operator control plane events.
 *
 * These events are emitted when the operator intervenes in task or agent
 * lifecycle via the /ops command or Ctrl+O panel. Every intervention emits
 * an audit event with a reason code for traceability.
 */

/** Reason codes for operator interventions. */
export type OpsInterventionReason =
  | 'user_requested'        // Operator explicitly issued the command
  | 'ops_cancel'            // /ops task cancel
  | 'ops_pause'             // /ops task pause
  | 'ops_resume'            // /ops task resume
  | 'ops_retry'             // /ops task retry
  | 'ops_agent_cancel';     // /ops agent cancel

export type OpsEvent =
  /** Context usage crossed a warning threshold. */
  | {
      type: 'OPS_CONTEXT_WARNING';
      usage: number;
      threshold: number;
      currentTokens?: number | undefined;
      contextWindow?: number | undefined;
      thresholdTokens?: number | undefined;
      remainingTokens?: number | undefined;
      safetyBufferTokens?: number | undefined;
      reason?: 'threshold' | 'safety-buffer' | 'model-warning' | undefined;
    }
  /** Cache hit-rate and token metrics snapshot. */
  | {
      type: 'OPS_CACHE_METRICS';
      hitRate: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalInputTokens: number;
      turns: number;
    }
  /** Helper-model cumulative usage snapshot. */
  | {
      type: 'OPS_HELPER_USAGE';
      inputTokens: number;
      outputTokens: number;
      calls: number;
    }
  /** Operator cancelled a running or queued task. */
  | {
      type: 'OPS_TASK_CANCELLED';
      taskId: string;
      reason: OpsInterventionReason;
      note?: string | undefined;
    }
  /** Operator paused a running task (transitions to blocked). */
  | {
      type: 'OPS_TASK_PAUSED';
      taskId: string;
      reason: OpsInterventionReason;
      note?: string | undefined;
    }
  /** Operator resumed a blocked task. */
  | {
      type: 'OPS_TASK_RESUMED';
      taskId: string;
      reason: OpsInterventionReason;
      note?: string | undefined;
    }
  /** Operator retried a failed or cancelled task. */
  | {
      type: 'OPS_TASK_RETRIED';
      taskId: string;
      reason: OpsInterventionReason;
      note?: string | undefined;
    }
  /** Operator cancelled a running agent. */
  | {
      type: 'OPS_AGENT_CANCELLED';
      agentId: string;
      reason: OpsInterventionReason;
      note?: string | undefined;
    }
  /** Audit trail entry for any ops intervention. */
  | {
      type: 'OPS_AUDIT';
      action: string;
      targetId: string;
      targetKind: 'task' | 'agent';
      reason: OpsInterventionReason;
      note?: string | undefined;
      outcome: 'success' | 'rejected' | 'error';
      errorMessage?: string | undefined;
    }
  /** The host sleep-ownership state changed (work inhibitor, keep-awake toggle, sleep edge). */
  | {
      type: 'OPS_POWER_STATE_CHANGED';
      /** True while any sleep inhibitor (work or keep-awake) is held. */
      inhibited: boolean;
      /** The owner keep-awake toggle ("sleep disabled" chip source). */
      keepAwake: boolean;
      /** Live reasons the work inhibitor is held ("held because X"). */
      workReasons: readonly string[];
      /** The honest-split note when part of the requested coverage was refused. */
      note?: string | undefined;
    }
  /** A subscriber threw an error during event dispatch; emitted after dedup threshold. */
  | {
      type: 'OPS_LISTENER_MISBEHAVING';
      listenerId: string;
      eventType: string;
      errorMessage: string;
      errorCount: number;
    }
  /**
   * The MemoryGovernor crossed a memory-pressure tier, or its leak tripwire
   * fired. Emitted so operators (and supervisors) see the daemon defending its
   * own footprint instead of drifting toward OOM.
   */
  | {
      type: 'OPS_MEMORY_PRESSURE';
      /** The tier now in effect. */
      tier: 'normal' | 'elevated' | 'high' | 'critical';
      /** The tier previously in effect. */
      previousTier: 'normal' | 'elevated' | 'high' | 'critical';
      /** Resident set size, in MB, at the sample that triggered this event. */
      rssMb: number;
      /** Heap used, in MB. */
      heapMb: number;
      /** The configured (or auto-resolved) memory budget, in MB. */
      budgetMb: number;
      /** RSS as a percentage of the budget. */
      usedPct: number;
      /** Present only when the leak tripwire fired: sustained growth after a full flush. */
      tripwire?:
        | {
            rateMbPerSec: number;
            sustainedSec: number;
            /** The action taken — a graceful exit so a supervisor restarts clean. */
            action: 'exit';
          }
        | undefined;
      note?: string | undefined;
    };

/** All ops event type literals as a union. */
export type OpsEventType = OpsEvent['type'];
