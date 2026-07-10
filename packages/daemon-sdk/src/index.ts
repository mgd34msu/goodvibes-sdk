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
  DaemonGatewayRestRouteHandlers,
  GatewayRestVerbInvocation,
} from './context.js';
export { dispatchAutomationRoutes } from './automation.js';
export { dispatchSessionRoutes } from './sessions.js';
export { dispatchTaskRoutes } from './tasks.js';
export { dispatchOperatorRoutes } from './operator.js';
export { dispatchRemoteRoutes } from './remote.js';
export { dispatchDaemonApiRoutes } from './api-router.js';
export type { DaemonApiRouteExtension } from './api-router.js';
export { dispatchGatewayRestRoutes, GATEWAY_REST_ROUTES } from './gateway-rest-routes.js';
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
  MemoryBundleInput,
  MemoryLinkInput,
  MemoryProvenanceLinkInput,
  MemoryRecordAddInput,
  MemoryRecordReviewInput,
  MemoryRecordSearchFilterInput,
  MemoryRecordUpdateInput,
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
  CredentialStatusProviderLike,
  CredentialStatusRecord,
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
export {
  decodeCursor,
  encodeCursor,
  hasPaginationParams,
  paginateItems,
} from './pagination.js';
export type { PaginatedResponse } from './pagination.js';
export type { JsonErrorResponseOptions } from './error-response.js';
