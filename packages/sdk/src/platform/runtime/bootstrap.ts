export {
  scheduleBackgroundMcpDiscovery,
  startBackgroundProviderDiscovery,
} from './bootstrap-background.js';
export type {
  BackgroundRuntimeTaskHandle,
  BackgroundMcpDiscoveryOptions,
  BackgroundProviderDiscoveryOptions,
  HostSystemMessageSink,
  RuntimeSelectionState,
} from './bootstrap-background.js';
export {
  loadRuntimeSystemPrompt,
  loadRuntimeSystemPromptWithSources,
  restoreRuntimeModel,
  synchronizeConfiguredServices,
} from './bootstrap-helpers.js';
export type { RuntimeModelSelectionState } from './bootstrap-helpers.js';
export { registerBootstrapRuntimeEvents, registerHostRuntimeEvents } from './bootstrap-runtime-events.js';
export type {
  BootstrapRuntimeEventBridgeOptions,
  HostRuntimeEventBridgeOptions,
  HostRuntimeMessageRouter,
} from './bootstrap-runtime-events.js';
export { startHostServices } from './bootstrap-services.js';
export type {
  HostServiceMode,
  HostServicesConfig,
  HostServicesHandle,
  HostServiceStatus,
} from './bootstrap-services.js';
export {
  classifyDaemonProbe,
  decideDaemonAdoption,
} from './daemon-adoption-policy.js';
export type {
  DaemonIdentityProbeResult,
  DaemonProbeClassification,
  DaemonProbeClassificationInput,
  DaemonAdoptionAction,
  DaemonAdoptionDecision,
  DaemonAdoptionPolicyInput,
} from './daemon-adoption-policy.js';
export { registerBootstrapHookBridge } from './bootstrap-hook-bridge.js';
export type { HookBridgeRegistrationOptions } from './bootstrap-hook-bridge.js';
export { createDeferredStartupCoordinator } from './deferred-startup.js';
export type { DeferredStartupCoordinator, DeferredStartupTask } from './deferred-startup.js';
export { shutdownRuntime, saveSession, fireSessionStart } from './lifecycle.js';
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
  OperatorClientRuntimeSlice,
} from './foundation-services.js';
export { createRuntimeFoundationClients } from './foundation-clients.js';
export type {
  RuntimeFoundationClients,
  RuntimeFoundationClientsOptions,
  RuntimeFoundationServicesSlice,
} from './foundation-clients.js';
// The FULL runtime-services composition interface. `RuntimeFoundationServicesSlice`
// is the narrow `Pick<>` a foundation-clients consumer needs; this is the whole
// interface a fork that composes its own runtime services owns and constructs.
// It is the stable public name for what `startHostServices`'s runtimeServices
// parameter takes — consumers name this alias instead of re-anchoring through
// the positional `Parameters<typeof startHostServices>[3]`.
export type { RuntimeServices } from './services.js';
// The OTHER composition shape: what a surface product's interactive loop needs
// in-process, without the daemon-grade furniture `RuntimeServices` requires.
// Purely additive — `RuntimeServices` is unchanged and still satisfies the
// shared part of it (`ClientRuntimeServicesFromHost`).
export {
  createClientRuntimeServices,
  createHeldSessionDispatch,
  asClientRuntimeView,
} from './client-services.js';
export type {
  ClientRuntimeServices,
  ClientRuntimeServicesOptions,
  ClientRuntimeServicesFromHost,
  ClientOnlyServiceMember,
  SessionContinuationDispatch,
  ApprovalRaiser,
  UserPermissionRuleAccess,
} from './client-services.js';
// The free functions both compositions share, so a product that hand-composes
// a graph builds each piece the one way rather than a fourth way.
export { resolveRuntimeFeatureFlags } from './feature-flag-composition.js';
export type { RuntimeFeatureFlagOptions } from './feature-flag-composition.js';
export { createProviderStack } from './provider-stack.js';
export type { ProviderStack, ProviderStackOptions } from './provider-stack.js';
export { createAgentGraph } from './agent-graph.js';
export type { AgentGraph, AgentGraphOptions } from './agent-graph.js';
export {
  createApprovalDerivedHandlers,
  createBrokeredPermissionManager,
  createPolicyRuntimeState,
  createUserPermissionRuleStore,
} from './permissions/permission-composition.js';
export type {
  ApprovalDerivedHandlers,
  ApprovalDerivedHandlerOptions,
  BrokeredPermissionManagerOptions,
} from './permissions/permission-composition.js';
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
