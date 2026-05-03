import type { KnowledgeEdgeRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from './types.js';

export interface KnowledgeObjectProfilePolicy {
  readonly id: string;
  readonly subjectKinds: readonly KnowledgeNodeRecord['kind'][];
  readonly intrinsicFactKinds?: readonly string[];
  readonly suppressedGapKinds?: readonly string[];
  readonly searchHints?: readonly string[];
}

export interface KnowledgePageTemplate {
  readonly id: string;
  readonly subjectKinds: readonly KnowledgeNodeRecord['kind'][];
  readonly render: (input: KnowledgePageTemplateInput) => string | Promise<string>;
}

export interface KnowledgePageTemplateInput {
  readonly subject: KnowledgeNodeRecord;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly facts: readonly KnowledgeNodeRecord[];
  readonly neighbors: readonly KnowledgeEdgeRecord[];
}

export interface KnowledgeRelationshipResolver {
  readonly id: string;
  readonly resolve: (input: KnowledgeRelationshipResolverInput) => readonly KnowledgeEdgeRecord[] | Promise<readonly KnowledgeEdgeRecord[]>;
}

export interface KnowledgeRelationshipResolverInput {
  readonly subject: KnowledgeNodeRecord;
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
}

export interface KnowledgeFacetProvider {
  readonly id: string;
  readonly facets: (input: KnowledgeFacetProviderInput) => Record<string, readonly string[]> | Promise<Record<string, readonly string[]>>;
}

export interface KnowledgeFacetProviderInput {
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
}

export interface KnowledgeExtensionDefinition {
  readonly id: string;
  readonly objectProfiles?: readonly KnowledgeObjectProfilePolicy[];
  readonly pageTemplates?: readonly KnowledgePageTemplate[];
  readonly relationshipResolvers?: readonly KnowledgeRelationshipResolver[];
  readonly facetProviders?: readonly KnowledgeFacetProvider[];
}
