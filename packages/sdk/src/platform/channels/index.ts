export type {
  ChannelSurface,
  ChannelCapability,
  ChannelConversationKind,
  ChannelDirectoryScope,
  ChannelAccountLifecycleAction,
  ChannelTargetSource,
  ChannelIdentity,
  ChannelRouteBinding,
  ChannelAdapterDescriptor,
  ChannelDirectoryEntry,
  ChannelDirectoryQueryOptions,
  ChannelTargetResolveOptions,
  ChannelResolvedTarget,
  ChannelStatusSnapshot,
  ChannelSecretStatus,
  ChannelAccountAction,
  ChannelAccountRecord,
  ChannelAccountLifecycleResult,
  ChannelActorAuthorizationRequest,
  ChannelActorAuthorizationResult,
  ChannelCapabilityDescriptor,
  ChannelToolDescriptor,
  ChannelOperatorActionDescriptor,
  ChannelPolicyRecord,
  ChannelGroupPolicyRecord,
  ChannelPolicyAuditRecord,
  ChannelIngressPolicyInput,
  ChannelPolicyDecision,
  ChannelSecretBackend,
  ChannelSetupFieldKind,
  ChannelDoctorStatus,
  ChannelAllowlistTargetKind,
  ChannelReasoningVisibility,
  ChannelRenderFormat,
  ChannelRenderPhase,
  ChannelRenderEventKind,
  ChannelSecretTargetDescriptor,
  ChannelSetupFieldOption,
  ChannelSetupFieldDescriptor,
  ChannelSetupSchema,
  ChannelDoctorCheck,
  ChannelRepairAction,
  ChannelDoctorReport,
  ChannelLifecycleState,
  ChannelAllowlistTarget,
  ChannelAllowlistResolution,
  ChannelAllowlistEditInput,
  ChannelAllowlistEditResult,
  ChannelRenderEvent,
  ChannelRenderPolicy,
  ChannelRenderRequest,
  ChannelRenderResult,
  ChannelHealthState,
  ChannelRuntimeObservation,
} from './types.js';
// Health is one rule, exported so a consumer classifies a reported state the
// same way the runtime produced it. Two readings of one state field is how a
// dead channel came to look healthy in the first place.
export {
  isChannelFailing,
  isChannelWorking,
  observedRuntime,
  resolveChannelHealthState,
  unobservableRuntime,
} from './health.js';
export type { ChannelHealthInput } from './health.js';
export { ChannelIngressAlarm, DEFAULT_INGRESS_ALARM_WINDOW_MS } from './ingress-alarm.js';
export type { ChannelIngressAlarmDeps, ChannelIngressFailureState } from './ingress-alarm.js';
export { ChannelHealthWatcher } from './health-watcher.js';
export type { ChannelHealthAlert, ChannelHealthWatcherDeps } from './health-watcher.js';
export type { UpsertRouteBindingInput } from './route-manager.js';
export { RouteBindingManager } from './route-manager.js';
export { SurfaceRegistry } from './surface-registry.js';
export type { ChannelPlugin } from './plugin-registry.js';
export { ChannelPluginRegistry } from './plugin-registry.js';
export { ChannelPolicyManager } from './policy-manager.js';
export { BuiltinChannelRuntime } from './builtin-runtime.js';
// The authoritative per-channel credential/setup declaration. Exported so
// consumers (command surfaces, setup UIs) read the one source of truth instead
// of duplicating each surface's field/secret-target schema.
export { getBuiltinSetupSchema } from './builtin/setup-schema.js';
export { CHANNEL_SETUP_VERSION } from './builtin/shared.js';
export { ChannelReplyPipeline, normalizeChannelRenderEventFromRuntime } from './reply-pipeline.js';
export { ChannelProviderRuntimeManager } from './provider-runtime.js';
export type { ProviderRuntimeActionResult, ProviderRuntimeStatus, ProviderRuntimeSurface } from './provider-runtime.js';
export { ChannelDeliveryRouter, createDefaultChannelDeliveryStrategies, resolveChannelDeliverySurfaceKind } from './delivery-router.js';
export type {
  ChannelDeliveryResult,
  ChannelDeliveryRouteBinding,
  ChannelDeliveryRouterConfig,
  ChannelDeliveryStrategy,
  ChannelDeliverySurfaceKind,
  ChannelDeliveryTarget,
  ChannelDeliveryTargetKind,
} from './delivery-router.js';
export { CHANNEL_DELIVERY_SURFACE_KINDS } from './delivery-router.js';
// The agent is a delivery destination the SDK defines and another product
// implements: it owns the surface kind and the message contract, the agent
// product registers the callable that lands the message in its conversation.
export {
  AGENT_DELIVERY_STRATEGY_ID,
  AgentDeliveryRegistry,
  createAgentDeliveryStrategy,
} from './delivery-router.js';
export type {
  AgentConversationMessage,
  AgentConversationSender,
} from './delivery-router.js';
export type { ChannelDeliveryRequest } from './delivery/types.js';
