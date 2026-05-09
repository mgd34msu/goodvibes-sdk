/**
 * PlannerEvent — discriminated union for adaptive planner decisions and overrides.
 */

export type ExecutionStrategy = 'auto' | 'single' | 'cohort' | 'background' | 'remote';

export interface StrategyCandidate {
  readonly strategy: ExecutionStrategy;
  readonly score: number;
  readonly reasonCode: string;
}

export interface PlannerDecision {
  readonly selected: ExecutionStrategy;
  readonly reasonCode: string;
  readonly candidates: readonly StrategyCandidate[];
  readonly overrideActive: boolean;
  readonly timestamp: number;
  readonly inputs: {
    readonly riskScore: number;
    readonly latencyBudgetMs: number;
    readonly isMultiStep: boolean;
    readonly remoteAvailable: boolean;
    readonly backgroundEligible: boolean;
    readonly taskDescription?: string | undefined;
  };
}

export type WorkPlanTaskStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'failed' | 'cancelled';

export interface WorkPlanTaskEventRecord {
  readonly taskId: string;
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly title: string;
  readonly notes?: string | undefined;
  readonly owner?: string | undefined;
  readonly status: WorkPlanTaskStatus;
  readonly priority?: number | undefined;
  readonly order: number;
  readonly source?: string | undefined;
  readonly tags: readonly string[];
  readonly parentTaskId?: string | undefined;
  readonly chainId?: string | undefined;
  readonly phaseId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly decisionId?: string | undefined;
  readonly sourceMessageId?: string | undefined;
  readonly linkedArtifactIds: readonly string[];
  readonly linkedSourceIds: readonly string[];
  readonly linkedNodeIds: readonly string[];
  readonly originSurface?: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface WorkPlanEventBase {
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly workPlanId: string;
}

export interface WorkPlanSnapshotEventRecord extends WorkPlanEventBase {
  readonly tasks: readonly WorkPlanTaskEventRecord[];
  readonly counts: {
    readonly total: number;
    readonly pending: number;
    readonly in_progress: number;
    readonly blocked: number;
    readonly done: number;
    readonly failed: number;
    readonly cancelled: number;
  };
  readonly updatedAt: number;
}

export type PlannerEvent =
  | ({
    type: 'PLAN_STRATEGY_SELECTED';
  } & PlannerDecision)
  | {
    type: 'PLAN_STRATEGY_OVERRIDDEN';
    strategy: ExecutionStrategy | null;
    clearedBy?: string | undefined;
  }
  | ({
    type: 'WORK_PLAN_TASK_CREATED';
    task: WorkPlanTaskEventRecord;
  } & WorkPlanEventBase)
  | ({
    type: 'WORK_PLAN_TASK_UPDATED';
    task: WorkPlanTaskEventRecord;
    previousTask: WorkPlanTaskEventRecord;
  } & WorkPlanEventBase)
  | ({
    type: 'WORK_PLAN_TASK_STATUS_CHANGED';
    taskId: string;
    status: WorkPlanTaskStatus;
    previousStatus: WorkPlanTaskStatus;
    task: WorkPlanTaskEventRecord;
  } & WorkPlanEventBase)
  | ({
    type: 'WORK_PLAN_TASK_DELETED';
    taskId: string;
    task: WorkPlanTaskEventRecord;
  } & WorkPlanEventBase)
  | ({
    type: 'WORK_PLAN_SNAPSHOT_INVALIDATED';
    reason: string;
    snapshot: WorkPlanSnapshotEventRecord;
  } & WorkPlanEventBase);

export type PlannerEventType = PlannerEvent['type'];
