import type {
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeMapFilterInput,
  KnowledgeMapEdge,
  KnowledgeMapNode,
  KnowledgeMapResult,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import type { KnowledgeSemanticSelfImproveResult } from '../semantic/index.js';
import type { KnowledgeSemanticAnswerRefinement } from '../semantic/index.js';

export const HOME_GRAPH_NODE_KINDS = [
  'ha_home',
  'ha_entity',
  'ha_device',
  'ha_area',
  'ha_automation',
  'ha_script',
  'ha_scene',
  'ha_label',
  'ha_integration',
  'ha_room',
  'ha_device_passport',
  'ha_maintenance_item',
  'ha_troubleshooting_case',
  'ha_purchase',
  'ha_network_node',
] as const;

export type HomeGraphNodeKind = typeof HOME_GRAPH_NODE_KINDS[number];

export const HOME_GRAPH_RELATIONS = [
  'controls',
  'located_in',
  'belongs_to_device',
  'has_manual',
  'has_receipt',
  'has_warranty',
  'has_issue',
  'fixed_by',
  'uses_battery',
  'connected_via',
  'part_of_network',
  'mentioned_by',
  'source_for',
] as const;

export type HomeGraphRelation = typeof HOME_GRAPH_RELATIONS[number];

export const HOME_GRAPH_CAPABILITIES = [
  'knowledge-space-isolation',
  'snapshot-sync',
  'source-backed-ingest',
  'semantic-enrichment',
  'semantic-self-improvement',
  'llm-answer-synthesis',
  'knowledge-linking',
  'ask-home-graph',
  'device-passports',
  'room-pages',
  'automatic-page-generation',
  'visual-knowledge-map',
  'packets',
  'source-inventory',
  'review-queue',
  'durable-review-decisions',
  'quality-rule-heuristics',
  'documentation-candidates',
  'export-import',
  'space-reset',
  'namespace-aware-graph-browse',
] as const;

export type HomeGraphObjectKind =
  | 'home'
  | 'entity'
  | 'device'
  | 'area'
  | 'automation'
  | 'script'
  | 'scene'
  | 'label'
  | 'integration'
  | 'room'
  | 'device_passport'
  | 'maintenance_item'
  | 'troubleshooting_case'
  | 'purchase'
  | 'network_node';

export interface HomeGraphSpaceInput {
  readonly installationId?: string | undefined;
  readonly knowledgeSpaceId?: string | undefined;
}

export interface HomeGraphResetInput extends HomeGraphSpaceInput {
  readonly dryRun?: boolean | undefined;
  readonly preserveArtifacts?: boolean | undefined;
}

export interface HomeGraphObjectInput {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly title?: string | undefined;
  readonly entityId?: string | undefined;
  readonly deviceId?: string | undefined;
  readonly areaId?: string | undefined;
  readonly integrationId?: string | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly aliases?: readonly string[] | undefined;
  readonly manufacturer?: string | undefined;
  readonly model?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface HomeGraphSnapshotInput extends HomeGraphSpaceInput {
  readonly homeId?: string | undefined;
  readonly title?: string | undefined;
  readonly capturedAt?: number | undefined;
  readonly pageAutomation?: HomeGraphPageAutomationOptions | undefined;
  readonly entities?: readonly HomeGraphObjectInput[] | undefined;
  readonly devices?: readonly HomeGraphObjectInput[] | undefined;
  readonly areas?: readonly HomeGraphObjectInput[] | undefined;
  readonly automations?: readonly HomeGraphObjectInput[] | undefined;
  readonly scripts?: readonly HomeGraphObjectInput[] | undefined;
  readonly scenes?: readonly HomeGraphObjectInput[] | undefined;
  readonly labels?: readonly HomeGraphObjectInput[] | undefined;
  readonly integrations?: readonly HomeGraphObjectInput[] | undefined;
  readonly helpers?: readonly HomeGraphObjectInput[] | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface HomeGraphPageAutomationOptions {
  readonly enabled?: boolean | undefined;
  readonly devicePassports?: boolean | undefined;
  readonly roomPages?: boolean | undefined;
  readonly maxDevicePassports?: number | undefined;
  readonly maxRoomPages?: number | undefined;
  readonly maxRunMs?: number | undefined;
}

export interface HomeGraphGeneratedPagesSummary {
  readonly devicePassports: number;
  readonly roomPages: number;
  readonly artifacts: number;
  readonly sources: number;
  readonly deferredDevicePassports?: number | undefined;
  readonly deferredRoomPages?: number | undefined;
  readonly truncated?: boolean | undefined;
  readonly errors: readonly {
    readonly kind: 'device-passport' | 'room-page';
    readonly targetId: string;
    readonly error: string;
  }[];
}

export interface HomeGraphStatus {
  readonly ok: true;
  readonly spaceId: string;
  readonly installationId: string;
  readonly sourceCount: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly issueCount: number;
  readonly extractionCount: number;
  readonly lastSnapshotAt?: number | undefined;
  readonly readiness: {
    readonly state: 'ready' | 'repairing' | 'needs_review' | 'needs_sources' | 'empty';
    readonly openIssueCount: number;
    readonly activeRefinementTaskCount: number;
    readonly needsReviewTaskCount: number;
  };
  readonly capabilities: readonly string[];
}

export interface HomeGraphSyncResult {
  readonly ok: true;
  readonly spaceId: string;
  readonly installationId: string;
  readonly source: KnowledgeSourceRecord;
  readonly home: KnowledgeNodeRecord;
  readonly created: {
    readonly nodes: number;
    readonly edges: number;
    readonly issues: number;
  };
  readonly generated: HomeGraphGeneratedPagesSummary;
  readonly counts: {
    readonly entities: number;
    readonly devices: number;
    readonly areas: number;
    readonly automations: number;
    readonly scripts: number;
    readonly scenes: number;
    readonly labels: number;
    readonly integrations: number;
  };
}

export interface HomeGraphIngestUrlInput extends HomeGraphSpaceInput {
  readonly url: string;
  readonly title?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly target?: HomeGraphKnowledgeTarget | undefined;
  readonly allowPrivateHosts?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface HomeGraphIngestNoteInput extends HomeGraphSpaceInput {
  readonly title?: string | undefined;
  readonly body: string;
  readonly category?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly target?: HomeGraphKnowledgeTarget | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface HomeGraphIngestArtifactInput extends HomeGraphSpaceInput {
  readonly artifactId?: string | undefined;
  readonly path?: string | undefined;
  readonly uri?: string | undefined;
  readonly title?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly target?: HomeGraphKnowledgeTarget | undefined;
  readonly allowPrivateHosts?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface HomeGraphKnowledgeTarget {
  readonly kind: HomeGraphObjectKind | HomeGraphNodeKind | 'source' | 'node';
  readonly id: string;
  readonly relation?: HomeGraphRelation | string | undefined;
  readonly title?: string | undefined;
}

export interface HomeGraphIngestResult {
  readonly ok: true;
  readonly spaceId: string;
  readonly source: KnowledgeSourceRecord;
  readonly artifactId?: string | undefined;
  readonly extraction?: KnowledgeExtractionRecord | undefined;
  readonly linked?: KnowledgeEdgeRecord | undefined;
}

export interface HomeGraphLinkInput extends HomeGraphSpaceInput {
  readonly sourceId?: string | undefined;
  readonly nodeId?: string | undefined;
  readonly target: HomeGraphKnowledgeTarget;
  readonly relation?: HomeGraphRelation | string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface HomeGraphLinkResult {
  readonly ok: true;
  readonly spaceId: string;
  readonly edge: KnowledgeEdgeRecord;
  readonly target: KnowledgeNodeRecord | KnowledgeSourceRecord | null;
}

export interface HomeGraphAskInput extends HomeGraphSpaceInput {
  readonly query: string;
  readonly limit?: number | undefined;
  readonly mode?: 'concise' | 'standard' | 'detailed' | undefined;
  readonly includeSources?: boolean | undefined;
  readonly includeConfidence?: boolean | undefined;
  readonly includeLinkedObjects?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface HomeGraphAskResult {
  readonly ok: true;
  readonly spaceId: string;
  readonly query: string;
  readonly answer: {
    readonly text: string;
    readonly mode: string;
    readonly confidence: number;
    readonly sources: readonly KnowledgeSourceRecord[];
    readonly linkedObjects: readonly KnowledgeNodeRecord[];
    readonly facts?: readonly KnowledgeNodeRecord[] | undefined;
    readonly gaps?: readonly KnowledgeNodeRecord[] | undefined;
    readonly refinementTaskIds?: readonly string[] | undefined;
    readonly refinement?: KnowledgeSemanticAnswerRefinement | undefined;
    readonly synthesized?: boolean | undefined;
  };
  readonly results: readonly HomeGraphSearchResult[];
}

export interface HomeGraphMapInput extends HomeGraphSpaceInput {
  readonly limit?: number | undefined;
  readonly includeSources?: boolean | undefined;
  readonly includeIssues?: boolean | undefined;
  readonly includeGenerated?: boolean | undefined;
  readonly filters?: KnowledgeMapFilterInput | undefined;
  readonly query?: string | undefined;
  readonly recordKinds?: readonly ('source' | 'node' | 'issue')[] | undefined;
  readonly ids?: readonly string[] | undefined;
  readonly linkedToIds?: readonly string[] | undefined;
  readonly nodeKinds?: readonly string[] | undefined;
  readonly sourceTypes?: readonly string[] | undefined;
  readonly sourceStatuses?: readonly string[] | undefined;
  readonly nodeStatuses?: readonly string[] | undefined;
  readonly issueCodes?: readonly string[] | undefined;
  readonly issueStatuses?: readonly string[] | undefined;
  readonly issueSeverities?: readonly string[] | undefined;
  readonly edgeRelations?: readonly string[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly minConfidence?: number | undefined;
  readonly objectKinds?: readonly string[] | undefined;
  readonly entityIds?: readonly string[] | undefined;
  readonly deviceIds?: readonly string[] | undefined;
  readonly areaIds?: readonly string[] | undefined;
  readonly integrationIds?: readonly string[] | undefined;
  readonly integrationDomains?: readonly string[] | undefined;
  readonly domains?: readonly string[] | undefined;
  readonly deviceClasses?: readonly string[] | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly ha?: HomeGraphMapHaFilterInput | undefined;
}

export interface HomeGraphMapHaFilterInput {
  readonly objectKinds?: readonly string[] | undefined;
  readonly entityIds?: readonly string[] | undefined;
  readonly deviceIds?: readonly string[] | undefined;
  readonly areaIds?: readonly string[] | undefined;
  readonly integrationIds?: readonly string[] | undefined;
  readonly integrationDomains?: readonly string[] | undefined;
  readonly domains?: readonly string[] | undefined;
  readonly deviceClasses?: readonly string[] | undefined;
  readonly labels?: readonly string[] | undefined;
}

export type HomeGraphMapNode = KnowledgeMapNode;
export type HomeGraphMapEdge = KnowledgeMapEdge;
export type HomeGraphMapResult = KnowledgeMapResult & { readonly spaceId: string };

export interface HomeGraphReindexInput extends HomeGraphSpaceInput {
  readonly limit?: number | undefined;
  readonly maxRunMs?: number | undefined;
  readonly semanticLimit?: number | undefined;
  readonly semanticMaxRunMs?: number | undefined;
  readonly generatedPageLimit?: number | undefined;
  readonly force?: boolean | undefined;
  readonly refreshPages?: boolean | undefined;
}

export interface HomeGraphReindexResult {
  readonly ok: true;
  readonly spaceId: string;
  readonly scanned: number;
  readonly reparsed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly changedSourceCount?: number | undefined;
  readonly forcedSourceCount?: number | undefined;
  readonly skippedGeneratedPageArtifactCount?: number | undefined;
  readonly refreshedGeneratedPageCount?: number | undefined;
  readonly generatedPagePolicyVersion?: string | undefined;
  readonly coalesced?: boolean | undefined;
  readonly truncated?: boolean | undefined;
  readonly budgetExhausted?: boolean | undefined;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly failures: readonly { readonly sourceId: string; readonly error: string }[];
  readonly linked?: readonly {
    readonly edge: KnowledgeEdgeRecord;
    readonly node: KnowledgeNodeRecord;
    readonly relation: string;
    readonly score: number;
    readonly reasons: readonly string[];
  }[];
  readonly generated?: HomeGraphGeneratedPagesSummary | undefined;
  readonly qualityIssues?: readonly KnowledgeIssueRecord[] | undefined;
  readonly semantic?: {
    readonly scanned: number;
    readonly enriched: number;
    readonly skipped: number;
    readonly failed: number;
    readonly errors: readonly { readonly sourceId: string; readonly error: string }[];
    readonly selfImprovement?: KnowledgeSemanticSelfImproveResult | undefined;
  };
}

export interface HomeGraphSearchResult {
  readonly kind: 'source' | 'node';
  readonly id: string;
  readonly score: number;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly excerpt?: string | undefined;
  readonly source?: KnowledgeSourceRecord | undefined;
  readonly node?: KnowledgeNodeRecord | undefined;
}

export interface HomeGraphProjectionInput extends HomeGraphSpaceInput {
  readonly areaId?: string | undefined;
  readonly roomId?: string | undefined;
  readonly deviceId?: string | undefined;
  readonly packetKind?: string | undefined;
  readonly title?: string | undefined;
  readonly includeFields?: readonly string[] | undefined;
  readonly excludeFields?: readonly string[] | undefined;
  readonly sharingProfile?: 'default' | 'guest' | 'pet-sitter' | 'emergency' | 'contractor' | 'network-admin' | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface HomeGraphProjectionResult {
  readonly ok: true;
  readonly spaceId: string;
  readonly title: string;
  readonly markdown: string;
  readonly source?: KnowledgeSourceRecord | undefined;
  readonly linked?: KnowledgeEdgeRecord | undefined;
  readonly artifact: {
    readonly id: string;
    readonly mimeType: string;
    readonly filename?: string | undefined;
    readonly createdAt: number;
    readonly metadata: Record<string, unknown>;
  };
}

export interface HomeGraphDevicePassportResult extends HomeGraphProjectionResult {
  readonly device: KnowledgeNodeRecord;
  readonly passport: KnowledgeNodeRecord;
  readonly missingFields: readonly string[];
}

export interface HomeGraphPageListResult {
  readonly ok: true;
  readonly spaceId: string;
  readonly pages: readonly {
    readonly source: KnowledgeSourceRecord;
    readonly artifact?: HomeGraphProjectionResult['artifact'] | undefined;
    readonly markdown?: string | undefined;
    readonly target?: HomeGraphPageGraphNode | undefined;
    readonly subject?: HomeGraphPageGraphNode | undefined;
    readonly neighbors?: readonly HomeGraphPageGraphNeighbor[] | undefined;
    readonly relatedPages?: readonly HomeGraphRelatedPage[] | undefined;
  }[];
}

export interface HomeGraphPageGraphNode {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly [key: string]: unknown;
  readonly objectKind?: string | undefined;
  readonly objectId?: string | undefined;
  readonly entityId?: string | undefined;
  readonly deviceId?: string | undefined;
  readonly areaId?: string | undefined;
  readonly integrationId?: string | undefined;
}

export interface HomeGraphPageGraphNeighbor extends HomeGraphPageGraphNode {
  readonly relation: string;
  readonly direction: 'incoming' | 'outgoing';
}

export interface HomeGraphRelatedPage {
  readonly sourceId: string;
  readonly title: string;
  readonly projectionKind?: string | undefined;
  readonly subject?: HomeGraphPageGraphNode | undefined;
}

export interface HomeGraphReviewInput extends HomeGraphSpaceInput {
  readonly issueId?: string | undefined;
  readonly nodeId?: string | undefined;
  readonly sourceId?: string | undefined;
  readonly action: 'accept' | 'reject' | 'resolve' | 'edit' | 'forget';
  readonly value?: Record<string, unknown> | undefined;
  readonly reviewer?: string | undefined;
}

export interface HomeGraphExport {
  readonly version: 1;
  readonly exportedAt: number;
  readonly spaceId: string;
  readonly installationId: string;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly issues: readonly KnowledgeIssueRecord[];
  readonly extractions: readonly KnowledgeExtractionRecord[];
}

export interface HomeGraphResetResult {
  readonly ok: true;
  readonly spaceId: string;
  readonly installationId: string;
  readonly dryRun: boolean;
  readonly deleted: {
    readonly sources: number;
    readonly nodes: number;
    readonly edges: number;
    readonly issues: number;
    readonly extractions: number;
    readonly jobRuns: number;
    readonly refinementTasks: number;
    readonly usageRecords: number;
    readonly consolidationCandidates: number;
    readonly consolidationReports: number;
    readonly schedules: number;
  };
  readonly artifactDeleteCandidates: number;
  readonly deletedArtifacts: number;
  readonly preservedArtifacts: number;
  readonly artifactsDeleted: boolean;
}
