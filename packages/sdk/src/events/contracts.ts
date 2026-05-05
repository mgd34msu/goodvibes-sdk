/**
 * Event schema contracts for runtime event validation.
 */
export {
  type ContractResult,
  type EventEnvelopeShape,
  type FieldKind,
  type FieldSpec,
  validateEnvelope,
  validateEventFields,
  isString,
  isNumber,
  isBoolean,
  isObject,
} from './contracts/shared.js';

import { isObject, isString } from './contracts/shared.js';

// The named imports below are used both as public exports (via the `export { ... }`
// re-export blocks above) and as local references in the EVENT_VALIDATORS registry.
// Combining import + re-export into a single `export { ... } from '...'` block
// would require a second local import for registry use, which is equally redundant.
// Using `import` once and re-exporting the same names is the idiomatic TS pattern.
export {
  validateTurnStarted,
  validateTurnStreaming,
  validateTurnCompleted,
  validateTurnFailed,
  validateTurnCancelled,
  validateToolReceived,
  validateToolSucceeded,
  validateToolFailed,
} from './contracts/turn-tool.js';

export {
  validateAgentSpawning,
  validateAgentCompleted,
  validateAgentFailed,
  validateMcpConnected,
  validateMcpDisconnected,
  validateMcpReconnecting,
} from './contracts/agent-mcp.js';

export {
  validatePluginLoaded,
  validatePluginFailed,
  validateAutomationJobCreated,
  validateAutomationJobUpdated,
  validateAutomationJobEnabled,
  validateAutomationJobDisabled,
  validateAutomationRunQueued,
  validateAutomationRunStarted,
  validateAutomationRunCompleted,
  validateAutomationRunFailed,
  validateAutomationRunCancelled,
  validateAutomationScheduleError,
  validateAutomationJobAutoDisabled,
  validateRouteBindingCreated,
  validateRouteBindingUpdated,
  validateRouteBindingRemoved,
  validateRouteBindingResolved,
  validateRouteReplyTargetCaptured,
  validateRouteBindingFailed,
  validateControlPlaneClientConnected,
  validateControlPlaneClientDisconnected,
  validateControlPlaneSubscriptionCreated,
  validateControlPlaneSubscriptionDropped,
  validateControlPlaneAuthGranted,
  validateControlPlaneAuthRejected,
  validateDeliveryQueued,
  validateDeliveryStarted,
  validateDeliverySucceeded,
  validateDeliveryFailed,
  validateDeliveryDeadLettered,
  validateWatcherStarted,
  validateWatcherHeartbeat,
  validateWatcherCheckpointAdvanced,
  validateWatcherFailed,
  validateWatcherStopped,
  validateSurfaceEnabled,
  validateSurfaceDisabled,
  validateSurfaceAccountConnected,
  validateSurfaceAccountDegraded,
  validateSurfaceCapabilityChanged,
} from './contracts/automation-route.js';

import {
  validateTurnStarted,
  validateTurnStreaming,
  validateTurnCompleted,
  validateTurnFailed,
  validateTurnCancelled,
  validateToolReceived,
  validateToolSucceeded,
  validateToolFailed,
} from './contracts/turn-tool.js';
import { validateAgentSpawning, validateAgentCompleted, validateAgentFailed, validateMcpConnected, validateMcpDisconnected, validateMcpReconnecting } from './contracts/agent-mcp.js';
import {
  validatePluginLoaded,
  validatePluginFailed,
  validateAutomationJobCreated,
  validateAutomationJobUpdated,
  validateAutomationJobEnabled,
  validateAutomationJobDisabled,
  validateAutomationRunQueued,
  validateAutomationRunStarted,
  validateAutomationRunCompleted,
  validateAutomationRunFailed,
  validateAutomationRunCancelled,
  validateAutomationScheduleError,
  validateAutomationJobAutoDisabled,
  validateRouteBindingCreated,
  validateRouteBindingUpdated,
  validateRouteBindingRemoved,
  validateRouteBindingResolved,
  validateRouteReplyTargetCaptured,
  validateRouteBindingFailed,
  validateControlPlaneClientConnected,
  validateControlPlaneClientDisconnected,
  validateControlPlaneSubscriptionCreated,
  validateControlPlaneSubscriptionDropped,
  validateControlPlaneAuthGranted,
  validateControlPlaneAuthRejected,
  validateDeliveryQueued,
  validateDeliveryStarted,
  validateDeliverySucceeded,
  validateDeliveryFailed,
  validateDeliveryDeadLettered,
  validateWatcherStarted,
  validateWatcherHeartbeat,
  validateWatcherCheckpointAdvanced,
  validateWatcherFailed,
  validateWatcherStopped,
  validateSurfaceEnabled,
  validateSurfaceDisabled,
  validateSurfaceAccountConnected,
  validateSurfaceAccountDegraded,
  validateSurfaceCapabilityChanged,
} from './contracts/automation-route.js';

// Domain-grouping rule: entries are arranged by event domain (turn/tool, agent,
// mcp, plugin, automation, route, control-plane, delivery, watcher, surface).
// Within each domain group entries are sorted alphabetically by key.
// Event types without a registered validator are not listed here — they pass
// through validateKnownEvent as unknown and are documented in that function.
const EVENT_VALIDATORS: Record<string, (v: unknown) => import('./contracts/shared.js').ContractResult> = {
  // turn / tool domain
  STREAM_DELTA: validateTurnStreaming,
  TOOL_FAILED: validateToolFailed,
  TOOL_RECEIVED: validateToolReceived,
  TOOL_SUCCEEDED: validateToolSucceeded,
  TURN_CANCEL: validateTurnCancelled,
  TURN_COMPLETED: validateTurnCompleted,
  TURN_ERROR: validateTurnFailed,
  TURN_SUBMITTED: validateTurnStarted,
  // agent / mcp domain
  AGENT_COMPLETED: validateAgentCompleted,
  AGENT_FAILED: validateAgentFailed,
  AGENT_SPAWNING: validateAgentSpawning,
  MCP_CONNECTED: validateMcpConnected,
  MCP_DISCONNECTED: validateMcpDisconnected,
  MCP_RECONNECTING: validateMcpReconnecting,
  // plugin domain
  PLUGIN_FAILED: validatePluginFailed,
  PLUGIN_LOADED: validatePluginLoaded,
  // automation domain
  AUTOMATION_JOB_AUTO_DISABLED: validateAutomationJobAutoDisabled,
  AUTOMATION_JOB_CREATED: validateAutomationJobCreated,
  AUTOMATION_JOB_DISABLED: validateAutomationJobDisabled,
  AUTOMATION_JOB_ENABLED: validateAutomationJobEnabled,
  AUTOMATION_JOB_UPDATED: validateAutomationJobUpdated,
  AUTOMATION_RUN_CANCELLED: validateAutomationRunCancelled,
  AUTOMATION_RUN_COMPLETED: validateAutomationRunCompleted,
  AUTOMATION_RUN_FAILED: validateAutomationRunFailed,
  AUTOMATION_RUN_QUEUED: validateAutomationRunQueued,
  AUTOMATION_RUN_STARTED: validateAutomationRunStarted,
  AUTOMATION_SCHEDULE_ERROR: validateAutomationScheduleError,
  // route domain
  ROUTE_BINDING_CREATED: validateRouteBindingCreated,
  ROUTE_BINDING_FAILED: validateRouteBindingFailed,
  ROUTE_BINDING_REMOVED: validateRouteBindingRemoved,
  ROUTE_BINDING_RESOLVED: validateRouteBindingResolved,
  ROUTE_BINDING_UPDATED: validateRouteBindingUpdated,
  ROUTE_REPLY_TARGET_CAPTURED: validateRouteReplyTargetCaptured,
  // control-plane domain
  CONTROL_PLANE_AUTH_GRANTED: validateControlPlaneAuthGranted,
  CONTROL_PLANE_AUTH_REJECTED: validateControlPlaneAuthRejected,
  CONTROL_PLANE_CLIENT_CONNECTED: validateControlPlaneClientConnected,
  CONTROL_PLANE_CLIENT_DISCONNECTED: validateControlPlaneClientDisconnected,
  CONTROL_PLANE_SUBSCRIPTION_CREATED: validateControlPlaneSubscriptionCreated,
  CONTROL_PLANE_SUBSCRIPTION_DROPPED: validateControlPlaneSubscriptionDropped,
  // delivery domain
  DELIVERY_DEAD_LETTERED: validateDeliveryDeadLettered,
  DELIVERY_FAILED: validateDeliveryFailed,
  DELIVERY_QUEUED: validateDeliveryQueued,
  DELIVERY_STARTED: validateDeliveryStarted,
  DELIVERY_SUCCEEDED: validateDeliverySucceeded,
  // watcher domain
  WATCHER_CHECKPOINT_ADVANCED: validateWatcherCheckpointAdvanced,
  WATCHER_FAILED: validateWatcherFailed,
  WATCHER_HEARTBEAT: validateWatcherHeartbeat,
  WATCHER_STARTED: validateWatcherStarted,
  WATCHER_STOPPED: validateWatcherStopped,
  // surface domain
  SURFACE_ACCOUNT_CONNECTED: validateSurfaceAccountConnected,
  SURFACE_ACCOUNT_DEGRADED: validateSurfaceAccountDegraded,
  SURFACE_CAPABILITY_CHANGED: validateSurfaceCapabilityChanged,
  SURFACE_DISABLED: validateSurfaceDisabled,
  SURFACE_ENABLED: validateSurfaceEnabled,
};

/**
 * Validate a runtime event against its registered schema contract.
 *
 * Returns `{ valid: false }` for unknown event types — no validator is
 * registered for approximately 165 of 219 total event types. Use
 * `isKnownEventType` to distinguish "unknown type" from "validation failed".
 */
export function validateKnownEvent(event: unknown): import('./contracts/shared.js').ContractResult {
  if (!isObject(event)) return { valid: false, violations: ['event must be an object'] };
  const type = event['type'];
  if (!isString(type)) return { valid: false, violations: ['event.type must be a string'] };
  const validator = EVENT_VALIDATORS[type];
  if (!validator) return { valid: false, violations: [`unknown event type: '${type}'`] };
  return validator(event);
}

export function isKnownEventType(type: unknown): type is string {
  return isString(type) && type in EVENT_VALIDATORS;
}

export function registeredEventTypes(): readonly string[] {
  return Object.keys(EVENT_VALIDATORS);
}
