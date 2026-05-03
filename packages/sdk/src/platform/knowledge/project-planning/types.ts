import type { KnowledgeSourceRecord } from '../types.js';

export type ProjectPlanningReadiness = 'not-ready' | 'needs-user-input' | 'executable';

export type ProjectPlanningQuestionStatus = 'open' | 'answered' | 'skipped';
export type ProjectPlanningTaskStatus = 'pending' | 'in-progress' | 'blocked' | 'completed' | 'deferred';
export type ProjectPlanningGateStatus = 'pending' | 'passed' | 'failed' | 'skipped';
export type ProjectPlanningDecisionStatus = 'proposed' | 'accepted' | 'superseded' | 'rejected';
export type ProjectPlanningGapSeverity = 'blocking' | 'advisory';
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
  readonly projectId?: string;
  readonly knowledgeSpaceId?: string;
}

export interface ProjectPlanningQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly whyItMatters?: string;
  readonly recommendedAnswer?: string;
  readonly consequence?: string;
  readonly status?: ProjectPlanningQuestionStatus;
  readonly answer?: string;
  readonly answeredAt?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface ProjectPlanningDecision {
  readonly id: string;
  readonly title: string;
  readonly context?: string;
  readonly decision: string;
  readonly alternatives?: readonly string[];
  readonly reasoning?: string;
  readonly consequences?: readonly string[];
  readonly status?: ProjectPlanningDecisionStatus;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface ProjectPlanningTerm {
  readonly term: string;
  readonly definition: string;
  readonly avoid?: readonly string[];
  readonly aliases?: readonly string[];
  readonly relationships?: readonly string[];
  readonly examples?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

export interface ProjectPlanningAmbiguity {
  readonly phrase: string;
  readonly resolution: string;
  readonly examples?: readonly string[];
  readonly resolvedAt?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface ProjectPlanningLanguageArtifact {
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly terms: readonly ProjectPlanningTerm[];
  readonly ambiguities: readonly ProjectPlanningAmbiguity[];
  readonly examples?: readonly string[];
  readonly updatedAt: number;
  readonly metadata?: Record<string, unknown>;
}

export interface ProjectPlanningTask {
  readonly id: string;
  readonly title: string;
  readonly why?: string;
  readonly status?: ProjectPlanningTaskStatus;
  readonly dependencies?: readonly string[];
  readonly likelyFiles?: readonly string[];
  readonly verification?: readonly string[];
  readonly canRunConcurrently?: boolean;
  readonly needsReview?: boolean;
  readonly blockedOnUserInput?: boolean;
  readonly recommendedAgent?: 'explorer' | 'worker' | 'none' | string;
  readonly metadata?: Record<string, unknown>;
}

export interface ProjectPlanningDependency {
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly reason?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ProjectPlanningVerificationGate {
  readonly id: string;
  readonly description: string;
  readonly status?: ProjectPlanningGateStatus;
  readonly command?: string;
  readonly evidence?: string;
  readonly required?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface ProjectPlanningAgentAssignment {
  readonly taskId: string;
  readonly agentType?: 'explorer' | 'worker' | 'none' | string;
  readonly scope?: readonly string[];
  readonly expectedOutput?: string;
  readonly verification?: string;
  readonly canRunConcurrently?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface ProjectPlanningState {
  readonly id: string;
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly goal: string;
  readonly scope?: string;
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
  readonly metadata?: Record<string, unknown>;
}

export interface ProjectPlanningGap {
  readonly id: string;
  readonly kind: ProjectPlanningGapKind;
  readonly severity: ProjectPlanningGapSeverity;
  readonly message: string;
  readonly question?: ProjectPlanningQuestion;
  readonly relatedTaskIds?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

export interface ProjectPlanningEvaluation {
  readonly ok: true;
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly readiness: ProjectPlanningReadiness;
  readonly gaps: readonly ProjectPlanningGap[];
  readonly nextQuestion?: ProjectPlanningQuestion;
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
  };
  readonly capabilities: readonly string[];
}

export interface ProjectPlanningStateUpsertInput extends ProjectPlanningSpaceInput {
  readonly state: Partial<ProjectPlanningState> & { readonly goal?: string };
}

export interface ProjectPlanningEvaluateInput extends ProjectPlanningSpaceInput {
  readonly state?: Partial<ProjectPlanningState> & { readonly goal?: string };
  readonly planningId?: string;
}

export interface ProjectPlanningStateResult {
  readonly ok: true;
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly state: ProjectPlanningState | null;
  readonly source?: KnowledgeSourceRecord;
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
    readonly terms?: readonly ProjectPlanningTerm[];
    readonly ambiguities?: readonly ProjectPlanningAmbiguity[];
  };
}

export interface ProjectPlanningLanguageResult {
  readonly ok: true;
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
  readonly language: ProjectPlanningLanguageArtifact | null;
  readonly source?: KnowledgeSourceRecord;
}

