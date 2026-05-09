import type { KnowledgeSourceRecord } from '../types.js';

export type ProjectPlanningReadiness = 'not-ready' | 'needs-user-input' | 'executable';

export type ProjectPlanningQuestionStatus = 'open' | 'answered' | 'skipped';
export type ProjectPlanningTaskStatus = 'pending' | 'in-progress' | 'blocked' | 'completed' | 'deferred';
export type ProjectPlanningGateStatus = 'pending' | 'passed' | 'failed' | 'skipped';
export type ProjectPlanningDecisionStatus = 'proposed' | 'accepted' | 'superseded' | 'rejected';
export type ProjectPlanningGapSeverity = 'blocking' | 'advisory';
export type ProjectWorkPlanTaskStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'failed' | 'cancelled';
export type ProjectWorkPlanTaskMutationSource =
  | 'user'
  | 'planning'
  | 'wrfc'
  | 'agent'
  | 'daemon'
  | 'migration'
  | 'api'
  | string;
export type ProjectPlanningGapKind =
  | 'missing-goal'
  | 'missing-scope'
  | 'open-question'
  | 'ambiguous-language'
  | 'missing-tasks'
  | 'missing-dependencies'
  | 'missing-verification'
  | 'unapproved-execution';

export interface ProjectPlanningSpaceInput {
  readonly projectId?: string | undefined;
  readonly knowledgeSpaceId?: string | undefined;
}

export interface ProjectWorkPlanTask {
  readonly taskId: string;
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly title: string;
  readonly notes?: string | undefined;
  readonly owner?: string | undefined;
  readonly status: ProjectWorkPlanTaskStatus;
  readonly priority?: number | undefined;
  readonly order: number;
  readonly source?: ProjectWorkPlanTaskMutationSource | undefined;
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

export interface ProjectWorkPlanArtifact {
  readonly id: string;
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly tasks: readonly ProjectWorkPlanTask[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ProjectWorkPlanCounts {
  readonly total: number;
  readonly pending: number;
  readonly in_progress: number;
  readonly blocked: number;
  readonly done: number;
  readonly failed: number;
  readonly cancelled: number;
}

export interface ProjectWorkPlanSnapshot {
  readonly ok: true;
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly workPlanId: string;
  readonly tasks: readonly ProjectWorkPlanTask[];
  readonly counts: ProjectWorkPlanCounts;
  readonly updatedAt: number;
}

export interface ProjectWorkPlanTaskCreateInput extends ProjectPlanningSpaceInput {
  readonly workPlanId?: string | undefined;
  readonly task: {
    readonly taskId?: string | undefined;
    readonly title: string;
    readonly notes?: string | undefined;
    readonly owner?: string | undefined;
    readonly status?: ProjectWorkPlanTaskStatus | undefined;
    readonly priority?: number | undefined;
    readonly order?: number | undefined;
    readonly source?: ProjectWorkPlanTaskMutationSource | undefined;
    readonly tags?: readonly string[] | undefined;
    readonly parentTaskId?: string | undefined;
    readonly chainId?: string | undefined;
    readonly phaseId?: string | undefined;
    readonly agentId?: string | undefined;
    readonly turnId?: string | undefined;
    readonly decisionId?: string | undefined;
    readonly sourceMessageId?: string | undefined;
    readonly linkedArtifactIds?: readonly string[] | undefined;
    readonly linkedSourceIds?: readonly string[] | undefined;
    readonly linkedNodeIds?: readonly string[] | undefined;
    readonly originSurface?: string | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  };
}

export interface ProjectWorkPlanTaskUpdateInput extends ProjectPlanningSpaceInput {
  readonly workPlanId?: string | undefined;
  readonly taskId: string;
  readonly patch: Partial<Omit<ProjectWorkPlanTask, 'taskId' | 'projectId' | 'knowledgeSpaceId' | 'createdAt' | 'updatedAt'>>;
}

export interface ProjectWorkPlanTaskStatusInput extends ProjectPlanningSpaceInput {
  readonly workPlanId?: string | undefined;
  readonly taskId: string;
  readonly status: ProjectWorkPlanTaskStatus;
  readonly reason?: string | undefined;
  readonly source?: ProjectWorkPlanTaskMutationSource | undefined;
}

export interface ProjectWorkPlanTaskGetInput extends ProjectPlanningSpaceInput {
  readonly workPlanId?: string | undefined;
  readonly taskId: string;
}

export interface ProjectWorkPlanTaskDeleteInput extends ProjectPlanningSpaceInput {
  readonly workPlanId?: string | undefined;
  readonly taskId: string;
}

export interface ProjectWorkPlanTaskReorderInput extends ProjectPlanningSpaceInput {
  readonly workPlanId?: string | undefined;
  readonly orderedTaskIds: readonly string[];
}

export interface ProjectWorkPlanTaskListInput extends ProjectPlanningSpaceInput {
  readonly workPlanId?: string | undefined;
  readonly status?: ProjectWorkPlanTaskStatus | undefined;
  readonly parentTaskId?: string | undefined;
  readonly chainId?: string | undefined;
  readonly owner?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ProjectWorkPlanClearCompletedInput extends ProjectPlanningSpaceInput {
  readonly workPlanId?: string | undefined;
  readonly statuses?: readonly ProjectWorkPlanTaskStatus[] | undefined;
}

export interface ProjectWorkPlanTaskResult {
  readonly ok: true;
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly workPlanId: string;
  readonly task: ProjectWorkPlanTask | null;
  readonly snapshot: ProjectWorkPlanSnapshot;
}

export interface ProjectWorkPlanMutationResult {
  readonly ok: true;
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly workPlanId: string;
  readonly task?: ProjectWorkPlanTask | undefined;
  readonly previousTask?: ProjectWorkPlanTask | undefined;
  readonly deletedTask?: ProjectWorkPlanTask | undefined;
  readonly clearedTaskIds?: readonly string[] | undefined;
  readonly snapshot: ProjectWorkPlanSnapshot;
}

export interface ProjectPlanningQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly whyItMatters?: string | undefined;
  readonly recommendedAnswer?: string | undefined;
  readonly consequence?: string | undefined;
  readonly status?: ProjectPlanningQuestionStatus | undefined;
  readonly answer?: string | undefined;
  readonly answeredAt?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ProjectPlanningDecision {
  readonly id: string;
  readonly title: string;
  readonly context?: string | undefined;
  readonly decision: string;
  readonly alternatives?: readonly string[] | undefined;
  readonly reasoning?: string | undefined;
  readonly consequences?: readonly string[] | undefined;
  readonly status?: ProjectPlanningDecisionStatus | undefined;
  readonly createdAt?: number | undefined;
  readonly updatedAt?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ProjectPlanningTerm {
  readonly term: string;
  readonly definition: string;
  readonly avoid?: readonly string[] | undefined;
  readonly aliases?: readonly string[] | undefined;
  readonly relationships?: readonly string[] | undefined;
  readonly examples?: readonly string[] | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ProjectPlanningAmbiguity {
  readonly phrase: string;
  readonly resolution: string;
  readonly examples?: readonly string[] | undefined;
  readonly resolvedAt?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ProjectPlanningLanguageArtifact {
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly terms: readonly ProjectPlanningTerm[];
  readonly ambiguities: readonly ProjectPlanningAmbiguity[];
  readonly examples?: readonly string[] | undefined;
  readonly updatedAt: number;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ProjectPlanningTask {
  readonly id: string;
  readonly title: string;
  readonly why?: string | undefined;
  readonly status?: ProjectPlanningTaskStatus | undefined;
  readonly dependencies?: readonly string[] | undefined;
  readonly likelyFiles?: readonly string[] | undefined;
  readonly verification?: readonly string[] | undefined;
  readonly canRunConcurrently?: boolean | undefined;
  readonly needsReview?: boolean | undefined;
  readonly blockedOnUserInput?: boolean | undefined;
  readonly recommendedAgent?: 'explorer' | 'worker' | 'none' | string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ProjectPlanningDependency {
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly reason?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ProjectPlanningVerificationGate {
  readonly id: string;
  readonly description: string;
  readonly status?: ProjectPlanningGateStatus | undefined;
  readonly command?: string | undefined;
  readonly evidence?: string | undefined;
  readonly required?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ProjectPlanningAgentAssignment {
  readonly taskId: string;
  readonly agentType?: 'explorer' | 'worker' | 'none' | string | undefined;
  readonly scope?: readonly string[] | undefined;
  readonly expectedOutput?: string | undefined;
  readonly verification?: string | undefined;
  readonly canRunConcurrently?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ProjectPlanningState {
  readonly id: string;
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly goal: string;
  readonly scope?: string | undefined;
  readonly knownContext: readonly string[];
  readonly openQuestions: readonly ProjectPlanningQuestion[];
  readonly answeredQuestions: readonly ProjectPlanningQuestion[];
  readonly decisions: readonly ProjectPlanningDecision[];
  readonly assumptions: readonly string[];
  readonly constraints: readonly string[];
  readonly risks: readonly string[];
  readonly tasks: readonly ProjectPlanningTask[];
  readonly dependencies: readonly ProjectPlanningDependency[];
  readonly verificationGates: readonly ProjectPlanningVerificationGate[];
  readonly agentAssignments: readonly ProjectPlanningAgentAssignment[];
  readonly readiness: ProjectPlanningReadiness;
  readonly executionApproved: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ProjectPlanningGap {
  readonly id: string;
  readonly kind: ProjectPlanningGapKind;
  readonly severity: ProjectPlanningGapSeverity;
  readonly message: string;
  readonly question?: ProjectPlanningQuestion | undefined;
  readonly relatedTaskIds?: readonly string[] | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ProjectPlanningEvaluation {
  readonly ok: true;
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly readiness: ProjectPlanningReadiness;
  readonly gaps: readonly ProjectPlanningGap[];
  readonly nextQuestion?: ProjectPlanningQuestion | undefined;
  readonly state: ProjectPlanningState;
}

export interface ProjectPlanningStatus {
  readonly ok: true;
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly passiveOnly: true;
  readonly counts: {
    readonly states: number;
    readonly decisions: number;
    readonly languageArtifacts: number;
    readonly workPlans: number;
    readonly workPlanTasks: number;
  };
  readonly capabilities: readonly string[];
}

export interface ProjectPlanningStateUpsertInput extends ProjectPlanningSpaceInput {
  readonly state: Partial<ProjectPlanningState> & { readonly goal?: string };
}

export interface ProjectPlanningEvaluateInput extends ProjectPlanningSpaceInput {
  readonly state?: Partial<ProjectPlanningState> & { readonly goal?: string } | undefined;
  readonly planningId?: string | undefined;
}

export interface ProjectPlanningStateResult {
  readonly ok: true;
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly state: ProjectPlanningState | null;
  readonly source?: KnowledgeSourceRecord | undefined;
}

export interface ProjectPlanningDecisionRecordInput extends ProjectPlanningSpaceInput {
  readonly decision: Partial<ProjectPlanningDecision> & {
    readonly title: string;
    readonly decision: string;
  };
}

export interface ProjectPlanningDecisionResult {
  readonly ok: true;
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly decision: ProjectPlanningDecision;
  readonly source: KnowledgeSourceRecord;
}

export interface ProjectPlanningDecisionsResult {
  readonly ok: true;
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly decisions: readonly ProjectPlanningDecision[];
}

export interface ProjectPlanningLanguageUpsertInput extends ProjectPlanningSpaceInput {
  readonly language: Partial<ProjectPlanningLanguageArtifact> & {
    readonly terms?: readonly ProjectPlanningTerm[] | undefined;
    readonly ambiguities?: readonly ProjectPlanningAmbiguity[] | undefined;
  };
}

export interface ProjectPlanningLanguageResult {
  readonly ok: true;
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly language: ProjectPlanningLanguageArtifact | null;
  readonly source?: KnowledgeSourceRecord | undefined;
}
