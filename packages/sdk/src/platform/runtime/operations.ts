export * from './remote/index.js';
export type { RemoteSessionBundle } from './remote/types.js';
export * from './tasks/index.js';
export * from './tools/index.js';
export { AcpTaskAdapter } from './tasks/adapters/index.js';
export { OpsControlPlane, OpsIllegalActionError, OpsTargetNotFoundError } from './ops/control-plane.js';
export { ToolContractVerifier } from './tools/contract-verifier.js';
export type { ContractVerifierOptions } from './tools/contract-verifier.js';
export {
  McpLifecycleManager,
  McpPermissionManager,
  McpSchemaFreshnessTracker,
  buildMcpAttackPathReview,
  createMcpLifecycleManager,
  DEFAULT_RECONNECT_CONFIG,
} from './mcp/index.js';
export type {
  McpAttackPathFinding,
  McpAttackPathFindingKind,
  McpAttackPathReview,
  McpCapabilityClass,
  McpCoherenceAssessment,
  McpCoherenceVerdict,
  McpDecisionRecord,
  McpEventHandler,
  McpLifecycleManagerOptions,
  McpPermission,
  McpReconnectConfig,
  McpRiskLevel,
  McpSchemaRecord,
  McpSecuritySnapshot,
  McpServerEntry,
  McpServerPermissions,
  McpServerRole,
  McpServerState,
  McpToolPermission,
  McpTrustLevel,
  McpTrustMode,
  McpTrustProfile,
  QuarantineReason,
  QuarantineRecord,
  SchemaFreshness,
} from './mcp/index.js';
export {
  ALL_CAPABILITIES,
  ALL_CAPABILITIES as PLUGIN_CAPABILITIES,
  HIGH_RISK_CAPABILITIES,
  PluginLifecycleManager,
  PluginQuarantineEngine,
  PluginTrustStore,
  SAFE_CAPABILITIES,
  filterCapabilitiesByTrust,
  hasCapability,
  isHighRiskCapability,
  isOperational as isPluginOperational,
  isReloadable as isPluginReloadable,
  isTerminal as isPluginTerminal,
  resolveCapabilityManifest,
  validateManifestV2,
  validatePluginSignature,
} from './plugins/index.js';
export type {
  PluginCapability,
  PluginCapabilityManifest,
  PluginManifestV2,
  PluginTrustTier,
} from './plugins/index.js';
export {
  LOW_QUALITY_THRESHOLD,
  computeQualityScore,
  createCompactionManager,
  describeScore,
  escalateStrategy,
  isTerminal as isTerminalCompactionState,
  reachableFrom as reachableFromCompactionState,
} from './compaction/index.js';
export type {
  CompactionQualityScore,
  CompactionStrategy,
  StrategyInput,
  StrategyOutput,
} from './compaction/index.js';
export {
  compactionFailurePlaybook,
  exportRecoveryPlaybook,
  permissionDeadlockPlaybook,
  pluginDegradationPlaybook,
  reconnectFailurePlaybook,
  sessionUnrecoverablePlaybook,
  stuckTurnPlaybook,
} from './ops/playbooks/index.js';
export {
  createSessionUnrecoverablePlaybook,
} from './ops/playbooks/session-unrecoverable.js';
export {
  createStuckTurnPlaybook,
} from './ops/playbooks/stuck-turn.js';
export {
  evaluateOrchestrationSpawn,
} from './orchestration/spawn-policy.js';
export type {
  DistributedRuntimeSnapshotStore,
} from './remote/index.js';
export {
  TRANSPORT_PROTOCOL_SUPPORT_MATRIX as TRANSPORT_COMPATIBILITY_MATRIX,
} from './remote/index.js';
export {
  applyTransition,
  canTransition,
  isOperational,
  isReloadable,
  isTerminal,
  reachableFrom,
} from './lifecycle-facade.js';
export type { RuntimeTransitionResult } from './lifecycle-facade.js';
export * from './session-maintenance.js';
export * from './session-persistence.js';
export * from './session-surface.js';
export * from './session-return-context.js';
export * from './retention/index.js';
export type {
  RetentionClass,
  RetentionClassConfig,
  RetentionConfig,
  CheckpointRecord,
  PruneOptions,
  PruneResult,
  PerClassPruneResult,
  Pruner,
  RetentionStats,
} from './retention/index.js';

export { FocusTracker } from './focus-tracker.js';
export {
  FORCE_NOTIFY_DURATION_MS,
  readBooleanConfig,
  readNotifyOnlyWhenUnfocused,
  shouldFireAlert,
} from './alert-gating.js';
export type { ConfigGet } from './alert-gating.js';

export {
  JOURNAL_ORPHAN_MAX_AGE_MS,
  JOURNAL_ORPHAN_MAX_FILES,
  JOURNAL_SCHEMA_VERSION,
  journalPathFor,
  openTranscriptJournal,
  reapOrphanedJournals,
  replayJournal,
} from './transcript-journal.js';
export type {
  JournalEventType,
  JournalHeader,
  JournalReapOptions,
  JournalReapResult,
  JournalRecord,
  ReplayResult,
  TranscriptJournal,
} from './transcript-journal.js';

export {
  checkSessionLiveness,
  isPidAlive,
  LIVENESS_MARKER_MAX_FILES,
  LIVENESS_STALE_AFTER_MS,
  livenessMarkerDirFor,
  livenessMarkerPathFor,
  reapStaleLivenessMarkers,
  removeLivenessMarker,
  writeLivenessMarker,
} from './session-liveness-marker.js';
export type {
  LivenessMarker,
  LivenessReapOptions,
  LivenessReapResult,
  SessionLivenessCheck,
} from './session-liveness-marker.js';

export {
  DURABILITY_HOUSEKEEPING_INTERVAL_MS,
  runDurabilityHousekeeping,
  startDurabilityHousekeeping,
} from './durability-housekeeping.js';
export type {
  DurabilityHousekeepingInput,
  DurabilityHousekeepingOutcome,
} from './durability-housekeeping.js';

export { createDurabilityServices } from './durability-services.js';
export type { DurabilityServices, DurabilityServicesInput } from './durability-services.js';

export { resolveDaemonCompanionToken, workspaceOperatorTokenCandidates } from './operator-token-cleanup.js';

export { bindWriteLastSessionPointerToSurface } from './session-pointer-surface.js';
