import type { KnowledgeEdgeRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from './types.js';

export interface KnowledgeObjectProfilePolicy {
  readonly id: string;
  readonly subjectKinds: readonly KnowledgeNodeRecord['kind'][];
  readonly intrinsicFactKinds?: readonly string[] | undefined;
  readonly suppressedGapKinds?: readonly string[] | undefined;
  readonly searchHints?: readonly string[] | undefined;
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
  readonly objectProfiles?: readonly KnowledgeObjectProfilePolicy[] | undefined;
  readonly pageTemplates?: readonly KnowledgePageTemplate[] | undefined;
  readonly relationshipResolvers?: readonly KnowledgeRelationshipResolver[] | undefined;
  readonly facetProviders?: readonly KnowledgeFacetProvider[] | undefined;
}
