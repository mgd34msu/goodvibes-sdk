import type {
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';

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
  'knowledge-linking',
  'ask-home-graph',
  'device-passports',
  'room-pages',
  'packets',
  'source-inventory',
  'review-queue',
  'durable-review-decisions',
  'quality-rule-heuristics',
  'documentation-candidates',
  'export-import',
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
  readonly installationId?: string;
  readonly knowledgeSpaceId?: string;
}

export interface HomeGraphObjectInput {
  readonly id?: string;
  readonly name?: string;
  readonly title?: string;
  readonly entityId?: string;
  readonly deviceId?: string;
  readonly areaId?: string;
  readonly integrationId?: string;
  readonly labels?: readonly string[];
  readonly aliases?: readonly string[];
  readonly manufacturer?: string;
  readonly model?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface HomeGraphSnapshotInput extends HomeGraphSpaceInput {
  readonly homeId?: string;
  readonly title?: string;
  readonly capturedAt?: number;
  readonly entities?: readonly HomeGraphObjectInput[];
  readonly devices?: readonly HomeGraphObjectInput[];
  readonly areas?: readonly HomeGraphObjectInput[];
  readonly automations?: readonly HomeGraphObjectInput[];
  readonly scripts?: readonly HomeGraphObjectInput[];
  readonly scenes?: readonly HomeGraphObjectInput[];
  readonly labels?: readonly HomeGraphObjectInput[];
  readonly integrations?: readonly HomeGraphObjectInput[];
  readonly helpers?: readonly HomeGraphObjectInput[];
  readonly metadata?: Record<string, unknown>;
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
  readonly lastSnapshotAt?: number;
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
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly target?: HomeGraphKnowledgeTarget;
  readonly allowPrivateHosts?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface HomeGraphIngestNoteInput extends HomeGraphSpaceInput {
  readonly title?: string;
  readonly body: string;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly target?: HomeGraphKnowledgeTarget;
  readonly metadata?: Record<string, unknown>;
}

export interface HomeGraphIngestArtifactInput extends HomeGraphSpaceInput {
  readonly artifactId?: string;
  readonly path?: string;
  readonly uri?: string;
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly target?: HomeGraphKnowledgeTarget;
  readonly allowPrivateHosts?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface HomeGraphKnowledgeTarget {
  readonly kind: HomeGraphObjectKind | HomeGraphNodeKind | 'source' | 'node';
  readonly id: string;
  readonly relation?: HomeGraphRelation | string;
  readonly title?: string;
}

export interface HomeGraphIngestResult {
  readonly ok: true;
  readonly spaceId: string;
  readonly source: KnowledgeSourceRecord;
  readonly artifactId?: string;
  readonly extraction?: KnowledgeExtractionRecord;
  readonly linked?: KnowledgeEdgeRecord;
}

export interface HomeGraphLinkInput extends HomeGraphSpaceInput {
  readonly sourceId?: string;
  readonly nodeId?: string;
  readonly target: HomeGraphKnowledgeTarget;
  readonly relation?: HomeGraphRelation | string;
  readonly metadata?: Record<string, unknown>;
}

export interface HomeGraphLinkResult {
  readonly ok: true;
  readonly spaceId: string;
  readonly edge: KnowledgeEdgeRecord;
  readonly target: KnowledgeNodeRecord | KnowledgeSourceRecord | null;
}

export interface HomeGraphAskInput extends HomeGraphSpaceInput {
  readonly query: string;
  readonly limit?: number;
  readonly mode?: 'concise' | 'standard' | 'detailed';
  readonly includeSources?: boolean;
  readonly includeConfidence?: boolean;
  readonly includeLinkedObjects?: boolean;
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
  };
  readonly results: readonly HomeGraphSearchResult[];
}

export interface HomeGraphSearchResult {
  readonly kind: 'source' | 'node';
  readonly id: string;
  readonly score: number;
  readonly title: string;
  readonly summary?: string;
  readonly excerpt?: string;
  readonly source?: KnowledgeSourceRecord;
  readonly node?: KnowledgeNodeRecord;
}

export interface HomeGraphProjectionInput extends HomeGraphSpaceInput {
  readonly areaId?: string;
  readonly roomId?: string;
  readonly deviceId?: string;
  readonly packetKind?: string;
  readonly title?: string;
  readonly includeFields?: readonly string[];
  readonly excludeFields?: readonly string[];
  readonly sharingProfile?: 'default' | 'guest' | 'pet-sitter' | 'emergency' | 'contractor' | 'network-admin';
  readonly metadata?: Record<string, unknown>;
}

export interface HomeGraphProjectionResult {
  readonly ok: true;
  readonly spaceId: string;
  readonly title: string;
  readonly markdown: string;
  readonly artifact: {
    readonly id: string;
    readonly mimeType: string;
    readonly filename?: string;
    readonly createdAt: number;
    readonly metadata: Record<string, unknown>;
  };
}

export interface HomeGraphDevicePassportResult extends HomeGraphProjectionResult {
  readonly device: KnowledgeNodeRecord;
  readonly passport: KnowledgeNodeRecord;
  readonly missingFields: readonly string[];
}

export interface HomeGraphReviewInput extends HomeGraphSpaceInput {
  readonly issueId?: string;
  readonly nodeId?: string;
  readonly sourceId?: string;
  readonly action: 'accept' | 'reject' | 'resolve' | 'edit' | 'forget';
  readonly value?: Record<string, unknown>;
  readonly reviewer?: string;
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
