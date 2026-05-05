export type {
  GoodVibesRealtime,
  GoodVibesSdk,
  GoodVibesRealtimeOptions,
  GoodVibesSdkOptions,
} from './client.js';
export { createGoodVibesSdk } from './client.js';
export type {
  BrowserTokenStoreOptions,
  AutoRefreshCoordinatorOptions,
  AutoRefreshOptions,
  ControlPlaneAuthMode,
  ControlPlaneAuthSnapshot,
  GoodVibesAuthClient,
  GoodVibesAuthLoginOptions,
  GoodVibesCurrentAuth,
  GoodVibesExpiringTokenStore,
  GoodVibesLoginInput,
  GoodVibesLoginOutput,
  GoodVibesTokenStore,
} from './auth.js';
export {
  createBrowserTokenStore,
  createGoodVibesAuthClient,
  createMemoryTokenStore,
} from './auth.js';
export type { BrowserGoodVibesSdkOptions } from './browser.js';
export { createBrowserGoodVibesSdk } from './browser.js';
export type { WebGoodVibesSdkOptions } from './web.js';
export { createWebGoodVibesSdk } from './web.js';
export type {
  GoodVibesCloudflareExecutionContext,
  GoodVibesCloudflareMessageBatch,
  GoodVibesCloudflareQueue,
  GoodVibesCloudflareQueueMessage,
  GoodVibesCloudflareQueuePayload,
  GoodVibesCloudflareWorker,
  GoodVibesCloudflareWorkerEnv,
  GoodVibesCloudflareWorkerOptions,
} from './workers.js';
export { createGoodVibesCloudflareWorker } from './workers.js';
export type {
  ReactNativeGoodVibesRealtime,
  ReactNativeGoodVibesSdk,
  ReactNativeGoodVibesSdkOptions,
} from './react-native.js';
export { createReactNativeGoodVibesSdk } from './react-native.js';
export type { ExpoGoodVibesSdkOptions } from './expo.js';
export { createExpoGoodVibesSdk } from './expo.js';
// The barrel re-exports below flatten symbols from their respective packages
// into the root SDK entrypoint. Each module is a single-concern passthrough
// that re-exports a transport, event, or contract layer.
//
// Why the indirection through named modules rather than direct `export *`?
// - Each intermediate module (observer, events, contracts, errors,
//   transport-*) is also a versioned, independently buildable sub-package.
//   The indirection lets us tree-shake at sub-package boundaries.
// - It makes source attribution explicit in the final bundle map.
//
// Collision risk: keep exported names unique across these modules so the root
// surface remains deterministic and compile-time collisions stay obvious.
export { TokenStore, SessionManager, PermissionResolver, AutoRefreshCoordinator } from './client-auth/index.js';
export * from './observer/index.js';
export * from './events/index.js';
// Re-export contracts explicitly, excluding names also exported by events/index.js
// (RUNTIME_EVENT_DOMAINS, RuntimeEventDomain, isRuntimeEventDomain) to avoid TS2308.
export type {
  ContractHttpDefinition,
  DistributedPeerKind,
  DistributedWorkStatus,
  DistributedWorkType,
  GatewayEventTransport,
  GatewayMethodAccess,
  GatewayMethodSource,
  GatewayMethodTransport,
  JsonSchema,
  OperatorContractManifest,
  OperatorEventCoverageContract,
  OperatorEventContract,
  OperatorMethodContract,
  OperatorSchemaCoverageContract,
  PeerContractManifest,
  PeerEndpointContract,
  OperatorEventPayload,
  OperatorEventPayloadMap,
  JsonPrimitive,
  JsonValue,
  OperatorMethodInput,
  OperatorMethodInputMap,
  OperatorMethodOutput,
  OperatorMethodOutputMap,
  OperatorStreamMethodId,
  OperatorTypedEventId,
  OperatorTypedMethodId,
  PeerEndpointInput,
  PeerEndpointInputMap,
  PeerEndpointOutput,
  PeerEndpointOutputMap,
  PeerTypedEndpointId,
  RuntimeDomainEventPayload,
  RuntimeDomainEventPayloadMap,
  RuntimeDomainEventType,
  RuntimeEventTypedDomain,
  SharedSessionConversationRouteOutput,
  OperatorMethodId,
  PeerEndpointId,
  ControlAuthLoginResponse,
  ControlAuthCurrentResponse,
  AccountsSnapshotResponse,
  SerializedEventEnvelopeShape,
  TypedSerializedEventEnvelopeShape,
  ControlStatusResponse,
  LocalAuthStatusResponse,
  ProviderModelRef,
  ProviderModelEntry,
  ConfiguredVia,
  ProviderAuthRouteDescriptor,
  ProviderModelProvider,
  ListProviderModelsResponse,
  CurrentModelResponse,
  PatchCurrentModelBody,
  PatchCurrentModelError,
  PatchCurrentModelResponse,
  ModelChangedEvent,
} from './contracts.js';
export {
  DISTRIBUTED_WORK_TYPES,
  FOUNDATION_METADATA,
  OPERATOR_CONTRACT,
  OPERATOR_METHOD_IDS,
  PEER_CONTRACT,
  PEER_ENDPOINT_IDS,
  getOperatorContract,
  getPeerContract,
  getOperatorMethod,
  getPeerEndpoint,
  listOperatorMethods,
  listPeerEndpoints,
  isOperatorMethodId,
  isPeerEndpointId,
  ControlAuthLoginResponseSchema,
  ControlAuthCurrentResponseSchema,
  AccountsSnapshotResponseSchema,
  SerializedEventEnvelopeSchema,
  TypedSerializedEventEnvelopeSchema,
  RuntimeEventRecordSchema,
  ControlStatusResponseSchema,
  LocalAuthStatusResponseSchema,
  ProviderModelRefSchema,
  ProviderModelEntrySchema,
  ConfiguredViaSchema,
  ProviderAuthRouteDescriptorSchema,
  ProviderModelProviderSchema,
  ListProviderModelsResponseSchema,
  CurrentModelResponseSchema,
  PatchCurrentModelBodySchema,
  PatchCurrentModelErrorSchema,
  PatchCurrentModelResponseSchema,
  ModelChangedEventSchema,
} from './contracts.js';
export * from './errors.js';
export * from './transport-core.js';
export * from './transport-direct.js';
export * from './transport-http.js';
export * from './transport-realtime.js';
export * from './operator.js';
export * from './peer.js';
