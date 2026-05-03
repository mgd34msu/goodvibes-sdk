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
export { MemoryStore } from './memory-store.js';
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
export type { KnowledgeInjection } from './knowledge-injection.js';
export { selectKnowledgeForTask, buildKnowledgeInjectionPrompt } from './knowledge-injection.js';
