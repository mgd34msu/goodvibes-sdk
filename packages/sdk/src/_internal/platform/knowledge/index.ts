export { KnowledgeConnectorRegistry, createDefaultKnowledgeConnectorRegistry } from './connectors.js';
export { extractKnowledgeArtifact } from './extractors.js';
export {
  collectBrowserKnowledge,
  discoverBrowserKnowledgeProfiles,
  ingestBrowserKnowledge,
  listBrowserKinds,
  readBrowserKnowledgeProfile,
} from './browser-history/index.js';
export { KnowledgeGraphqlService, getKnowledgeGraphqlSchemaText, inspectKnowledgeGraphqlAccess } from './graphql.js';
export type { KnowledgeGraphqlAccessProfile, KnowledgeGraphqlExecuteInput } from './graphql.js';
export {
  DEFAULT_KNOWLEDGE_SPACE_ID,
  HOME_ASSISTANT_KNOWLEDGE_SPACE_PREFIX,
  getKnowledgeSpaceId,
  homeAssistantKnowledgeSpaceId,
  isHomeAssistantKnowledgeSpace,
  isInKnowledgeSpace,
  knowledgeSpaceMetadata,
  normalizeHomeAssistantInstallationId,
  normalizeKnowledgeSpaceId,
  withKnowledgeSpace,
} from './spaces.js';
export type { KnowledgeSpaceId } from './spaces.js';
export { HomeGraphService, HOME_GRAPH_NODE_KINDS, HOME_GRAPH_RELATIONS } from './home-graph/index.js';
export type {
  HomeGraphAskInput,
  HomeGraphAskResult,
  HomeGraphDevicePassportResult,
  HomeGraphExport,
  HomeGraphIngestArtifactInput,
  HomeGraphIngestNoteInput,
  HomeGraphIngestResult,
  HomeGraphIngestUrlInput,
  HomeGraphKnowledgeTarget,
  HomeGraphLinkInput,
  HomeGraphLinkResult,
  HomeGraphNodeKind,
  HomeGraphObjectInput,
  HomeGraphObjectKind,
  HomeGraphProjectionInput,
  HomeGraphProjectionResult,
  HomeGraphRelation,
  HomeGraphReviewInput,
  HomeGraphSnapshotInput,
  HomeGraphStatus,
  HomeGraphSyncResult,
} from './home-graph/index.js';
export { createKnowledgeApi } from './knowledge-api.js';
export {
  createKnowledgeSchema,
  getKnowledgeSchemaStatements,
  knowledgeNowMs,
  loadKnowledgeStoreSnapshot,
  parseKnowledgeJsonValue,
  renderKnowledgeSchemaSql,
  resolveKnowledgeDbPathFromControlPlaneDir,
  stabilizeKnowledgeText,
  uniqKnowledgeValues,
} from './persistence.js';
export type { KnowledgeStoreSnapshot, KnowledgeStoreReadView } from './persistence.js';
export type {
  KnowledgeApi,
  KnowledgeApiArtifactIngestInput,
  KnowledgeApiUrlIngestInput,
  KnowledgeInjection,
  KnowledgeInjectionIngestMode,
  KnowledgeInjectionProvenance,
  KnowledgeInjectionRetention,
  KnowledgeInjectionTrustTier,
  KnowledgeInjectionUseAs,
} from './knowledge-api.js';
export { KnowledgeProjectionService } from './projections.js';
export { KnowledgeStore } from './store.js';
export { KnowledgeService, buildCuratedKnowledgePromptSync } from './service.js';
export type {
  KnowledgeBatchIngestResult,
  KnowledgeBookmarkSeed,
  KnowledgeConnector,
  KnowledgeConnectorDoctorReport,
  KnowledgeConnectorParseResult,
  KnowledgeConsolidationCandidateRecord,
  KnowledgeConsolidationReportRecord,
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeItemView,
  KnowledgeJobRecord,
  KnowledgeJobRunRecord,
  KnowledgeMaterializedProjection,
  KnowledgeNodeRecord,
  KnowledgePacket,
  KnowledgePacketDetail,
  KnowledgePacketItem,
  KnowledgeProjectionBundle,
  KnowledgeProjectionPage,
  KnowledgeProjectionTarget,
  KnowledgeProjectionTargetKind,
  KnowledgeScheduleRecord,
  KnowledgeSearchResult,
  KnowledgeSourceRecord,
  KnowledgeStatus,
  KnowledgeUsageRecord,
} from './types.js';
export type {
  BrowserBookmarkEntry,
  BrowserHistoryEntry,
  BrowserKnowledgeCollectResult,
  BrowserKnowledgeEntry,
  BrowserKnowledgeFamily,
  BrowserKnowledgeFilter,
  BrowserKnowledgeIngestOptions,
  BrowserKnowledgeKind,
  BrowserKnowledgeProfile,
  BrowserKnowledgeSourceKind,
} from './browser-history/index.js';
