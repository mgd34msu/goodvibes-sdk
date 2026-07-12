export { JsonFileStore } from './json-file-store.js';
export { KVState } from './kv-state.js';
export { PersistentStore } from './persistent-store.js';
export { FileStateCache } from './file-cache.js';
export type { CacheEntry, CacheStatus, ConflictInfo } from './file-cache.js';
export { ProjectIndex } from './project-index.js';
export type { FileEntry } from './project-index.js';
export { ModeManager } from './mode-manager.js';
export type { ModeDefinition } from './mode-manager.js';
export type { HITLMode, HITLModeDefinition } from './mode-manager.js';
export { HITL_QUIET, HITL_BALANCED, HITL_OPERATOR } from './mode-manager.js';
export { FileWatcher } from './file-watcher.js';
export { SQLiteStore } from './sqlite-store.js';
export { TelemetryDB } from './telemetry.js';
export type { ToolCallRecord, TelemetryFilter, TelemetrySummary } from './telemetry.js';
export { FileUndoManager } from './file-undo.js';
export type { FileOperation } from './file-undo.js';
export { MemoryStore, memoryRecordTemporalStatus, isMemoryTemporallyActive } from './memory-store.js';
export { MemoryRegistry } from './memory-registry.js';
export type {
  MemoryBundle,
  MemoryClass,
  MemoryRecord,
  MemoryLink,
  MemoryAddOptions,
  MemorySearchFilter,
  MemorySemanticSearchResult,
  MemoryStoreOptions,
  MemoryDoctorReport,
  MemoryScope,
  MemoryReviewState,
  MemoryTemporalStatus,
  ProvenanceLink,
  ProvenanceLinkKind,
} from './memory-store.js';
export {
  buildIncidentMemoryAddOptions,
  buildMcpSecurityMemoryAddOptions,
  buildPluginSecurityMemoryAddOptions,
  buildPolicyPreflightMemoryAddOptions,
} from './memory-ingest.js';
export {
  resolveCanonicalMemoryDbPath,
  foldMemoryStores,
  formatMemoryFoldReport,
} from './canonical-memory.js';
export type {
  LegacyMemorySource,
  MemoryFoldSourceReport,
  MemoryFoldReport,
  FoldMemoryStoresOptions,
} from './canonical-memory.js';
export {
  MIN_PROMPT_MEMORY_CONFIDENCE,
  describeMemoryPromptEligibility,
  isPromptActiveMemory,
  describeMemoryIndexUnavailable,
  describeMemoryIndexCaveat,
  runHonestMemorySearch,
} from './memory-recall-contract.js';
export type {
  MemoryPromptEligibility,
  HonestSearchStore,
  HonestMemorySearchOptions,
  HonestMemorySearchResult,
} from './memory-recall-contract.js';
export {
  VIBE_PERSONA_TAG,
  VIBE_PROJECTION_HEADING,
  VIBE_PROJECTION_CAVEAT,
  selectVibeRecords,
  renderVibeProjection,
  vibeBodyToConstraintOptions,
} from './vibe-projection.js';
export type { VibeProjectionOptions, VibeImportOptions } from './vibe-projection.js';
export {
  projectMemoryRecordToMarkdown,
  projectMemoryToFiles,
  parseProjectedMemoryFile,
  readProjectedMemoryFiles,
  listMemoryProjections,
  getMemoryProjection,
  diffProjectionToProposals,
  applyMemoryProjectionProposals,
  createMemoryProjectionGit,
} from './memory-file-projection.js';
export type {
  MemoryProjectionOptions,
  MemoryProjectionGit,
  MemoryProjectionFile,
  MemoryProjectionEntry,
  MemoryProjectionWriteReport,
  MemoryProjectionProposal,
  MemoryProjectionProposalKind,
  MemoryProjectionRegistry,
  MemoryProjectionApplyReceipt,
} from './memory-file-projection.js';
export {
  DEFAULT_MEMORY_CONSOLIDATION_CONFIG,
  resolveMemoryConsolidationConfig,
} from './memory-consolidation-config.js';
export type {
  ResolvedMemoryConsolidationConfig,
  MemoryConsolidationConfigSource,
} from './memory-consolidation-config.js';
export { runMemoryConsolidation } from './memory-consolidation.js';
export type {
  MemoryConsolidationRegistry,
  MemoryConsolidationInput,
  MemoryConsolidationTrigger,
  MemoryConsolidationUsageSignal,
  MemoryConsolidationUsageLookup,
  MemoryConsolidationMergeEntry,
  MemoryConsolidationArchiveEntry,
  MemoryConsolidationDecayEntry,
  MemoryConsolidationProposal,
  MemoryConsolidationRunReceipt,
} from './memory-consolidation.js';
export { detectReferencedMemoryIds } from './memory-usage-detection.js';
export type {
  MemoryReferenceTier,
  MemoryReferenceInput,
  MemoryReferenceResult,
} from './memory-usage-detection.js';
export { MemoryUsageStatsStore, MEMORY_USAGE_SIGNAL_NOTE } from './memory-usage-stats.js';
export type {
  MemoryUsageEntry,
  MemoryUsageTopEntry,
  MemoryUsageSummary,
} from './memory-usage-stats.js';
export {
  MEMORY_VECTOR_DIMS,
  embedMemoryText,
  resolveMemoryVectorDbPath,
  SqliteVecMemoryIndex,
} from './memory-vector-store.js';
export type { MemoryVectorCandidate, MemoryVectorStats } from './memory-vector-store.js';
export {
  DEFAULT_MEMORY_EMBEDDING_DIMS,
  HASHED_MEMORY_EMBEDDING_PROVIDER,
  MemoryEmbeddingProviderRegistry,
  normalizeMemoryEmbeddingVector,
} from './memory-embeddings.js';
export { createBuiltinMemoryEmbeddingProviders } from './memory-embedding-http.js';
export type {
  MemoryEmbeddingDoctorReport,
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderState,
  MemoryEmbeddingProviderStatus,
  MemoryEmbeddingRequest,
  MemoryEmbeddingResult,
  MemoryEmbeddingUsage,
} from './memory-embeddings.js';
export type { KnowledgeInjection, ScoredKnowledgeInjection } from './knowledge-injection.js';
export { selectKnowledgeForTask, selectKnowledgeForTaskScored, buildKnowledgeInjectionPrompt } from './knowledge-injection.js';
export { CodeIndexStore } from './code-index-store.js';
export type {
  CodeChunk,
  CodeChunkMode,
  CodeContextResult,
  CodeIndexBuildProgress,
  CodeIndexBuildStats,
  CodeIndexOptions,
  CodeIndexSkipReport,
  CodeIndexStats,
} from './code-index-store.js';
export {
  CodeIndexReindexScheduler,
  extractReindexPaths,
  DEFAULT_REINDEX_DEBOUNCE_MS,
} from './code-index-reindex.js';
export type {
  CodeIndexReindexActivity,
  CodeIndexReindexTarget,
  CodeIndexReindexSchedulerDeps,
} from './code-index-reindex.js';
