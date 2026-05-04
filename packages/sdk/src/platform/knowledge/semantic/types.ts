import type {
  KnowledgeObjectProfilePolicy,
} from '../extensions.js';
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
  readonly value?: string | undefined;
  readonly summary?: string | undefined;
  readonly evidence?: string | undefined;
  readonly confidence?: number | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly targetHints?: readonly string[] | undefined;
}

export interface KnowledgeSemanticEntityInput {
  readonly title: string;
  readonly kind?: string | undefined;
  readonly aliases?: readonly string[] | undefined;
  readonly summary?: string | undefined;
  readonly confidence?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeSemanticRelationInput {
  readonly from: string;
  readonly relation: string;
  readonly to: string;
  readonly evidence?: string | undefined;
  readonly confidence?: number | undefined;
}

export interface KnowledgeSemanticGapInput {
  readonly question: string;
  readonly reason?: string | undefined;
  readonly subject?: string | undefined;
  readonly severity?: 'info' | 'warning' | 'error' | undefined;
}

export interface KnowledgeSemanticExtraction {
  readonly summary?: string | undefined;
  readonly entities: readonly KnowledgeSemanticEntityInput[];
  readonly facts: readonly KnowledgeSemanticFactInput[];
  readonly relations: readonly KnowledgeSemanticRelationInput[];
  readonly gaps: readonly KnowledgeSemanticGapInput[];
  readonly wikiPage?: {
    readonly title?: string | undefined;
    readonly markdown?: string | undefined;
  };
  readonly extractor: 'llm' | 'deterministic';
}

export interface KnowledgeSemanticLlm {
  completeJson(input: {
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly maxTokens?: number | undefined;
    readonly purpose: string;
    readonly signal?: AbortSignal | undefined;
    readonly timeoutMs?: number | undefined;
  }): Promise<unknown | null>;
  completeText(input: {
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly maxTokens?: number | undefined;
    readonly purpose: string;
    readonly signal?: AbortSignal | undefined;
    readonly timeoutMs?: number | undefined;
  }): Promise<string | null>;
}

export interface KnowledgeSemanticEnrichmentResult {
  readonly source: KnowledgeSourceRecord;
  readonly skipped: boolean;
  readonly reason?: string | undefined;
  readonly extractor?: 'llm' | 'deterministic' | undefined;
  readonly facts: readonly KnowledgeNodeRecord[];
  readonly entities: readonly KnowledgeNodeRecord[];
  readonly wikiPage?: KnowledgeNodeRecord | undefined;
  readonly gaps: readonly KnowledgeNodeRecord[];
}

export interface KnowledgeSemanticAnswerInput {
  readonly query: string;
  readonly knowledgeSpaceId?: string | undefined;
  readonly mode?: 'concise' | 'standard' | 'detailed' | undefined;
  readonly limit?: number | undefined;
  readonly includeSources?: boolean | undefined;
  readonly includeConfidence?: boolean | undefined;
  readonly includeLinkedObjects?: boolean | undefined;
  readonly candidateSourceIds?: readonly string[] | undefined;
  readonly candidateNodeIds?: readonly string[] | undefined;
  readonly strictCandidates?: boolean | undefined;
  readonly linkedObjects?: readonly KnowledgeNodeRecord[] | undefined;
  readonly noMatchMessage?: string | undefined;
  readonly autoRepairGaps?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface KnowledgeSemanticAnswer {
  readonly text: string;
  readonly mode: string;
  readonly confidence: number;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly linkedObjects: readonly KnowledgeNodeRecord[];
  readonly facts: readonly KnowledgeNodeRecord[];
  readonly gaps: readonly KnowledgeNodeRecord[];
  readonly refinementTaskIds?: readonly string[] | undefined;
  readonly refinement?: KnowledgeSemanticAnswerRefinement | undefined;
  readonly synthesized: boolean;
}

export interface KnowledgeSemanticAnswerRefinement {
  readonly status: 'not_needed' | 'repaired' | 'deferred' | 'active' | 'incomplete';
  readonly reason?: string | undefined;
  readonly repairStatus?: string | undefined;
  readonly refinementTaskIds: readonly string[];
  readonly acceptedSourceIds: readonly string[];
  readonly promotedFactCount: number;
  readonly nextRepairAttemptAt?: number | undefined;
  readonly waitedMs?: number | undefined;
  readonly answerCacheInvalidated?: boolean | undefined;
  readonly pageRefreshRequested?: boolean | undefined;
  readonly pageRefreshed?: boolean | undefined;
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
  readonly confidence?: number | undefined;
  readonly usedSourceIds?: readonly string[] | undefined;
  readonly usedNodeIds?: readonly string[] | undefined;
  readonly gaps?: readonly KnowledgeSemanticGapInput[] | undefined;
}

export interface KnowledgeSemanticGapRepairRequest {
  readonly spaceId: string;
  readonly query: string;
  readonly gaps: readonly KnowledgeNodeRecord[];
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly linkedObjects: readonly KnowledgeNodeRecord[];
  readonly facts: readonly KnowledgeNodeRecord[];
  readonly maxSources?: number | undefined;
  readonly deadlineAt?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface KnowledgeSemanticGapRepairResult {
  readonly searched: boolean;
  readonly query?: string | undefined;
  readonly evidenceSufficient?: boolean | undefined;
  readonly acceptedSourceIds?: readonly string[] | undefined;
  readonly ingestedSourceIds: readonly string[];
  readonly skippedUrls: readonly string[];
  readonly sourceAssessments?: readonly KnowledgeRefinementSourceAssessment[] | undefined;
  readonly reason?: string | undefined;
}

export type KnowledgeSemanticGapRepairer = (
  request: KnowledgeSemanticGapRepairRequest,
) => Promise<KnowledgeSemanticGapRepairResult | void>;

export interface KnowledgeSemanticSelfImproveInput {
  readonly knowledgeSpaceId?: string | undefined;
  readonly sourceIds?: readonly string[] | undefined;
  readonly gapIds?: readonly string[] | undefined;
  readonly limit?: number | undefined;
  readonly maxRunMs?: number | undefined;
  readonly deferRepair?: boolean | undefined;
  readonly force?: boolean | undefined;
  readonly reason?: 'ingest' | 'homegraph-sync' | 'reindex' | 'scheduled' | 'answer' | 'manual' | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly objectProfiles?: readonly KnowledgeObjectProfilePolicy[] | undefined;
}

export interface KnowledgeSemanticSelfImproveResult {
  readonly scannedGaps: number;
  readonly candidateGaps?: number | undefined;
  readonly processedGaps?: number | undefined;
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
  readonly requestedLimit?: number | undefined;
  readonly effectiveLimit?: number | undefined;
  readonly coalesced?: boolean | undefined;
  readonly truncated?: boolean | undefined;
  readonly budgetExhausted?: boolean | undefined;
  readonly taskIds: readonly string[];
  readonly ingestedSourceIds: readonly string[];
  readonly acceptedSourceIds?: readonly string[] | undefined;
  readonly promotedFactCount?: number | undefined;
  readonly nextRepairAttemptAt?: number | undefined;
  readonly errors: readonly { readonly gapId: string; readonly error: string }[];
}
