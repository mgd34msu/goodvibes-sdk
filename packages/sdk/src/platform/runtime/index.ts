/**
 * Runtime module barrel for reusable platform runtime surfaces.
 *
 * This intentionally excludes interactive-host shell wiring such as
 * compositor/input/panel setup. It includes reusable runtime data,
 * clients, transports, diagnostics, health, and host-bootstrap helpers.
 */

export { createRuntimeStore, createDomainDispatch } from './store/index.js';
export type { RuntimeStore, DomainDispatch } from './store/index.js';
export type { RuntimeState } from './store/state.js';
export * from './store/selectors/index.js';
export * from './store/domains/index.js';
export * from './store/helpers/index.js';
export * from './feature-flags/index.js';

export { RuntimeEventBus } from './events/index.js';
export * from './diagnostics/index.js';
export * from './eval/index.js';
export * from './forensics/index.js';
export * from './idempotency/index.js';
export * from './perf/index.js';
export * from './remote/index.js';
export type { RemoteSessionBundle } from './remote/types.js';
export * from './tasks/index.js';
export * from './ui/index.js';
export * from './tools/index.js';
export { AcpTaskAdapter } from './tasks/adapters/index.js';
export { OpsControlPlane, OpsIllegalActionError, OpsTargetNotFoundError } from './ops/control-plane.js';
export { ComponentHealthMonitor as PanelHealthMonitor } from './perf/index.js';
export { ToolContractVerifier } from './tools/contract-verifier.js';
export type { ContractVerifierOptions } from './tools/contract-verifier.js';
export {
  buildAuthInspectionSnapshot,
  inspectProviderAuth,
} from './auth/inspection.js';
export type { AuthInspectionSnapshot, ProviderAuthInspection } from './auth/inspection.js';
export {
  emitSessionReady,
  emitSessionResumed,
  emitSessionStarted,
} from './emitters/session.js';
export { fireSessionStart } from './lifecycle.js';
export {
  enrichModelEntries,
  groupEntriesByProvider,
} from './ui/model-picker/health-enrichment.js';
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
  DivergenceDashboard,
  DivergenceGateError,
  LayeredPolicyEvaluator,
  PermissionSimulator,
  PolicyRegistry,
  PolicyRuntimeState,
  buildDefaultPolicySimulationScenarios,
  buildPermissionRuleSuggestions,
  buildPolicyPreflightReview,
  createPermissionEvaluator,
  createPermissionSimulator,
  createUnsignedBundle,
  lintPolicyConfig,
  loadPolicyBundle,
  runPolicySimulationScenarios,
} from './permissions/index.js';
export type {
  DivergenceDashboardSnapshot,
  DivergenceStats,
  PermissionsConfig,
  PolicyBundlePayload,
  PolicyBundleVersion,
  PolicyDiffResult,
  PolicyLintFinding,
  PolicyPreflightReview,
  PolicyRule,
  PolicySimulationSummary,
} from './permissions/index.js';
export type { PermissionAuditEntry } from './permissions/policy-runtime.js';
export { createEventEnvelope } from './event-envelope.js';
export type { EventEnvelope, EventEnvelopeContext } from './event-envelope.js';
export type { RuntimeEventEnvelope, EnvelopeContext } from './events/envelope.js';
export { RUNTIME_EVENT_DOMAINS, isRuntimeEventDomain } from '../../events/domain-map.js';
export type { AnyRuntimeEvent, RuntimeEventDomain, RuntimeEventRecord } from '../../events/domain-map.js';
export { createRuntimeEventFeed, createRuntimeEventFeeds } from './event-feeds.js';
export type { RuntimeEventFeed, RuntimeEventFeeds } from './event-feeds.js';
export { getSecuritySettingsReport } from './security-settings.js';
export type { SecuritySettingReport, SecuritySettingsReporter } from './security-settings.js';
export type { ComponentConfig as PanelConfig } from './diagnostics/types.js';
export { DEFAULT_COMPONENT_CONFIG as DEFAULT_PANEL_CONFIG } from './diagnostics/types.js';

export type { EmitterContext } from './emitters/index.js';
export {
  emitAutomationJobCreated,
  emitControlPlaneClientConnected,
  emitDeliveryQueued,
  emitRouteBindingCreated,
  emitSurfaceEnabled,
  emitTokenBlocked,
  emitUiRenderRequest,
  emitWatcherStarted,
} from './emitters/index.js';

export { RuntimeHealthAggregator } from './health/aggregator.js';
export { CascadeEngine } from './health/cascade-engine.js';
export { CASCADE_RULES } from './health/cascade-rules.js';
export {
  ALL_CASCADE_RULE_IDS,
  CASCADE_PLAYBOOK_MAP,
  CascadeTimer,
  createCascadeAppliedEvent,
  createHealthSystem,
  deriveCascadeSeverity,
} from './health/index.js';
export type {
  HealthStatus,
  HealthDomain as RuntimeHealthDomain,
  DomainHealth,
  CompositeHealth,
  CascadeRule,
  CascadeEffect,
  CascadeResult,
  EvaluateResult,
  CascadeAppliedEvent,
} from './health/types.js';

export { NotificationRouter, createNotificationRouter } from './notifications/index.js';
export type { Notification, NotificationLevel, NotificationTag, NotificationTarget, DomainVerbosity, RoutingDecision } from './notifications/types.js';
export {
  applyModeContextPolicy,
  BurstPolicy,
} from './notifications/policies/index.js';

export { ModelPickerDataProvider, createModelPickerData } from './ui/model-picker/index.js';
export type { ModelPickerDataProviderOptions } from './ui/model-picker/index.js';
export { ProviderHealthDataProvider, buildFallbackChainData, createProviderHealthData } from './ui/provider-health/index.js';

export {
  RetentionPolicy,
  SnapshotPruner,
  DEFAULT_RETENTION_CONFIG,
} from './retention/index.js';
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

export { shutdownRuntime, saveSession } from './lifecycle.js';
export { createUiRuntimeServices } from './ui-services.js';
export type { UiRuntimeServices } from './ui-services.js';
export {
  createDirectTransportServices,
  createOperatorClientServices,
  createPeerClientDependencies,
} from './foundation-services.js';
export type {
  DirectTransportServicesOptions,
  DirectTransportServices,
  OperatorClientServicesOptions,
  OperatorClientServices,
  OperatorClientReadModels,
} from './foundation-services.js';
export { createRuntimeFoundationClients } from './foundation-clients.js';
export type {
  RuntimeFoundationClients,
  RuntimeFoundationClientsOptions,
} from './foundation-clients.js';
export { createOperatorClient } from './operator-client.js';
export type { OperatorClient } from './operator-client.js';
export { createPeerClient } from './peer-client.js';
export type { PeerClient } from './peer-client.js';
export { createRuntimeProviderApi } from './runtime-provider-api.js';
export { createRuntimeKnowledgeApi } from './runtime-knowledge-api.js';
export { createRuntimeHookApi } from './runtime-hook-api.js';
export { createRuntimeMcpApi } from './runtime-mcp-api.js';
export { createRuntimeOpsApi } from './runtime-ops-api.js';
export type { OpsApi } from './ops-api.js';
export * from './ui-service-queries.js';

export {
  scheduleBackgroundMcpDiscovery,
  startBackgroundProviderDiscovery,
  startBackgroundProviderDiscovery as startBackgroundProviderRegistration,
} from './bootstrap-background.js';
export type {
  BackgroundMcpDiscoveryOptions,
  BackgroundProviderDiscoveryOptions,
  HostSystemMessageSink,
  RuntimeSelectionState,
} from './bootstrap-background.js';
export {
  loadRuntimeSystemPrompt,
  loadRuntimeSystemPrompt as loadBootstrapSystemPrompt,
  restoreRuntimeModel,
  restoreRuntimeModel as restoreSavedModel,
  synchronizeConfiguredServices,
  synchronizeConfiguredServices as syncConfiguredServices,
} from './bootstrap-helpers.js';
export type { RuntimeModelSelectionState } from './bootstrap-helpers.js';
export { registerBootstrapRuntimeEvents, registerHostRuntimeEvents } from './bootstrap-runtime-events.js';
export type { BootstrapRuntimeEventBridgeOptions, HostRuntimeEventBridgeOptions, HostRuntimeMessageRouter } from './bootstrap-runtime-events.js';
export { startHostServices } from './bootstrap-services.js';
export { startHostServices as startExternalServices } from './bootstrap-services.js';
export type {
  HostServiceMode,
  HostServicesConfig,
  HostServicesHandle,
  HostServicesHandle as ExternalServicesHandle,
  HostServiceStatus,
} from './bootstrap-services.js';
export { registerBootstrapHookBridge } from './bootstrap-hook-bridge.js';
export type { HookBridgeRegistrationOptions } from './bootstrap-hook-bridge.js';

export { createDeferredStartupCoordinator } from './deferred-startup.js';
export type { DeferredStartupCoordinator, DeferredStartupTask } from './deferred-startup.js';
export {
  dismissGuidance,
  evaluateContextualGuidance,
  formatGuidanceItems,
  resetGuidance,
} from './guidance.js';
export type {
  ContextualGuidanceSnapshot,
  GuidanceCategory,
  GuidanceItem,
  GuidancePersistenceOptions,
} from './guidance.js';
export * from './host-ui.js';
export { IntegrationHelperService } from './integration/helpers.js';
export type { ContinuitySnapshot, IntegrationHelpersContext, PanelSnapshot, SettingsSnapshot, WorktreeSnapshot } from './integration/helpers.js';
export * from './mutable-runtime-state.js';
export * from './provider-accounts/registry.js';
export * from './sandbox/backend.js';
export * from './sandbox/manager.js';
export * from './sandbox/provisioning.js';
export * from './sandbox/qemu-wrapper-template.js';
export * from './sandbox/session-registry.js';
export * from './sandbox/types.js';
export * from './session-maintenance.js';
export * from './session-persistence.js';
export * from './session-return-context.js';
export * from './settings/control-plane.js';
export * from './settings/control-plane-store.js';
export * from './shell-command-extensions.js';
export * from './shell-command-ops.js';
export * from './shell-command-platform.js';
export * from './shell-command-services.js';
export * from './shell-command-workspace.js';
export * from './shell-paths.js';
export * from './surface-root.js';
export * from './system-message-policy.js';
export * from './ui-events.js';
export * from './ui-read-models-base.js';
export * from './ui-read-models-core.js';
export * from './ui-read-models-observability.js';
export * from './ui-read-models-observability-maintenance.js';
export * from './ui-read-models-observability-options.js';
export * from './ui-read-models-observability-remote.js';
export * from './ui-read-models-observability-security.js';
export * from './ui-read-models-observability-system.js';
export * from './ui-read-models-operations.js';
export * from './worktree/registry.js';
export * from './ecosystem/catalog.js';

export { createDiagnosticsProvider, DiagnosticsProvider } from './diagnostics/index.js';
export type { DiagnosticsProviderConfig, DiagnosticPanelName } from './diagnostics/provider.js';
export {
  BoundedTransitionLog,
  TimelineBuffer,
  SelectorHotspotSampler,
  StateInspectorProvider,
  createStateInspector,
} from './inspection/state-inspector/index.js';
export type {
  CreateStateInspectorOptions,
  DomainSnapshot,
  HotspotReport,
  HotspotSamplerConfig,
  InspectableDomain,
  SelectorHotspot,
  StateInspectorConfig,
  StateSnapshot,
  SubscriptionInfo,
  TimeTravelCursor,
  TimelineEvent,
  TransitionEntry,
} from './inspection/state-inspector/index.js';

export { createDirectTransport, createDirectTransportFromServices } from './transports/direct.js';
export { createRuntimeDirectTransport } from './transports/direct.js';
export type { DirectTransport } from './transports/direct.js';
export { createDirectClientTransport } from './transports/direct-client.js';
export type { DirectClientTransport } from './transports/direct-client.js';
export { createHttpTransport } from './transports/daemon-http-client.js';
export type { HttpTransport, HttpTransportOptions, HttpTransportSnapshot } from './transports/http-types.js';
export { createClientTransport } from './transports/client-transport.js';
export type { ClientTransport } from './transports/client-transport.js';
export { buildUrl, createTransportPaths, normalizeBaseUrl } from './transports/transport-paths.js';
export type { TransportPaths } from './transports/transport-paths.js';
export {
  createFetch,
  createHttpJsonTransport,
  createJsonInit,
  createJsonRequestInit,
  readJsonBody,
  requestJson,
} from './transports/http-json-transport.js';
export { createRealtimeTransport } from './transports/realtime.js';
export type { RealtimeTransport, RealtimeTransportOptions, RealtimeTransportSnapshot } from './transports/realtime.js';
export type {
  HttpJsonRequestOptions,
  HttpJsonTransport,
  HttpJsonTransportOptions,
  JsonObject,
  JsonValue,
  ResolvedContractRequest,
  TransportJsonError,
} from './transports/http-json-transport.js';
export {
  buildContractInput,
  invokeContractRoute,
  openContractRouteStream,
  requireContractRoute,
} from './transports/contract-http-client.js';
export type {
  ContractInvokeOptions,
  ContractRouteDefinition,
  ContractRouteLike,
  ContractStreamOptions,
} from './transports/contract-http-client.js';
export { isAbortError, openServerSentEventStream } from './transports/sse-stream.js';
export type { ServerSentEventHandlers, ServerSentEventOptions } from './transports/sse-stream.js';
export { createOperatorRemoteClient } from './transports/operator-remote-client.js';
export type {
  OperatorRemoteClient,
  OperatorRemoteClientInvokeOptions,
  OperatorRemoteClientStreamOptions,
} from './transports/operator-remote-client.js';
export { createPeerRemoteClient } from './transports/peer-remote-client.js';
export type {
  PeerRemoteClient,
  PeerRemoteClientInvokeOptions,
} from './transports/peer-remote-client.js';
export {
  buildEventSourceUrl,
  buildWebSocketUrl,
  createEventSourceConnector,
  createRemoteDomainEvents,
  createRemoteRuntimeEvents,
  createRemoteUiRuntimeEvents,
  createWebSocketConnector,
} from './transports/remote-events.js';
export type {
  DomainEventConnector,
  RemoteDomainEventsOptions,
  RemoteDomainEvents,
  RemoteRuntimeEvents,
  RemoteRuntimeEventsOptions,
  SerializedRuntimeEnvelope,
} from './transports/remote-events.js';

export * from './network/index.js';

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
  buildDenialExplanation,
  canonicalize,
  classifyCommand,
  classifySegment,
  collectCommandNodes,
  evaluateCommandAST,
  evaluateSegmentNode,
  higherPriority,
  parseAST,
  parseCommandAST,
  tokenize,
} from './permissions/normalization/index.js';
export type {
  CommandClassification,
  CommandNode,
  CommandSegment,
  CommandToken,
  PipeNode,
  SequenceNode,
  SubshellNode,
} from './permissions/normalization/index.js';
export {
  PolicySignatureError,
  canonicalise,
  runSafetyChecks,
  signBundle,
  verifyBundle,
} from './permissions/index.js';
export {
  MAX_INPUT_LENGTH,
  MAX_TOKEN_COUNT,
} from './permissions/normalization/tokenizer.js';
export type {
  BundleProvenance,
  DecisionReason,
  DivergenceReport,
  EnforceGateResult,
  SignedPolicyBundle,
} from './permissions/index.js';
export {
  evaluateOrchestrationSpawn,
} from './orchestration/spawn-policy.js';
export type {
  DistributedRuntimeSnapshotStore,
} from './remote/index.js';
export {
  TelemetryApiService,
} from './telemetry/index.js';
export type {
  LedgerEntry,
} from './telemetry/exporters/local-ledger.js';
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
