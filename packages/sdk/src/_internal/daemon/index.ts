// Synced from packages/daemon-sdk/src/index.ts
export type { MaybeResponse, DaemonApiRouteHandlers } from './context.js';
export { dispatchAutomationRoutes } from './automation.js';
export { dispatchSessionRoutes } from './sessions.js';
export { dispatchTaskRoutes } from './tasks.js';
export { dispatchOperatorRoutes } from './operator.js';
export { dispatchRemoteRoutes } from './remote.js';
export { dispatchDaemonApiRoutes } from './api-router.js';
export type { DaemonApiRouteExtension } from './api-router.js';
export {
  buildMissingScopeBody,
  resolveAuthenticatedPrincipal,
  resolvePrivateHostFetchOptions,
} from './http-policy.js';
export type { AuthenticatedPrincipal, AuthenticatedPrincipalKind } from './http-policy.js';
export {
  isJsonRecord,
  missingScopes,
  readChannelConversationKind,
  readChannelLifecycleAction,
  scopeMatches,
} from './route-helpers.js';
export type {
  ChannelConversationKind,
  ChannelLifecycleAction,
  JsonRecord,
} from './route-helpers.js';
export type {
  ChannelDirectoryQuery,
  ChannelDirectoryScope,
  ChannelPluginServiceLike,
  ChannelPolicyServiceLike,
  ChannelSurface,
  DaemonChannelRouteContext,
  SurfaceRegistryLike,
} from './channel-route-types.js';
export type {
  ChannelAccountRegistryLike,
  DaemonIntegrationRouteContext,
  IntegrationHelperServiceLike,
  MemoryEmbeddingRegistryLike,
  MemoryRegistryLike,
  ProviderRuntimeSnapshotServiceLike,
  RuntimeEventDomain as DaemonRuntimeEventDomain,
  UserAuthManagerLike,
} from './integration-route-types.js';
export type {
  ApprovalBrokerLike,
  AutomationDeliveryGuarantee,
  AutomationRouteBindingKind,
  AutomationSessionPolicy,
  AutomationSurfaceKind,
  AutomationThreadPolicy,
  ConfigManagerLike as DaemonSystemConfigManagerLike,
  DaemonApiClientKind,
  DaemonSystemRouteContext,
  PlatformServiceManagerLike,
  RouteBindingManagerLike,
  WatcherKind,
  WatcherRegistryLike,
  WorkspaceSwapManagerLike,
} from './system-route-types.js';
export type {
  AuthenticatedPrincipalLike,
  AutomationScheduleDefinition,
  DaemonKnowledgeRouteContext,
  KnowledgeGraphqlAccessLike,
  KnowledgeGraphqlResultLike,
  KnowledgeGraphqlServiceLike,
  KnowledgePacketDetail,
  KnowledgeProjectionTargetKind,
  KnowledgeServiceLike,
} from './knowledge-route-types.js';
export type {
  ArtifactKind,
  DaemonMediaRouteContext,
  FetchExtractMode,
  MediaArtifact,
  MediaProviderRegistryLike,
  MultimodalAnalysisResult,
  MultimodalDetail,
  MultimodalServiceLike,
  VoiceAudioArtifact,
  VoiceServiceLike,
  WebSearchSafeSearch,
  WebSearchServiceLike,
  WebSearchTimeRange,
  WebSearchVerbosity,
} from './media-route-types.js';
export {
  createArtifactFromUploadRequest,
  isArtifactUploadRequest,
  isJsonContentType,
} from './artifact-upload.js';
export type {
  ArtifactStoreUploadLike,
  ArtifactUploadFieldMap,
  ArtifactUploadResult,
} from './artifact-upload.js';
export { createDaemonControlRouteHandlers } from './control-routes.js';
export { createDaemonTelemetryRouteHandlers } from './telemetry-routes.js';
export { createDaemonChannelRouteHandlers } from './channel-routes.js';
export { createDaemonIntegrationRouteHandlers } from './integration-routes.js';
export { createDaemonSystemRouteHandlers } from './system-routes.js';
export { createDaemonKnowledgeRouteHandlers } from './knowledge-routes.js';
export { createDaemonKnowledgeRefinementRouteHandlers } from './knowledge-refinement-routes.js';
export { createDaemonMediaRouteHandlers } from './media-routes.js';
export type { DaemonRuntimeRouteContext, JsonBody } from './runtime-route-types.js';
export { createDaemonRuntimeAutomationRouteHandlers } from './runtime-automation-routes.js';
export { createDaemonRuntimeSessionRouteHandlers } from './runtime-session-routes.js';
export { createDaemonRuntimeRouteHandlers } from './runtime-routes.js';
export {
  createDaemonRemoteRouteHandlers,
  handleRemotePairRequest,
  handleRemotePairVerify,
  handleRemotePeerHeartbeat,
  handleRemotePeerWorkPull,
  handleRemotePeerWorkComplete,
} from './remote-routes.js';
export { buildErrorResponseBody, jsonErrorResponse, summarizeErrorForRecord } from './error-response.js';
