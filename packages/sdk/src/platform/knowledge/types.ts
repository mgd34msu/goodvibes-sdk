import type { AutomationScheduleDefinition } from '../automation/schedules.js';

export type KnowledgeSourceType =
  | 'url'
  | 'bookmark'
  | 'bookmark-list'
  | 'history'
  | 'document'
  | 'repo'
  | 'dataset'
  | 'image'
  | 'manual'
  | 'other';

export type KnowledgeSourceStatus = 'pending' | 'indexed' | 'failed' | 'stale';

export type KnowledgeNodeKind =
  | 'domain'
  | 'bookmark_folder'
  | 'topic'
  | 'memory'
  | 'project'
  | 'capability'
  | 'repo'
  | 'service'
  | 'provider'
  | 'environment'
  | 'user'
  | 'source_group'
  | 'knowledge_entity'
  | 'fact'
  | 'wiki_page'
  | 'knowledge_gap'
  | 'ha_home'
  | 'ha_entity'
  | 'ha_device'
  | 'ha_area'
  | 'ha_automation'
  | 'ha_script'
  | 'ha_scene'
  | 'ha_label'
  | 'ha_integration'
  | 'ha_room'
  | 'ha_device_passport'
  | 'ha_maintenance_item'
  | 'ha_troubleshooting_case'
  | 'ha_purchase'
  | 'ha_network_node'
  | 'other';

export type KnowledgeNodeStatus = 'active' | 'draft' | 'stale';

export type KnowledgeReferenceKind = 'source' | 'node' | 'artifact' | 'memory' | 'session';

export type KnowledgeIssueSeverity = 'info' | 'warning' | 'error';
export type KnowledgeExtractionFormat =
  | 'text'
  | 'markdown'
  | 'html'
  | 'json'
  | 'csv'
  | 'tsv'
  | 'xml'
  | 'yaml'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'pdf'
  | 'unknown';
export type KnowledgePacketDetail = 'compact' | 'standard' | 'detailed';
export type KnowledgeJobMode = 'inline' | 'background';
export type KnowledgeJobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type KnowledgeRefinementTaskState =
  | 'detected'
  | 'queued'
  | 'searching'
  | 'evaluating'
  | 'extracting'
  | 'applying'
  | 'verified'
  | 'closed'
  | 'blocked'
  | 'suppressed'
  | 'needs_review'
  | 'cancelled'
  | 'failed';
export type KnowledgeRefinementTaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type KnowledgeRefinementTaskTrigger =
  | 'ingest'
  | 'homegraph-sync'
  | 'reindex'
  | 'scheduled'
  | 'answer'
  | 'manual';
export type KnowledgeJobKind =
  | 'lint'
  | 'reindex'
  | 'refresh-stale'
  | 'refresh-bookmarks'
  | 'sync-browser-history'
  | 'rebuild-projections'
  | 'semantic-enrichment'
  | 'semantic-self-improvement'
  | 'light-consolidation'
  | 'deep-consolidation';
export type KnowledgeUsageKind =
  | 'search-hit'
  | 'packet-item'
  | 'item-open'
  | 'neighbor-open'
  | 'projection-read'
  | 'multimodal-writeback';
export type KnowledgeUsageTargetKind = 'source' | 'node' | 'issue';
export type KnowledgeConsolidationCandidateType =
  | 'memory-promotion'
  | 'memory-review'
  | 'source-refresh'
  | 'knowledge-gap';
export type KnowledgeConsolidationStatus = 'open' | 'accepted' | 'rejected' | 'superseded';

export interface KnowledgeSourceRecord {
  readonly id: string;
  readonly sourceId?: string | undefined;
  readonly connectorId: string;
  readonly sourceType: KnowledgeSourceType;
  readonly title?: string | undefined;
  readonly url?: string | undefined;
  readonly sourceUri?: string | undefined;
  readonly canonicalUri?: string | undefined;
  readonly summary?: string | undefined;
  readonly description?: string | undefined;
  readonly tags: readonly string[];
  readonly folderPath?: string | undefined;
  readonly status: KnowledgeSourceStatus;
  readonly artifactId?: string | undefined;
  readonly contentHash?: string | undefined;
  readonly lastCrawledAt?: number | undefined;
  readonly crawlError?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeNodeRecord {
  readonly id: string;
  readonly kind: KnowledgeNodeKind;
  readonly slug: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly aliases: readonly string[];
  readonly status: KnowledgeNodeStatus;
  readonly confidence: number;
  readonly sourceId?: string | undefined;
  // Optional answer-projection fields used when semantic facts are returned with
  // their graph subjects. Stored node records keep these values in metadata.
  readonly subject?: string | undefined;
  readonly subjectIds?: readonly string[] | undefined;
  readonly targetHints?: readonly Record<string, unknown>[] | undefined;
  readonly linkedObjectIds?: readonly string[] | undefined;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeEdgeRecord {
  readonly id: string;
  readonly fromKind: KnowledgeReferenceKind;
  readonly fromId: string;
  readonly toKind: KnowledgeReferenceKind;
  readonly toId: string;
  readonly relation: string;
  readonly weight: number;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeIssueRecord {
  readonly id: string;
  readonly severity: KnowledgeIssueSeverity;
  readonly code: string;
  readonly message: string;
  readonly status: 'open' | 'resolved';
  readonly sourceId?: string | undefined;
  readonly nodeId?: string | undefined;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeExtractionRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly artifactId?: string | undefined;
  readonly extractorId: string;
  readonly format: KnowledgeExtractionFormat;
  readonly title?: string | undefined;
  readonly summary?: string | undefined;
  readonly excerpt?: string | undefined;
  readonly sections: readonly string[];
  readonly links: readonly string[];
  readonly estimatedTokens: number;
  readonly structure: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeJobRecord {
  readonly id: string;
  readonly kind: KnowledgeJobKind;
  readonly title: string;
  readonly description: string;
  readonly defaultMode: KnowledgeJobMode;
  readonly metadata: Record<string, unknown>;
}

export interface KnowledgeJobRunRecord {
  readonly id: string;
  readonly jobId: string;
  readonly status: KnowledgeJobStatus;
  readonly mode: KnowledgeJobMode;
  readonly requestedAt: number;
  readonly startedAt?: number | undefined;
  readonly completedAt?: number | undefined;
  readonly error?: string | undefined;
  readonly result: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeRefinementTraceEntry {
  readonly at: number;
  readonly state: KnowledgeRefinementTaskState;
  readonly message: string;
  readonly data?: Record<string, unknown> | undefined;
}

export interface KnowledgeRefinementSourceAssessment {
  readonly url: string;
  readonly title?: string | undefined;
  readonly domain?: string | undefined;
  readonly rank?: number | undefined;
  readonly query?: string | undefined;
  readonly accepted: boolean;
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly trustReason?: string | undefined;
  readonly rejectionReason?: string | undefined;
}

export interface KnowledgeRefinementTaskRecord {
  readonly id: string;
  readonly spaceId: string;
  readonly subjectKind?: KnowledgeUsageTargetKind | undefined;
  readonly subjectId?: string | undefined;
  readonly subjectTitle?: string | undefined;
  readonly subjectType?: string | undefined;
  readonly gapId?: string | undefined;
  readonly issueId?: string | undefined;
  readonly state: KnowledgeRefinementTaskState;
  readonly priority: KnowledgeRefinementTaskPriority;
  readonly trigger: KnowledgeRefinementTaskTrigger;
  readonly budget: Record<string, number>;
  readonly attemptCount: number;
  readonly blockedReason?: string | undefined;
  readonly nextRepairAttemptAt?: number | undefined;
  readonly acceptedSourceIds?: readonly string[] | undefined;
  readonly ingestedSourceIds?: readonly string[] | undefined;
  readonly rejectedSourceUrls?: readonly string[] | undefined;
  readonly promotedFactCount?: number | undefined;
  readonly sourceAssessments?: readonly KnowledgeRefinementSourceAssessment[] | undefined;
  readonly trace: readonly KnowledgeRefinementTraceEntry[];
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeRefinementTaskFilter {
  readonly spaceId?: string | undefined;
  readonly state?: string | undefined;
  readonly subjectKind?: string | undefined;
  readonly subjectId?: string | undefined;
  readonly gapId?: string | undefined;
}

export interface KnowledgeUsageRecord {
  readonly id: string;
  readonly targetKind: KnowledgeUsageTargetKind;
  readonly targetId: string;
  readonly usageKind: KnowledgeUsageKind;
  readonly task?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly score?: number | undefined;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
}

export interface KnowledgeConsolidationCandidateRecord {
  readonly id: string;
  readonly candidateType: KnowledgeConsolidationCandidateType;
  readonly status: KnowledgeConsolidationStatus;
  readonly subjectKind: KnowledgeUsageTargetKind;
  readonly subjectId: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly score: number;
  readonly evidence: readonly string[];
  readonly suggestedMemoryClass?: string | undefined;
  readonly suggestedScope?: string | undefined;
  readonly decidedAt?: number | undefined;
  readonly decidedBy?: string | undefined;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeConsolidationReportRecord {
  readonly id: string;
  readonly kind: Extract<KnowledgeJobKind, 'light-consolidation' | 'deep-consolidation'>;
  readonly title: string;
  readonly summary: string;
  readonly highlights: readonly string[];
  readonly metrics: Record<string, number>;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeScheduleRecord {
  readonly id: string;
  readonly jobId: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly schedule: AutomationScheduleDefinition;
  readonly lastRunAt?: number | undefined;
  readonly nextRunAt?: number | undefined;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeSourceUpsertInput {
  readonly id?: string | undefined;
  readonly connectorId: string;
  readonly sourceType: KnowledgeSourceType;
  readonly title?: string | undefined;
  readonly sourceUri?: string | undefined;
  readonly canonicalUri?: string | undefined;
  readonly summary?: string | undefined;
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly folderPath?: string | undefined;
  readonly status: KnowledgeSourceStatus;
  readonly artifactId?: string | undefined;
  readonly contentHash?: string | undefined;
  readonly lastCrawledAt?: number | undefined;
  readonly crawlError?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeNodeUpsertInput {
  readonly id?: string | undefined;
  readonly kind: KnowledgeNodeKind;
  readonly slug: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly aliases?: readonly string[] | undefined;
  readonly status?: KnowledgeNodeStatus | undefined;
  readonly confidence?: number | undefined;
  readonly sourceId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeEdgeUpsertInput {
  readonly fromKind: KnowledgeReferenceKind;
  readonly fromId: string;
  readonly toKind: KnowledgeReferenceKind;
  readonly toId: string;
  readonly relation: string;
  readonly weight?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeIssueUpsertInput {
  readonly id?: string | undefined;
  readonly severity: KnowledgeIssueSeverity;
  readonly code: string;
  readonly message: string;
  readonly status?: 'open' | 'resolved' | undefined;
  readonly sourceId?: string | undefined;
  readonly nodeId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeExtractionUpsertInput {
  readonly id?: string | undefined;
  readonly sourceId: string;
  readonly artifactId?: string | undefined;
  readonly extractorId: string;
  readonly format: KnowledgeExtractionFormat;
  readonly title?: string | undefined;
  readonly summary?: string | undefined;
  readonly excerpt?: string | undefined;
  readonly sections?: readonly string[] | undefined;
  readonly links?: readonly string[] | undefined;
  readonly estimatedTokens?: number | undefined;
  readonly structure?: Record<string, unknown> | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeJobRunUpsertInput {
  readonly id?: string | undefined;
  readonly jobId: string;
  readonly status: KnowledgeJobStatus;
  readonly mode: KnowledgeJobMode;
  readonly requestedAt?: number | undefined;
  readonly startedAt?: number | undefined;
  readonly completedAt?: number | undefined;
  readonly error?: string | undefined;
  readonly result?: Record<string, unknown> | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeRefinementTaskUpsertInput {
  readonly id?: string | undefined;
  readonly spaceId: string;
  readonly subjectKind?: KnowledgeUsageTargetKind | undefined;
  readonly subjectId?: string | undefined;
  readonly subjectTitle?: string | undefined;
  readonly subjectType?: string | undefined;
  readonly gapId?: string | undefined;
  readonly issueId?: string | undefined;
  readonly state: KnowledgeRefinementTaskState;
  readonly priority?: KnowledgeRefinementTaskPriority | undefined;
  readonly trigger: KnowledgeRefinementTaskTrigger;
  readonly budget?: Record<string, number> | undefined;
  readonly attemptCount?: number | undefined;
  readonly blockedReason?: string | undefined;
  readonly nextRepairAttemptAt?: number | undefined;
  readonly acceptedSourceIds?: readonly string[] | undefined;
  readonly ingestedSourceIds?: readonly string[] | undefined;
  readonly rejectedSourceUrls?: readonly string[] | undefined;
  readonly promotedFactCount?: number | undefined;
  readonly sourceAssessments?: readonly KnowledgeRefinementSourceAssessment[] | undefined;
  readonly trace?: readonly KnowledgeRefinementTraceEntry[] | undefined;
  readonly appendTrace?: readonly KnowledgeRefinementTraceEntry[] | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeUsageUpsertInput {
  readonly id?: string | undefined;
  readonly targetKind: KnowledgeUsageTargetKind;
  readonly targetId: string;
  readonly usageKind: KnowledgeUsageKind;
  readonly task?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly score?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeConsolidationCandidateUpsertInput {
  readonly id?: string | undefined;
  readonly candidateType: KnowledgeConsolidationCandidateType;
  readonly status?: KnowledgeConsolidationStatus | undefined;
  readonly subjectKind: KnowledgeUsageTargetKind;
  readonly subjectId: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly score: number;
  readonly evidence?: readonly string[] | undefined;
  readonly suggestedMemoryClass?: string | undefined;
  readonly suggestedScope?: string | undefined;
  readonly decidedAt?: number | undefined;
  readonly decidedBy?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeConsolidationReportUpsertInput {
  readonly id?: string | undefined;
  readonly kind: Extract<KnowledgeJobKind, 'light-consolidation' | 'deep-consolidation'>;
  readonly title: string;
  readonly summary: string;
  readonly highlights?: readonly string[] | undefined;
  readonly metrics?: Record<string, number> | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeScheduleUpsertInput {
  readonly id?: string | undefined;
  readonly jobId: string;
  readonly label: string;
  readonly enabled?: boolean | undefined;
  readonly schedule: AutomationScheduleDefinition;
  readonly lastRunAt?: number | undefined;
  readonly nextRunAt?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeStatus {
  readonly ready: boolean;
  readonly storagePath: string;
  readonly sourceCount: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly issueCount: number;
  readonly extractionCount: number;
  readonly jobRunCount: number;
  readonly refinementTaskCount: number;
  readonly usageCount: number;
  readonly candidateCount: number;
  readonly reportCount: number;
  readonly scheduleCount: number;
}

export interface KnowledgeSearchResult {
  readonly kind: 'source' | 'node';
  readonly id: string;
  readonly score: number;
  readonly reason: string;
  readonly source?: KnowledgeSourceRecord | undefined;
  readonly node?: KnowledgeNodeRecord | undefined;
}

export interface KnowledgePacketItem {
  readonly kind: 'source' | 'node';
  readonly id: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly uri?: string | undefined;
  readonly reason: string;
  readonly score: number;
  readonly estimatedTokens: number;
  readonly related: readonly string[];
  readonly evidence: readonly string[];
  readonly metadata: Record<string, unknown>;
}

export interface KnowledgePacket {
  readonly task: string;
  readonly writeScope: readonly string[];
  readonly generatedAt: number;
  readonly detail: KnowledgePacketDetail;
  readonly strategy: string;
  readonly budgetLimit: number;
  readonly estimatedTokens: number;
  readonly items: readonly KnowledgePacketItem[];
}

export interface KnowledgeItemView {
  readonly source?: KnowledgeSourceRecord | undefined;
  readonly node?: KnowledgeNodeRecord | undefined;
  readonly issue?: KnowledgeIssueRecord | undefined;
  readonly relatedEdges: readonly KnowledgeEdgeRecord[];
  readonly linkedSources: readonly KnowledgeSourceRecord[];
  readonly linkedNodes: readonly KnowledgeNodeRecord[];
}

export interface KnowledgeBookmarkSeed {
  readonly url: string;
  readonly title?: string | undefined;
  readonly folderPath?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeConnectorParseResult {
  readonly seeds: readonly KnowledgeBookmarkSeed[];
  readonly connectorId?: string | undefined;
  readonly sourceType?: KnowledgeSourceType | undefined;
}

export interface KnowledgeConnectorSetupField {
  readonly key: string;
  readonly label: string;
  readonly kind: 'text' | 'path' | 'uri' | 'secret' | 'token' | 'choice';
  readonly optional?: boolean | undefined;
  readonly source?: 'inline' | 'env' | 'goodvibes' | 'bitwarden' | 'vaultwarden' | 'bws' | 'manual' | undefined;
  readonly description?: string | undefined;
}

export interface KnowledgeConnectorSetupContract {
  readonly version: string;
  readonly summary: string;
  readonly transportHints?: readonly string[] | undefined;
  readonly steps?: readonly string[] | undefined;
  readonly fields?: readonly KnowledgeConnectorSetupField[] | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeConnectorDoctorCheck {
  readonly id: string;
  readonly label: string;
  readonly status: 'pass' | 'warn' | 'fail';
  readonly detail: string;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeConnectorDoctorReport {
  readonly connectorId: string;
  readonly ready: boolean;
  readonly summary: string;
  readonly checks: readonly KnowledgeConnectorDoctorCheck[];
  readonly hints: readonly string[];
  readonly metadata: Record<string, unknown>;
}

export interface KnowledgeConnector<Input = unknown> {
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly version?: string | undefined;
  readonly description: string;
  readonly sourceType: KnowledgeSourceType;
  readonly inputSchema?: Record<string, unknown> | undefined;
  readonly examples?: readonly unknown[] | undefined;
  readonly capabilities?: readonly string[] | undefined;
  readonly setup?: KnowledgeConnectorSetupContract | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  resolve(input: Input): KnowledgeConnectorParseResult | Promise<KnowledgeConnectorParseResult>;
  doctor?(): KnowledgeConnectorDoctorReport | Promise<KnowledgeConnectorDoctorReport>;
}

export interface KnowledgeIngestResult {
  readonly source: KnowledgeSourceRecord;
  readonly artifactId?: string | undefined;
  readonly issues: readonly KnowledgeIssueRecord[];
}

export interface KnowledgeBatchIngestResult {
  readonly imported: number;
  readonly failed: number;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly errors: readonly string[];
}

export type KnowledgeProjectionTargetKind = 'overview' | 'bundle' | 'source' | 'node' | 'issue' | 'dashboard' | 'rollup';

export interface KnowledgeProjectionTarget {
  readonly targetId: string;
  readonly kind: KnowledgeProjectionTargetKind;
  readonly title: string;
  readonly description: string;
  readonly itemId?: string | undefined;
  readonly defaultPath: string;
  readonly defaultFilename: string;
  readonly metadata: Record<string, unknown>;
}

export interface KnowledgeProjectionPage {
  readonly path: string;
  readonly title: string;
  readonly format: 'markdown';
  readonly content: string;
  readonly itemIds: readonly string[];
  readonly metadata: Record<string, unknown>;
}

export interface KnowledgeProjectionBundle {
  readonly id: string;
  readonly target: KnowledgeProjectionTarget;
  readonly generatedAt: number;
  readonly pageCount: number;
  readonly pages: readonly KnowledgeProjectionPage[];
  readonly metadata: Record<string, unknown>;
}

export interface KnowledgeMaterializedProjection {
  readonly bundle: KnowledgeProjectionBundle;
  readonly artifact: {
    readonly id: string;
    readonly kind: string;
    readonly mimeType: string;
    readonly filename?: string | undefined;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly createdAt: number;
    readonly expiresAt?: number | undefined;
    readonly sourceUri?: string | undefined;
    readonly metadata: Record<string, unknown>;
  };
  readonly source?: KnowledgeSourceRecord | undefined;
  readonly linked?: KnowledgeEdgeRecord | undefined;
  readonly artifactCreated?: boolean | undefined;
}

export type KnowledgeMapRecordKind = 'source' | 'node' | 'issue';

export interface KnowledgeMapFilterInput {
  readonly query?: string | undefined;
  readonly recordKinds?: readonly KnowledgeMapRecordKind[] | undefined;
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
}

export interface KnowledgeMapFacetValue {
  readonly value: string;
  readonly count: number;
  readonly label?: string | undefined;
}

export interface KnowledgeMapFacets {
  readonly recordKinds: readonly KnowledgeMapFacetValue[];
  readonly nodeKinds: readonly KnowledgeMapFacetValue[];
  readonly sourceTypes: readonly KnowledgeMapFacetValue[];
  readonly sourceStatuses: readonly KnowledgeMapFacetValue[];
  readonly nodeStatuses: readonly KnowledgeMapFacetValue[];
  readonly issueCodes: readonly KnowledgeMapFacetValue[];
  readonly issueStatuses: readonly KnowledgeMapFacetValue[];
  readonly issueSeverities: readonly KnowledgeMapFacetValue[];
  readonly edgeRelations: readonly KnowledgeMapFacetValue[];
  readonly tags: readonly KnowledgeMapFacetValue[];
  readonly homeAssistant?: Record<string, readonly KnowledgeMapFacetValue[]> | undefined;
}

export interface KnowledgeMapNode {
  readonly id: string;
  readonly recordKind: KnowledgeMapRecordKind;
  readonly kind: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly metadata: Record<string, unknown>;
}

export interface KnowledgeMapEdge {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly source?: string | undefined;
  readonly target?: string | undefined;
  readonly fromTitle?: string | undefined;
  readonly toTitle?: string | undefined;
  readonly sourceTitle?: string | undefined;
  readonly targetTitle?: string | undefined;
  readonly relation: string;
  readonly weight: number;
  readonly metadata: Record<string, unknown>;
}

export interface KnowledgeMapResult {
  readonly ok: true;
  readonly spaceId?: string | undefined;
  readonly title: string;
  readonly generatedAt: number;
  readonly width: number;
  readonly height: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly totalNodeCount?: number | undefined;
  readonly totalEdgeCount?: number | undefined;
  readonly facets?: KnowledgeMapFacets | undefined;
  readonly nodes: readonly KnowledgeMapNode[];
  readonly edges: readonly KnowledgeMapEdge[];
  readonly svg: string;
}
