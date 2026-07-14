export type {
  ControlPlaneStreamingMode,
  ControlPlaneClientSurface,
  ControlPlaneServerConfig,
  ControlPlaneClientDescriptor,
  ControlPlaneEventSubscription,
} from './types.js';
export type { ControlPlaneGatewayConfig, ControlPlaneEventStreamOptions, ControlPlaneRecentEvent } from './gateway.js';
export { ControlPlaneGateway } from './gateway.js';
export { SSE_HEARTBEAT_INTERVAL_MS, sseIdleTimeoutSeconds } from './sse-timing.js';
export {
  GatewayMethodCatalog,
} from './method-catalog.js';
export type {
  GatewayEventDescriptor,
  GatewayEventListOptions,
  GatewayEventTransport,
  GatewayHttpBinding,
  GatewayMethodAccess,
  GatewayMethodDescriptor,
  GatewayMethodHandler,
  GatewayMethodInvocation,
  GatewayMethodInvocationContext,
  GatewayMethodListOptions,
  GatewayMethodSource,
  GatewayMethodTransport,
} from './method-catalog.js';
export type {
  CreateSharedSessionInput,
  EnsureSharedSessionInput,
  FindSharedSessionOptions,
  ListSharedSessionsOptions,
  ParticipantRouteAttachInput,
  RegisterSharedSessionInput,
  SharedSessionRegisterResult,
  SharedSessionKind,
  SharedSessionMessage,
  SharedSessionParticipant,
  SharedSessionRecord,
  SharedSessionStatus,
  SharedSessionSubmission,
  SteerSharedSessionMessageInput,
  SubmitSharedSessionMessageInput,
} from './session-types.js';
export type {
  SharedSessionAgentSpawnRoutingInput,
  SharedSessionCompletion,
  SharedSessionContinuationRequest,
  SharedSessionContinuationResult,
  SharedSessionHelperModelOverride,
  SharedSessionInputIntent,
  SharedSessionInputRecord,
  SharedSessionInputState,
  SharedSessionRoutingIntent,
} from './session-intents.js';
// The one shared normalizer from a session's routing intent to an agent-spawn
// routing input — public so every surface derives spawn routing identically
// instead of re-implementing the model/provider/fallback rules.
export { buildSharedSessionAgentSpawnRoutingInput } from './session-intents.js';
// Surface-presence check plus the freshness window the daemon itself applies:
// lets a consumer compose the same "is a live surface attached?" answer the
// broker uses for steer/follow-up routing.
export { hasFreshSurfaceParticipant, SURFACE_ROUTE_FRESHNESS_MS } from './session-broker-sessions.js';
export { SharedSessionBroker } from './session-broker.js';
export {
  discoverLegacySessionSources,
  importLegacySessionStores,
} from './session-store-importer.js';
export type {
  LegacySessionSource,
  ImportLegacySessionsResult,
} from './session-store-importer.js';
export type {
  SharedApprovalRecord,
  SharedApprovalAuditRecord,
  SharedApprovalStatus,
  RequestSharedApprovalInput,
} from './approval-broker.js';
export { ApprovalBroker } from './approval-broker.js';
export {
  buildModifiedEditArgs,
  readApprovalEditHunks,
  resolveApprovalHunkSelection,
} from './approval-hunk-apply.js';
export type { EditHunkLike, ApprovalHunkSelectionResolution } from './approval-hunk-apply.js';
export type { ControlPlaneAuthMode, ControlPlaneAuthSnapshot } from '../../client-auth/control-plane-auth-snapshot.js';
export type { MessageSource, ConversationMessageEnvelope } from './conversation-message.js';
export { buildOperatorContract } from './operator-contract.js';
export { dispatchDaemonApiRoutes } from './routes/index.js';
export {
  ARTIFACT_ACQUISITION_MODE_SCHEMA,
  ARTIFACT_FETCH_MODE_SCHEMA,
} from './media-contract-schemas.js';
export {
  ARTIFACT_ATTACHMENT_SCHEMA,
  ARTIFACT_DESCRIPTOR_SCHEMA,
} from './operator-contract-schemas-shared.js';
export {
  AUTOMATION_RUN_SCHEMA,
  ROUTE_BINDING_SCHEMA,
} from './operator-contract-schemas-admin.js';
export {
  SHARED_SESSION_INPUT_RECORD_SCHEMA,
  SHARED_SESSION_ROUTING_INTENT_SCHEMA,
} from './operator-contract-schemas-runtime.js';
export {
  KNOWLEDGE_INJECTION_PROMPT_SCHEMA,
  KNOWLEDGE_INJECTION_SCHEMA,
} from './operator-contract-schemas-knowledge.js';
// fleet.*/checkpoints.*/sessions.search verb registration (see routes/register-fleet-checkpoints-search.ts).
export { registerFleetCheckpointsSearchGatewayMethods } from './routes/register-fleet-checkpoints-search.js';
// The single verb-group registrar the runtime-services composition root calls:
// folds in the fleet/checkpoints group above and constructs + wires the
// browser-push group (see routes/register-gateway-verb-groups.ts).
export { registerGatewayVerbGroups } from './routes/register-gateway-verb-groups.js';
export type { GatewayVerbGroupDeps } from './routes/register-gateway-verb-groups.js';
// skills.* CRUD verb registration over the canonical SkillService (see routes/skills.ts).
export { registerSkillsGatewayMethods } from './routes/skills.js';
export type { SkillsGatewayService } from './routes/skills.js';
