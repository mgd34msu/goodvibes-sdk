import type {
  KnowledgeNodeRecord,
  KnowledgeRefinementSourceAssessment,
  KnowledgeSearchResult,
  KnowledgeSourceRecord,
} from '../types.js';

export type KnowledgeSemanticFactKind =
  | 'feature'
  | 'capability'
  | 'specification'
  | 'identity'
  | 'procedure'
  | 'warning'
  | 'maintenance'
  | 'compatibility'
  | 'configuration'
  | 'troubleshooting'
  | 'relationship'
  | 'note';

export interface KnowledgeSemanticFactInput {
  readonly kind: KnowledgeSemanticFactKind;
  readonly title: string;
  readonly value?: string;
  readonly summary?: string;
  readonly evidence?: string;
  readonly confidence?: number;
  readonly labels?: readonly string[];
  readonly targetHints?: readonly string[];
}

export interface KnowledgeSemanticEntityInput {
  readonly title: string;
  readonly kind?: string;
  readonly aliases?: readonly string[];
  readonly summary?: string;
  readonly confidence?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface KnowledgeSemanticRelationInput {
  readonly from: string;
  readonly relation: string;
  readonly to: string;
  readonly evidence?: string;
  readonly confidence?: number;
}

export interface KnowledgeSemanticGapInput {
  readonly question: string;
  readonly reason?: string;
  readonly subject?: string;
  readonly severity?: 'info' | 'warning' | 'error';
}

export interface KnowledgeSemanticExtraction {
  readonly summary?: string;
  readonly entities: readonly KnowledgeSemanticEntityInput[];
  readonly facts: readonly KnowledgeSemanticFactInput[];
  readonly relations: readonly KnowledgeSemanticRelationInput[];
  readonly gaps: readonly KnowledgeSemanticGapInput[];
  readonly wikiPage?: {
    readonly title?: string;
    readonly markdown?: string;
  };
  readonly extractor: 'llm' | 'deterministic';
}

export interface KnowledgeSemanticLlm {
  completeJson(input: {
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly maxTokens?: number;
    readonly purpose: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<unknown | null>;
  completeText(input: {
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly maxTokens?: number;
    readonly purpose: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<string | null>;
}

export interface KnowledgeSemanticEnrichmentResult {
  readonly source: KnowledgeSourceRecord;
  readonly skipped: boolean;
  readonly reason?: string;
  readonly extractor?: 'llm' | 'deterministic';
  readonly facts: readonly KnowledgeNodeRecord[];
  readonly entities: readonly KnowledgeNodeRecord[];
  readonly wikiPage?: KnowledgeNodeRecord;
  readonly gaps: readonly KnowledgeNodeRecord[];
}

export interface KnowledgeSemanticAnswerInput {
  readonly query: string;
  readonly knowledgeSpaceId?: string;
  readonly mode?: 'concise' | 'standard' | 'detailed';
  readonly limit?: number;
  readonly includeSources?: boolean;
  readonly includeConfidence?: boolean;
  readonly includeLinkedObjects?: boolean;
  readonly candidateSourceIds?: readonly string[];
  readonly candidateNodeIds?: readonly string[];
  readonly strictCandidates?: boolean;
  readonly linkedObjects?: readonly KnowledgeNodeRecord[];
  readonly noMatchMessage?: string;
  readonly autoRepairGaps?: boolean;
  readonly timeoutMs?: number;
}

export interface KnowledgeSemanticAnswer {
  readonly text: string;
  readonly mode: string;
  readonly confidence: number;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly linkedObjects: readonly KnowledgeNodeRecord[];
  readonly facts: readonly KnowledgeNodeRecord[];
  readonly gaps: readonly KnowledgeNodeRecord[];
  readonly refinementTaskIds?: readonly string[];
  readonly refinement?: KnowledgeSemanticAnswerRefinement;
  readonly synthesized: boolean;
}

export interface KnowledgeSemanticAnswerRefinement {
  readonly status: 'not_needed' | 'repaired' | 'deferred' | 'active' | 'incomplete';
  readonly reason?: string;
  readonly repairStatus?: string;
  readonly refinementTaskIds: readonly string[];
  readonly acceptedSourceIds: readonly string[];
  readonly promotedFactCount: number;
  readonly nextRepairAttemptAt?: number;
  readonly waitedMs?: number;
  readonly answerCacheInvalidated?: boolean;
  readonly pageRefreshRequested?: boolean;
  readonly pageRefreshed?: boolean;
}

export interface KnowledgeSemanticAnswerResult {
  readonly ok: true;
  readonly spaceId: string;
  readonly query: string;
  readonly answer: KnowledgeSemanticAnswer;
  readonly results: readonly KnowledgeSearchResult[];
}

export interface KnowledgeSemanticLlmAnswer {
  readonly answer: string;
  readonly confidence?: number;
  readonly usedSourceIds?: readonly string[];
  readonly usedNodeIds?: readonly string[];
  readonly gaps?: readonly KnowledgeSemanticGapInput[];
}

export interface KnowledgeSemanticGapRepairRequest {
  readonly spaceId: string;
  readonly query: string;
  readonly gaps: readonly KnowledgeNodeRecord[];
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly linkedObjects: readonly KnowledgeNodeRecord[];
  readonly facts: readonly KnowledgeNodeRecord[];
  readonly maxSources?: number;
  readonly deadlineAt?: number;
  readonly signal?: AbortSignal;
}

export interface KnowledgeSemanticGapRepairResult {
  readonly searched: boolean;
  readonly query?: string;
  readonly evidenceSufficient?: boolean;
  readonly acceptedSourceIds?: readonly string[];
  readonly ingestedSourceIds: readonly string[];
  readonly skippedUrls: readonly string[];
  readonly sourceAssessments?: readonly KnowledgeRefinementSourceAssessment[];
  readonly reason?: string;
}

export type KnowledgeSemanticGapRepairer = (
  request: KnowledgeSemanticGapRepairRequest,
) => Promise<KnowledgeSemanticGapRepairResult | void>;

export interface KnowledgeSemanticSelfImproveInput {
  readonly knowledgeSpaceId?: string;
  readonly sourceIds?: readonly string[];
  readonly gapIds?: readonly string[];
  readonly limit?: number;
  readonly maxRunMs?: number;
  readonly deferRepair?: boolean;
  readonly force?: boolean;
  readonly reason?: 'ingest' | 'homegraph-sync' | 'reindex' | 'scheduled' | 'answer' | 'manual';
}

export interface KnowledgeSemanticSelfImproveResult {
  readonly scannedGaps: number;
  readonly candidateGaps?: number;
  readonly processedGaps?: number;
  readonly createdGaps: number;
  readonly repairableGaps: number;
  readonly suppressedGaps: number;
  readonly skippedGaps: number;
  readonly searched: number;
  readonly ingestedSources: number;
  readonly linkedRepairs: number;
  readonly blockedGaps: number;
  readonly closedGaps: number;
  readonly queuedTasks: number;
  readonly requestedLimit?: number;
  readonly effectiveLimit?: number;
  readonly coalesced?: boolean;
  readonly truncated?: boolean;
  readonly budgetExhausted?: boolean;
  readonly taskIds: readonly string[];
  readonly ingestedSourceIds: readonly string[];
  readonly acceptedSourceIds?: readonly string[];
  readonly promotedFactCount?: number;
  readonly nextRepairAttemptAt?: number;
  readonly errors: readonly { readonly gapId: string; readonly error: string }[];
}
