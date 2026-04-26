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

export { RuntimeEventBus } from './events/index.js';
export { createEventEnvelope } from './event-envelope.js';
export type { EventEnvelope, EventEnvelopeContext } from './event-envelope.js';
export type { RuntimeEventEnvelope, EnvelopeContext } from './events/envelope.js';
export { RUNTIME_EVENT_DOMAINS, isRuntimeEventDomain } from './events/domain-map.js';
export type { AnyRuntimeEvent, RuntimeEventDomain, RuntimeEventRecord } from './events/domain-map.js';
export { createRuntimeEventFeed, createRuntimeEventFeeds } from './event-feeds.js';
export type { RuntimeEventFeed, RuntimeEventFeeds } from './event-feeds.js';
export { getSecuritySettingsReport } from './security-settings.js';
export type { SecuritySettingReport, SecuritySettingsReporter } from './security-settings.js';

export type { EmitterContext } from './emitters/index.js';

export { RuntimeHealthAggregator } from './health/aggregator.js';
export { CascadeEngine } from './health/cascade-engine.js';
export { CASCADE_RULES } from './health/cascade-rules.js';
export { createHealthSystem } from './health/index.js';
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
export type { Notification, NotificationLevel, NotificationTarget, DomainVerbosity, RoutingDecision } from './notifications/types.js';

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

export {
  scheduleBackgroundMcpDiscovery,
  scheduleMcpAutodiscovery,
  startBackgroundProviderDiscovery,
  startBackgroundProviderRegistration,
} from './bootstrap-background.js';
export type {
  BackgroundMcpDiscoveryOptions,
  BackgroundProviderDiscoveryOptions,
  HostSystemMessageSink,
  RuntimeSelectionState,
} from './bootstrap-background.js';
export {
  loadBootstrapSystemPrompt,
  loadRuntimeSystemPrompt,
  restoreRuntimeModel,
  restoreSavedModel,
  syncConfiguredServices,
  synchronizeConfiguredServices,
} from './bootstrap-helpers.js';
export type { RuntimeModelSelectionState } from './bootstrap-helpers.js';
export { registerBootstrapRuntimeEvents, registerHostRuntimeEvents } from './bootstrap-runtime-events.js';
export type { BootstrapRuntimeEventBridgeOptions, HostRuntimeEventBridgeOptions, HostRuntimeMessageRouter } from './bootstrap-runtime-events.js';
export { startExternalServices, startHostServices } from './bootstrap-services.js';
export type { ExternalServicesConfig, ExternalServicesHandle, HostServicesConfig, HostServicesHandle } from './bootstrap-services.js';

export { createDiagnosticsProvider, DiagnosticsProvider } from './diagnostics/index.js';
export type { DiagnosticsProviderConfig, DiagnosticPanelName } from './diagnostics/provider.js';

export { createDirectTransport, createDirectTransportFromServices } from './transports/direct.js';
export { createRuntimeDirectTransport } from './transports/direct.js';
export type { DirectTransport } from './transports/direct.js';
export { createDirectClientTransport } from './transports/direct-client.js';
export type { DirectClientTransport } from './transports/direct-client.js';
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
  RemoteDomainEvents,
  RemoteRuntimeEvents,
  SerializedRuntimeEnvelope,
} from './transports/remote-events.js';

export * from './network/index.js';
