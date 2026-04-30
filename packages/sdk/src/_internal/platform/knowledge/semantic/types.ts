import type {
  KnowledgeNodeRecord,
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
  }): Promise<unknown | null>;
  completeText(input: {
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly maxTokens?: number;
    readonly purpose: string;
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
  readonly linkedObjects?: readonly KnowledgeNodeRecord[];
  readonly noMatchMessage?: string;
}

export interface KnowledgeSemanticAnswer {
  readonly text: string;
  readonly mode: string;
  readonly confidence: number;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly linkedObjects: readonly KnowledgeNodeRecord[];
  readonly facts: readonly KnowledgeNodeRecord[];
  readonly gaps: readonly KnowledgeNodeRecord[];
  readonly synthesized: boolean;
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
