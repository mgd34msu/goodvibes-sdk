export type {
  MaybeResponse,
  DaemonApiRouteHandlers,
  DaemonRemoteDispatchRouteHandlers,
  DaemonOperatorRouteHandlers,
  DaemonAutomationRouteHandlers,
  DaemonSessionRouteHandlers,
  DaemonTaskRouteHandlers,
  DaemonControlRouteHandlers,
  DaemonTelemetryRouteHandlers,
  DaemonChannelRouteHandlers,
  DaemonIntegrationRouteHandlers,
  DaemonSystemRouteHandlers,
  DaemonRemoteManagementRouteHandlers,
  DaemonKnowledgeRouteHandlers,
  DaemonKnowledgeRefinementRouteHandlers,
  DaemonMediaRouteHandlers,
  DaemonRuntimeSessionRouteHandlers,
  DaemonRuntimeAutomationRouteHandlers,
  DaemonRuntimeRouteHandlers,
} from './context.js';
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
export type { AuthenticatedPrincipal, AuthenticatedPrincipalKind, AuthenticatedPrincipalResolver, ElevatedPrivateHostFetchConfig, PrivateHostFetchConfig } from './http-policy.js';
export {
  createRouteBodySchema,
  createRouteBodySchemaRegistry,
  isJsonRecord,
  missingScopes,
  readBoundedBodyInteger,
  readBoundedInteger,
  readBoundedPositiveInteger,
  readChannelConversationKind,
  readChannelLifecycleAction,
  readOptionalBoundedInteger,
  readOptionalStringField,
  readStringArrayField,
  scopeMatches,
} from './route-helpers.js';
export type {
  BoundedIntegerOptions,
  ChannelConversationKind,
  ChannelLifecycleAction,
  JsonBody,
  JsonRecord,
  RouteBodySchema,
} from './route-helpers.js';
export type {
  ChannelAgentToolDefinitionLike,
  ChannelAllowlistInput,
  ChannelAuthorizeActionInput,
  ChannelDirectoryQuery,
  ChannelDirectoryScope,
  ChannelPluginServiceLike,
  ChannelPolicyServiceLike,
  ChannelSurface,
  ChannelTargetResolutionInput,
  DaemonChannelRouteContext,
  SurfaceRegistryLike,
} from './channel-route-types.js';
export type {
  ChannelAccountRegistryLike,
  DaemonIntegrationRouteContext,
  IntegrationHelperServiceLike,
  IntegrationRuntimeStoreLike,
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
  IntegrationApprovalSnapshotSourceLike,
  PlatformServiceManagerLike,
  RouteBindingManagerLike,
  RouteBindingPatchInput,
  RouteBindingRecordInput,
  WatcherKind,
  WatcherRecord,
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
  ArtifactStoreLike,
  DaemonMediaRouteContext,
  FetchExtractMode,
  MediaArtifact,
  MediaProviderLike,
  MediaProviderRegistryLike,
  MultimodalAnalysisResult,
  MultimodalDetail,
  MultimodalServiceLike,
  VoiceAudioArtifact,
  VoiceServiceLike,
  VoiceSynthesisStreamLike,
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
export { decodeOtlpProtobuf } from './otlp-protobuf.js';
export type { OtlpProtobufKind } from './otlp-protobuf.js';
export { createDaemonChannelRouteHandlers } from './channel-routes.js';
export { createDaemonIntegrationRouteHandlers } from './integration-routes.js';
export { createDaemonSystemRouteHandlers } from './system-routes.js';
export { createDaemonKnowledgeRouteHandlers } from './knowledge-routes.js';
export { createDaemonKnowledgeRefinementRouteHandlers } from './knowledge-refinement-routes.js';
export { createDaemonMediaRouteHandlers } from './media-routes.js';
export type { ConversationMessageEnvelope, DaemonRuntimeRouteContext } from './runtime-route-types.js';
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
export type { JsonErrorResponseOptions } from './error-response.js';
