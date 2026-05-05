/**
 * arbitraries.ts — shared fast-check arbitraries and fixture data for integration tests.
 *
 * Exports:
 *   - `jsonValueArb`           — recursive JSON-value arbitrary (null | bool | finite number | string | array | object)
 *   - `KNOWN_EVENT_TYPES`      — Set<string> of all known AnyRuntimeEvent discriminants
 *   - `REQUIRED_FIELDS_BY_TYPE` — required-field map per event type
 *   - `FIXTURE_EVENTS`         — one canonical minimal instance per event kind
 */

import fc from 'fast-check';

import type { SessionEvent } from '../../../packages/sdk/src/events/session.js';
import type { TurnEvent } from '../../../packages/sdk/src/events/turn.js';
import type { AgentEvent } from '../../../packages/sdk/src/events/agents.js';
import type { WorkflowEvent } from '../../../packages/sdk/src/events/workflows.js';
import type { TaskEvent } from '../../../packages/sdk/src/events/tasks.js';
import type { ToolEvent } from '../../../packages/sdk/src/events/tools.js';
import type { ProviderEvent } from '../../../packages/sdk/src/events/providers.js';
import type { PluginEvent } from '../../../packages/sdk/src/events/plugins.js';
import type { McpEvent } from '../../../packages/sdk/src/events/mcp.js';
import type { TransportEvent } from '../../../packages/sdk/src/events/transport.js';
import type { CompactionEvent } from '../../../packages/sdk/src/events/compaction.js';
import type { UIEvent } from '../../../packages/sdk/src/events/ui.js';
import type { OpsEvent } from '../../../packages/sdk/src/events/ops.js';
import type { ForensicsEvent } from '../../../packages/sdk/src/events/forensics.js';
import type { SecurityEvent } from '../../../packages/sdk/src/events/security.js';
import type { AutomationEvent } from '../../../packages/sdk/src/events/automation.js';
import type { RouteEvent } from '../../../packages/sdk/src/events/routes.js';
import type { ControlPlaneEvent } from '../../../packages/sdk/src/events/control-plane.js';
import type { DeliveryEvent } from '../../../packages/sdk/src/events/deliveries.js';
import type { WatcherEvent } from '../../../packages/sdk/src/events/watchers.js';
import type { SurfaceEvent } from '../../../packages/sdk/src/events/surfaces.js';
import type { KnowledgeEvent } from '../../../packages/sdk/src/events/knowledge.js';
import type { CommunicationEvent } from '../../../packages/sdk/src/events/communication.js';
import type { PermissionEvent } from '../../../packages/sdk/src/events/permissions.js';
import type { OrchestrationEvent } from '../../../packages/sdk/src/events/orchestration.js';

// ---------------------------------------------------------------------------
// Recursive JSON-value arbitrary
// ---------------------------------------------------------------------------

/**
 * Generates any JSON-representable value: null, boolean, finite number,
 * string, array of values, or string-keyed object of values.
 *
 * Uses `fc.letrec` for true recursive generation — covers nested structures,
 * mixed types, and edge cases (null/bool/numeric) that bare `fc.string()` misses.
 */
const jsonNumberArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer(),
  fc
    .double({ noNaN: true, noDefaultInfinity: true })
    .filter((value) => Number.isFinite(value) && !Object.is(value, -0)),
);

export const jsonValueArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    fc.constant(null),
    fc.boolean(),
    jsonNumberArb,
    fc.string(),
    fc.array(tie('value')),
    fc.dictionary(fc.string(), tie('value')),
  ),
})).value;

// ---------------------------------------------------------------------------
// Known event type registry
// ---------------------------------------------------------------------------

/** All known AnyRuntimeEvent type literals. Derived from the domain-map source of truth. */
export const KNOWN_EVENT_TYPES = new Set<string>([
  // session
  'SESSION_STARTED', 'SESSION_LOADING', 'SESSION_RESUMED', 'SESSION_REPAIRING',
  'SESSION_RECONCILING', 'SESSION_READY', 'SESSION_RECOVERY_FAILED',
  // turn
  'TURN_SUBMITTED', 'PREFLIGHT_OK', 'PREFLIGHT_FAIL', 'STREAM_START', 'STREAM_DELTA',
  'STREAM_END', 'LLM_RESPONSE_RECEIVED', 'TOOL_BATCH_READY', 'TOOLS_DONE',
  'POST_HOOKS_DONE', 'TURN_COMPLETED', 'TURN_ERROR', 'TURN_CANCEL',
  // providers
  'PROVIDERS_CHANGED', 'PROVIDER_WARNING', 'MODEL_FALLBACK',
  // tools
  'TOOL_RECEIVED', 'TOOL_VALIDATED', 'TOOL_PREHOOKED', 'TOOL_PERMISSIONED',
  'TOOL_EXECUTING', 'TOOL_MAPPED', 'TOOL_POSTHOOKED', 'TOOL_SUCCEEDED',
  'TOOL_FAILED', 'TOOL_RECONCILED', 'TOOL_CANCELLED',
  'BUDGET_EXCEEDED_MS', 'BUDGET_EXCEEDED_TOKENS', 'BUDGET_EXCEEDED_COST',
  // tasks
  'TASK_CREATED', 'TASK_STARTED', 'TASK_BLOCKED', 'TASK_PROGRESS',
  'TASK_COMPLETED', 'TASK_FAILED', 'TASK_CANCELLED',
  // agents
  'AGENT_SPAWNING', 'AGENT_RUNNING', 'AGENT_PROGRESS', 'AGENT_STREAM_DELTA',
  'AGENT_AWAITING_MESSAGE', 'AGENT_AWAITING_TOOL', 'AGENT_FINALIZING',
  'AGENT_COMPLETED', 'AGENT_FAILED', 'AGENT_CANCELLED',
  // workflows
  'WORKFLOW_CHAIN_CREATED', 'WORKFLOW_STATE_CHANGED', 'WORKFLOW_REVIEW_COMPLETED',
  'WORKFLOW_FIX_ATTEMPTED', 'WORKFLOW_GATE_RESULT', 'WORKFLOW_CHAIN_PASSED',
  'WORKFLOW_CHAIN_FAILED', 'WORKFLOW_AUTO_COMMITTED', 'WORKFLOW_CASCADE_ABORTED',
  // orchestration
  'ORCHESTRATION_GRAPH_CREATED', 'ORCHESTRATION_NODE_ADDED', 'ORCHESTRATION_NODE_READY',
  'ORCHESTRATION_NODE_STARTED', 'ORCHESTRATION_NODE_PROGRESS', 'ORCHESTRATION_NODE_BLOCKED',
  'ORCHESTRATION_NODE_COMPLETED', 'ORCHESTRATION_NODE_FAILED', 'ORCHESTRATION_NODE_CANCELLED',
  'ORCHESTRATION_RECURSION_GUARD_TRIGGERED',
  // communication
  'COMMUNICATION_SENT', 'COMMUNICATION_DELIVERED', 'COMMUNICATION_BLOCKED',
  // planner
  'PLAN_STRATEGY_SELECTED', 'PLAN_STRATEGY_OVERRIDDEN',
  // permissions
  'PERMISSION_REQUESTED', 'RULES_COLLECTED', 'INPUT_NORMALIZED', 'POLICY_EVALUATED',
  'MODE_EVALUATED', 'SESSION_OVERRIDE_EVALUATED', 'SAFETY_CHECKED', 'DECISION_EMITTED',
  // plugins
  'PLUGIN_DISCOVERED', 'PLUGIN_LOADING', 'PLUGIN_LOADED', 'PLUGIN_ACTIVE',
  'PLUGIN_DEGRADED', 'PLUGIN_ERROR', 'PLUGIN_UNLOADING', 'PLUGIN_DISABLED',
  // mcp
  'MCP_CONFIGURED', 'MCP_CONNECTING', 'MCP_CONNECTED', 'MCP_DEGRADED',
  'MCP_AUTH_REQUIRED', 'MCP_RECONNECTING', 'MCP_DISCONNECTED',
  'MCP_SCHEMA_QUARANTINED', 'MCP_SCHEMA_QUARANTINE_APPROVED', 'MCP_POLICY_UPDATED',
  // transport
  'TRANSPORT_INITIALIZING', 'TRANSPORT_AUTHENTICATING', 'TRANSPORT_CONNECTED',
  'TRANSPORT_SYNCING', 'TRANSPORT_DEGRADED', 'TRANSPORT_RECONNECTING',
  'TRANSPORT_DISCONNECTED', 'TRANSPORT_TERMINAL_FAILURE',
  // compaction
  'COMPACTION_CHECK', 'COMPACTION_MICROCOMPACT', 'COMPACTION_COLLAPSE',
  'COMPACTION_AUTOCOMPACT', 'COMPACTION_REACTIVE', 'COMPACTION_BOUNDARY_COMMIT',
  'COMPACTION_DONE', 'COMPACTION_FAILED', 'COMPACTION_RESUME_REPAIR',
  'COMPACTION_QUALITY_SCORE', 'COMPACTION_STRATEGY_SWITCH',
  // ui
  'UI_RENDER_REQUEST', 'UI_SCROLL_DELTA', 'UI_SCROLL_TO', 'UI_BLOCK_TOGGLE_COLLAPSE',
  'UI_BLOCK_RERUN', 'UI_CLEAR_SCREEN', 'UI_PANEL_OPEN', 'UI_PANEL_CLOSE',
  'UI_PANEL_FOCUS', 'UI_VIEW_CHANGED',
  // ops
  'OPS_CONTEXT_WARNING', 'OPS_CACHE_METRICS', 'OPS_HELPER_USAGE',
  'OPS_TASK_CANCELLED', 'OPS_TASK_PAUSED', 'OPS_TASK_RESUMED',
  'OPS_TASK_RETRIED', 'OPS_AGENT_CANCELLED', 'OPS_AUDIT',
  // forensics
  'FORENSICS_REPORT_CREATED', 'FORENSICS_REPORT_EXPORTED',
  // security
  'TOKEN_SCOPE_VIOLATION', 'TOKEN_ROTATION_WARNING', 'TOKEN_ROTATION_EXPIRED', 'TOKEN_BLOCKED',
  // automation
  'AUTOMATION_JOB_CREATED', 'AUTOMATION_JOB_UPDATED', 'AUTOMATION_JOB_ENABLED',
  'AUTOMATION_JOB_DISABLED', 'AUTOMATION_RUN_QUEUED', 'AUTOMATION_RUN_STARTED',
  'AUTOMATION_RUN_COMPLETED', 'AUTOMATION_RUN_FAILED', 'AUTOMATION_RUN_CANCELLED',
  'AUTOMATION_SCHEDULE_ERROR', 'AUTOMATION_JOB_AUTO_DISABLED',
  // routes
  'ROUTE_BINDING_CREATED', 'ROUTE_BINDING_UPDATED', 'ROUTE_BINDING_REMOVED', 'ROUTE_BINDING_RESOLVED',
  'ROUTE_REPLY_TARGET_CAPTURED', 'ROUTE_BINDING_FAILED',
  // control-plane
  'CONTROL_PLANE_CLIENT_CONNECTED', 'CONTROL_PLANE_CLIENT_DISCONNECTED',
  'CONTROL_PLANE_SUBSCRIPTION_CREATED', 'CONTROL_PLANE_SUBSCRIPTION_DROPPED',
  'CONTROL_PLANE_AUTH_GRANTED', 'CONTROL_PLANE_AUTH_REJECTED',
  // deliveries
  'DELIVERY_QUEUED', 'DELIVERY_STARTED', 'DELIVERY_SUCCEEDED',
  'DELIVERY_FAILED', 'DELIVERY_DEAD_LETTERED',
  // watchers
  'WATCHER_STARTED', 'WATCHER_HEARTBEAT', 'WATCHER_CHECKPOINT_ADVANCED',
  'WATCHER_FAILED', 'WATCHER_STOPPED',
  // surfaces
  'SURFACE_ENABLED', 'SURFACE_DISABLED', 'SURFACE_ACCOUNT_CONNECTED',
  'SURFACE_ACCOUNT_DEGRADED', 'SURFACE_CAPABILITY_CHANGED',
  // knowledge
  'KNOWLEDGE_INGEST_STARTED', 'KNOWLEDGE_INGEST_COMPLETED', 'KNOWLEDGE_INGEST_FAILED',
  'KNOWLEDGE_EXTRACTION_COMPLETED', 'KNOWLEDGE_EXTRACTION_FAILED',
  'KNOWLEDGE_COMPILE_COMPLETED', 'KNOWLEDGE_LINT_COMPLETED',
  'KNOWLEDGE_PACKET_BUILT', 'KNOWLEDGE_PROJECTION_RENDERED',
  'KNOWLEDGE_PROJECTION_MATERIALIZED', 'KNOWLEDGE_JOB_QUEUED',
  'KNOWLEDGE_JOB_STARTED', 'KNOWLEDGE_JOB_COMPLETED', 'KNOWLEDGE_JOB_FAILED',
]);

// ---------------------------------------------------------------------------
// Required-field map
// ---------------------------------------------------------------------------

/**
 * Minimum required fields per event type (excludes `type` itself).
 * Fields marked optional in the source are NOT listed here.
 */
export const REQUIRED_FIELDS_BY_TYPE: Partial<Record<string, readonly string[]>> = {
  SESSION_STARTED: ['sessionId', 'profileId', 'workingDir'],
  SESSION_LOADING: ['sessionId', 'path'],
  SESSION_RESUMED: ['sessionId', 'turnCount'],
  SESSION_REPAIRING: ['sessionId', 'reason'],
  SESSION_RECONCILING: ['sessionId', 'messageCount'],
  SESSION_READY: ['sessionId'],
  SESSION_RECOVERY_FAILED: ['sessionId', 'error'],
  TURN_SUBMITTED: ['turnId', 'prompt'],
  PREFLIGHT_OK: ['turnId'],
  PREFLIGHT_FAIL: ['turnId', 'reason', 'stopReason'],
  STREAM_START: ['turnId'],
  STREAM_DELTA: ['turnId', 'content', 'accumulated'],
  STREAM_END: ['turnId'],
  LLM_RESPONSE_RECEIVED: ['turnId', 'provider', 'model', 'content', 'toolCallCount', 'inputTokens', 'outputTokens'],
  TOOL_BATCH_READY: ['turnId', 'toolCalls'],
  TOOLS_DONE: ['turnId'],
  POST_HOOKS_DONE: ['turnId'],
  TURN_COMPLETED: ['turnId', 'response', 'stopReason'],
  TURN_ERROR: ['turnId', 'error', 'stopReason'],
  TURN_CANCEL: ['turnId', 'stopReason'],
  PROVIDERS_CHANGED: ['added', 'removed', 'updated'],
  PROVIDER_WARNING: ['message'],
  MODEL_FALLBACK: ['from', 'to', 'provider'],
  TOOL_RECEIVED: ['callId', 'turnId', 'tool', 'args'],
  TOOL_VALIDATED: ['callId', 'turnId', 'tool'],
  TOOL_PREHOOKED: ['callId', 'turnId', 'tool'],
  TOOL_PERMISSIONED: ['callId', 'turnId', 'tool', 'approved'],
  TOOL_EXECUTING: ['callId', 'turnId', 'tool', 'startedAt'],
  TOOL_MAPPED: ['callId', 'turnId', 'tool'],
  TOOL_POSTHOOKED: ['callId', 'turnId', 'tool'],
  TOOL_SUCCEEDED: ['callId', 'turnId', 'tool', 'durationMs'],
  TOOL_FAILED: ['callId', 'turnId', 'tool', 'error', 'durationMs'],
  TOOL_RECONCILED: ['turnId', 'count', 'callIds', 'toolNames', 'reason', 'timestamp'],
  TOOL_CANCELLED: ['callId', 'turnId', 'tool'],
  BUDGET_EXCEEDED_MS: ['callId', 'turnId', 'tool', 'phase', 'limitMs', 'elapsedMs'],
  BUDGET_EXCEEDED_TOKENS: ['callId', 'turnId', 'tool', 'phase', 'limitTokens', 'usedTokens'],
  BUDGET_EXCEEDED_COST: ['callId', 'turnId', 'tool', 'phase', 'limitCostUsd', 'usedCostUsd'],
  TASK_CREATED: ['taskId', 'description', 'priority'],
  TASK_STARTED: ['taskId'],
  TASK_BLOCKED: ['taskId', 'reason'],
  TASK_PROGRESS: ['taskId', 'progress'],
  TASK_COMPLETED: ['taskId', 'durationMs'],
  TASK_FAILED: ['taskId', 'error', 'durationMs'],
  TASK_CANCELLED: ['taskId'],
  AGENT_SPAWNING: ['agentId', 'task'],
  AGENT_RUNNING: ['agentId'],
  AGENT_PROGRESS: ['agentId', 'progress'],
  AGENT_STREAM_DELTA: ['agentId', 'content', 'accumulated'],
  AGENT_AWAITING_MESSAGE: ['agentId'],
  AGENT_AWAITING_TOOL: ['agentId', 'callId', 'tool'],
  AGENT_FINALIZING: ['agentId'],
  AGENT_COMPLETED: ['agentId', 'durationMs'],
  AGENT_FAILED: ['agentId', 'error', 'durationMs'],
  AGENT_CANCELLED: ['agentId'],
  WORKFLOW_CHAIN_CREATED: ['chainId', 'task'],
  WORKFLOW_STATE_CHANGED: ['chainId', 'from', 'to'],
  WORKFLOW_REVIEW_COMPLETED: ['chainId', 'score', 'passed'],
  WORKFLOW_FIX_ATTEMPTED: ['chainId', 'attempt', 'maxAttempts'],
  WORKFLOW_GATE_RESULT: ['chainId', 'gate', 'passed'],
  WORKFLOW_CHAIN_PASSED: ['chainId'],
  WORKFLOW_CHAIN_FAILED: ['chainId', 'reason'],
  WORKFLOW_AUTO_COMMITTED: ['chainId'],
  WORKFLOW_CASCADE_ABORTED: ['chainId', 'reason'],
  ORCHESTRATION_GRAPH_CREATED: ['graphId', 'title', 'mode'],
  ORCHESTRATION_NODE_ADDED: ['graphId', 'nodeId', 'title', 'role'],
  ORCHESTRATION_NODE_READY: ['graphId', 'nodeId'],
  ORCHESTRATION_NODE_STARTED: ['graphId', 'nodeId'],
  ORCHESTRATION_NODE_PROGRESS: ['graphId', 'nodeId', 'message'],
  ORCHESTRATION_NODE_BLOCKED: ['graphId', 'nodeId', 'reason'],
  ORCHESTRATION_NODE_COMPLETED: ['graphId', 'nodeId'],
  ORCHESTRATION_NODE_FAILED: ['graphId', 'nodeId', 'error'],
  ORCHESTRATION_NODE_CANCELLED: ['graphId', 'nodeId'],
  ORCHESTRATION_RECURSION_GUARD_TRIGGERED: ['graphId', 'depth', 'activeAgents', 'reason'],
  COMMUNICATION_SENT: ['messageId', 'fromId', 'toId', 'scope', 'kind', 'content'],
  COMMUNICATION_DELIVERED: ['messageId', 'fromId', 'toId', 'scope', 'kind'],
  COMMUNICATION_BLOCKED: ['messageId', 'fromId', 'toId', 'scope', 'kind', 'reason'],
  PERMISSION_REQUESTED: ['callId', 'tool', 'args', 'category'],
  RULES_COLLECTED: ['callId', 'tool', 'ruleCount'],
  INPUT_NORMALIZED: ['callId', 'tool'],
  POLICY_EVALUATED: ['callId', 'tool', 'result'],
  MODE_EVALUATED: ['callId', 'tool', 'mode', 'result'],
  SESSION_OVERRIDE_EVALUATED: ['callId', 'tool', 'overrideApplied'],
  SAFETY_CHECKED: ['callId', 'tool', 'safe', 'warnings'],
  DECISION_EMITTED: ['callId', 'tool', 'approved', 'source'],
  PLUGIN_DISCOVERED: ['pluginId', 'path', 'version'],
  PLUGIN_LOADING: ['pluginId', 'path'],
  PLUGIN_LOADED: ['pluginId', 'version', 'capabilities'],
  PLUGIN_ACTIVE: ['pluginId'],
  PLUGIN_DEGRADED: ['pluginId', 'reason', 'affectedCapabilities'],
  PLUGIN_ERROR: ['pluginId', 'error', 'fatal'],
  PLUGIN_UNLOADING: ['pluginId'],
  PLUGIN_DISABLED: ['pluginId', 'reason'],
  MCP_CONFIGURED: ['serverId', 'transport'],
  MCP_CONNECTING: ['serverId'],
  MCP_CONNECTED: ['serverId', 'toolCount', 'resourceCount'],
  MCP_DEGRADED: ['serverId', 'reason', 'availableTools'],
  MCP_AUTH_REQUIRED: ['serverId', 'authType'],
  MCP_RECONNECTING: ['serverId', 'attempt', 'maxAttempts'],
  MCP_DISCONNECTED: ['serverId', 'willRetry'],
  MCP_SCHEMA_QUARANTINED: ['serverId', 'reason'],
  MCP_SCHEMA_QUARANTINE_APPROVED: ['serverId', 'operatorId'],
  MCP_POLICY_UPDATED: ['serverId', 'role', 'trustMode', 'allowedPaths', 'allowedHosts'],
  TRANSPORT_INITIALIZING: ['transportId', 'protocol'],
  TRANSPORT_AUTHENTICATING: ['transportId'],
  TRANSPORT_CONNECTED: ['transportId', 'endpoint'],
  TRANSPORT_SYNCING: ['transportId'],
  TRANSPORT_DEGRADED: ['transportId', 'reason'],
  TRANSPORT_RECONNECTING: ['transportId', 'attempt', 'maxAttempts'],
  TRANSPORT_DISCONNECTED: ['transportId', 'willRetry'],
  TRANSPORT_TERMINAL_FAILURE: ['transportId', 'error'],
  COMPACTION_CHECK: ['sessionId', 'tokenCount', 'threshold'],
  COMPACTION_MICROCOMPACT: ['sessionId', 'turnCount', 'tokensBefore', 'tokensAfter'],
  COMPACTION_COLLAPSE: ['sessionId', 'messageCount', 'tokensBefore', 'tokensAfter'],
  COMPACTION_AUTOCOMPACT: ['sessionId', 'strategy', 'tokensBefore', 'tokensAfter'],
  COMPACTION_REACTIVE: ['sessionId', 'tokenCount', 'limit'],
  COMPACTION_BOUNDARY_COMMIT: ['sessionId', 'checkpointId'],
  COMPACTION_DONE: ['sessionId', 'strategy', 'tokensBefore', 'tokensAfter', 'durationMs'],
  COMPACTION_FAILED: ['sessionId', 'strategy', 'error'],
  COMPACTION_RESUME_REPAIR: ['sessionId', 'repaired', 'actionsCount', 'safeToResume'],
  COMPACTION_QUALITY_SCORE: ['sessionId', 'strategy', 'score', 'grade', 'compressionRatio', 'retentionScore', 'isLowQuality', 'description'],
  COMPACTION_STRATEGY_SWITCH: ['sessionId', 'fromStrategy', 'toStrategy', 'reason', 'score'],
  UI_RENDER_REQUEST: [],
  UI_SCROLL_DELTA: ['delta'],
  UI_SCROLL_TO: ['line'],
  UI_BLOCK_TOGGLE_COLLAPSE: ['blockIndex'],
  UI_BLOCK_RERUN: ['blockIndex', 'content'],
  UI_CLEAR_SCREEN: [],
  UI_PANEL_OPEN: ['panelId'],
  UI_PANEL_CLOSE: ['panelId'],
  UI_PANEL_FOCUS: ['panelId'],
  UI_VIEW_CHANGED: ['from', 'to'],
  OPS_CONTEXT_WARNING: ['usage', 'threshold'],
  OPS_CACHE_METRICS: ['hitRate', 'cacheReadTokens', 'cacheWriteTokens', 'totalInputTokens', 'turns'],
  OPS_HELPER_USAGE: ['inputTokens', 'outputTokens', 'calls'],
  OPS_TASK_CANCELLED: ['taskId', 'reason'],
  OPS_TASK_PAUSED: ['taskId', 'reason'],
  OPS_TASK_RESUMED: ['taskId', 'reason'],
  OPS_TASK_RETRIED: ['taskId', 'reason'],
  OPS_AGENT_CANCELLED: ['agentId', 'reason'],
  OPS_AUDIT: ['action', 'targetId', 'targetKind', 'reason', 'outcome'],
  FORENSICS_REPORT_CREATED: ['reportId', 'classification'],
  FORENSICS_REPORT_EXPORTED: ['reportId', 'destination'],
  TOKEN_SCOPE_VIOLATION: ['tokenId', 'label', 'policyId', 'excessScopes'],
  TOKEN_ROTATION_WARNING: ['tokenId', 'label', 'msUntilDue', 'dueAt', 'ageMs'],
  TOKEN_ROTATION_EXPIRED: ['tokenId', 'label', 'ageMs', 'cadenceMs', 'dueAt'],
  TOKEN_BLOCKED: ['tokenId', 'label', 'reason'],
  AUTOMATION_JOB_CREATED: ['jobId', 'name', 'scheduleKind', 'enabled'],
  AUTOMATION_JOB_UPDATED: ['jobId', 'changedFields'],
  AUTOMATION_JOB_ENABLED: ['jobId'],
  AUTOMATION_JOB_DISABLED: ['jobId', 'reason'],
  AUTOMATION_RUN_QUEUED: ['jobId', 'runId', 'scheduledAt', 'forced'],
  AUTOMATION_RUN_STARTED: ['jobId', 'runId', 'startedAt', 'attempt'],
  AUTOMATION_RUN_COMPLETED: ['jobId', 'runId', 'startedAt', 'completedAt', 'durationMs', 'outcome'],
  AUTOMATION_RUN_FAILED: ['jobId', 'runId', 'startedAt', 'failedAt', 'error', 'retryable'],
  AUTOMATION_RUN_CANCELLED: ['jobId', 'runId', 'cancelledAt', 'reason'],
  AUTOMATION_SCHEDULE_ERROR: ['jobId', 'scheduleText', 'error'],
  AUTOMATION_JOB_AUTO_DISABLED: ['jobId', 'reason', 'consecutiveFailures'],
  ROUTE_BINDING_CREATED: ['bindingId', 'surfaceKind', 'externalId', 'targetKind', 'targetId'],
  ROUTE_BINDING_UPDATED: ['bindingId', 'changedFields'],
  ROUTE_BINDING_REMOVED: ['bindingId', 'surfaceKind', 'externalId'],
  ROUTE_BINDING_RESOLVED: ['bindingId', 'surfaceKind', 'externalId', 'targetKind', 'targetId'],
  ROUTE_REPLY_TARGET_CAPTURED: ['bindingId', 'surfaceKind', 'externalId', 'replyTargetId', 'threadId'],
  ROUTE_BINDING_FAILED: ['surfaceKind', 'externalId', 'error'],
  CONTROL_PLANE_CLIENT_CONNECTED: ['clientId', 'clientKind', 'transport'],
  CONTROL_PLANE_CLIENT_DISCONNECTED: ['clientId', 'reason'],
  CONTROL_PLANE_SUBSCRIPTION_CREATED: ['clientId', 'subscriptionId', 'topics'],
  CONTROL_PLANE_SUBSCRIPTION_DROPPED: ['clientId', 'subscriptionId', 'reason'],
  CONTROL_PLANE_AUTH_GRANTED: ['clientId', 'principalId', 'principalKind', 'scopes'],
  CONTROL_PLANE_AUTH_REJECTED: ['clientId', 'principalId', 'reason'],
  DELIVERY_QUEUED: ['deliveryId', 'jobId', 'runId', 'surfaceKind', 'targetId', 'deliveryKind'],
  DELIVERY_STARTED: ['deliveryId', 'jobId', 'runId', 'surfaceKind', 'targetId', 'startedAt'],
  DELIVERY_SUCCEEDED: ['deliveryId', 'jobId', 'runId', 'surfaceKind', 'targetId', 'completedAt', 'durationMs', 'statusCode'],
  DELIVERY_FAILED: ['deliveryId', 'jobId', 'runId', 'surfaceKind', 'targetId', 'failedAt', 'error', 'retryable'],
  DELIVERY_DEAD_LETTERED: ['deliveryId', 'jobId', 'runId', 'surfaceKind', 'targetId', 'reason', 'attempts'],
  WATCHER_STARTED: ['watcherId', 'sourceKind', 'name'],
  WATCHER_HEARTBEAT: ['watcherId', 'sourceKind', 'seenAt', 'checkpoint'],
  WATCHER_CHECKPOINT_ADVANCED: ['watcherId', 'sourceKind', 'checkpoint'],
  WATCHER_FAILED: ['watcherId', 'sourceKind', 'error', 'retryable'],
  WATCHER_STOPPED: ['watcherId', 'sourceKind', 'reason'],
  SURFACE_ENABLED: ['surfaceKind', 'surfaceId', 'accountId'],
  SURFACE_DISABLED: ['surfaceKind', 'surfaceId', 'reason'],
  SURFACE_ACCOUNT_CONNECTED: ['surfaceKind', 'surfaceId', 'accountId', 'displayName'],
  SURFACE_ACCOUNT_DEGRADED: ['surfaceKind', 'surfaceId', 'accountId', 'error'],
  SURFACE_CAPABILITY_CHANGED: ['surfaceKind', 'surfaceId', 'capability', 'enabled'],
  KNOWLEDGE_INGEST_STARTED: ['sourceId', 'connectorId', 'sourceType'],
  KNOWLEDGE_INGEST_COMPLETED: ['sourceId', 'status'],
  KNOWLEDGE_INGEST_FAILED: ['sourceId', 'error'],
  KNOWLEDGE_EXTRACTION_COMPLETED: ['sourceId', 'extractionId', 'format', 'estimatedTokens'],
  KNOWLEDGE_EXTRACTION_FAILED: ['sourceId', 'error'],
  KNOWLEDGE_COMPILE_COMPLETED: ['sourceId', 'nodeCount', 'edgeCount'],
  KNOWLEDGE_LINT_COMPLETED: ['issueCount'],
  KNOWLEDGE_PACKET_BUILT: ['task', 'itemCount', 'estimatedTokens', 'detail'],
  KNOWLEDGE_PROJECTION_RENDERED: ['targetId', 'pageCount'],
  KNOWLEDGE_PROJECTION_MATERIALIZED: ['targetId', 'artifactId', 'pageCount'],
  KNOWLEDGE_JOB_QUEUED: ['jobId', 'runId', 'mode'],
  KNOWLEDGE_JOB_STARTED: ['jobId', 'runId', 'mode'],
  KNOWLEDGE_JOB_COMPLETED: ['jobId', 'runId', 'durationMs'],
  KNOWLEDGE_JOB_FAILED: ['jobId', 'runId', 'error', 'durationMs'],
};

// ---------------------------------------------------------------------------
// Fixture events: one canonical instance per event kind
// ---------------------------------------------------------------------------

/** All known event kinds, each with a minimal valid instance. */
export const FIXTURE_EVENTS: ReadonlyArray<{ type: string } & Record<string, unknown>> = [
  // session
  { type: 'SESSION_STARTED', sessionId: 's1', profileId: 'p1', workingDir: '/home' } satisfies SessionEvent,
  { type: 'SESSION_LOADING', sessionId: 's1', path: '/tmp/sess.json' } satisfies SessionEvent,
  { type: 'SESSION_RESUMED', sessionId: 's1', turnCount: 3 } satisfies SessionEvent,
  { type: 'SESSION_REPAIRING', sessionId: 's1', reason: 'conflict' } satisfies SessionEvent,
  { type: 'SESSION_RECONCILING', sessionId: 's1', messageCount: 10 } satisfies SessionEvent,
  { type: 'SESSION_READY', sessionId: 's1' } satisfies SessionEvent,
  { type: 'SESSION_RECOVERY_FAILED', sessionId: 's1', error: 'disk full' } satisfies SessionEvent,
  // turn
  { type: 'TURN_SUBMITTED', turnId: 't1', prompt: 'hello' } satisfies TurnEvent,
  { type: 'PREFLIGHT_OK', turnId: 't1' } satisfies TurnEvent,
  { type: 'PREFLIGHT_FAIL', turnId: 't1', reason: 'context overflow', stopReason: 'context_overflow' } satisfies TurnEvent,
  { type: 'STREAM_START', turnId: 't1' } satisfies TurnEvent,
  { type: 'STREAM_DELTA', turnId: 't1', content: 'hi', accumulated: 'hi' } satisfies TurnEvent,
  { type: 'STREAM_END', turnId: 't1' } satisfies TurnEvent,
  { type: 'LLM_RESPONSE_RECEIVED', turnId: 't1', provider: 'anthropic', model: 'claude-4', content: 'hi', toolCallCount: 0, inputTokens: 10, outputTokens: 5 } satisfies TurnEvent,
  { type: 'TOOL_BATCH_READY', turnId: 't1', toolCalls: ['bash'] } satisfies TurnEvent,
  { type: 'TOOLS_DONE', turnId: 't1' } satisfies TurnEvent,
  { type: 'POST_HOOKS_DONE', turnId: 't1' } satisfies TurnEvent,
  { type: 'TURN_COMPLETED', turnId: 't1', response: 'done', stopReason: 'completed' } satisfies TurnEvent,
  { type: 'TURN_ERROR', turnId: 't1', error: 'fail', stopReason: 'provider_error' } satisfies TurnEvent,
  { type: 'TURN_CANCEL', turnId: 't1', stopReason: 'cancelled' } satisfies TurnEvent,
  // providers
  { type: 'PROVIDERS_CHANGED', added: ['anthropic'], removed: [], updated: [] } satisfies ProviderEvent,
  { type: 'PROVIDER_WARNING', message: 'model retired' } satisfies ProviderEvent,
  { type: 'MODEL_FALLBACK', from: 'claude-4', to: 'claude-3', provider: 'anthropic' } satisfies ProviderEvent,
  // tools
  { type: 'TOOL_RECEIVED', callId: 'c1', turnId: 't1', tool: 'bash', args: { cmd: 'ls' } } satisfies ToolEvent,
  { type: 'TOOL_VALIDATED', callId: 'c1', turnId: 't1', tool: 'bash' } satisfies ToolEvent,
  { type: 'TOOL_PREHOOKED', callId: 'c1', turnId: 't1', tool: 'bash' } satisfies ToolEvent,
  { type: 'TOOL_PERMISSIONED', callId: 'c1', turnId: 't1', tool: 'bash', approved: true } satisfies ToolEvent,
  { type: 'TOOL_EXECUTING', callId: 'c1', turnId: 't1', tool: 'bash', startedAt: 1000 } satisfies ToolEvent,
  { type: 'TOOL_MAPPED', callId: 'c1', turnId: 't1', tool: 'bash' } satisfies ToolEvent,
  { type: 'TOOL_POSTHOOKED', callId: 'c1', turnId: 't1', tool: 'bash' } satisfies ToolEvent,
  { type: 'TOOL_SUCCEEDED', callId: 'c1', turnId: 't1', tool: 'bash', durationMs: 50 } satisfies ToolEvent,
  { type: 'TOOL_FAILED', callId: 'c1', turnId: 't1', tool: 'bash', error: 'timeout', durationMs: 100 } satisfies ToolEvent,
  { type: 'TOOL_RECONCILED', turnId: 't1', count: 1, callIds: ['c1'], toolNames: ['bash'], reason: 'timeout', timestamp: Date.now() } satisfies ToolEvent,
  { type: 'TOOL_CANCELLED', callId: 'c1', turnId: 't1', tool: 'bash' } satisfies ToolEvent,
  { type: 'BUDGET_EXCEEDED_MS', callId: 'c1', turnId: 't1', tool: 'bash', phase: 'execute', limitMs: 5000, elapsedMs: 5001 } satisfies ToolEvent,
  { type: 'BUDGET_EXCEEDED_TOKENS', callId: 'c1', turnId: 't1', tool: 'bash', phase: 'execute', limitTokens: 1000, usedTokens: 1001 } satisfies ToolEvent,
  { type: 'BUDGET_EXCEEDED_COST', callId: 'c1', turnId: 't1', tool: 'bash', phase: 'execute', limitCostUsd: 0.01, usedCostUsd: 0.02 } satisfies ToolEvent,
  // tasks
  { type: 'TASK_CREATED', taskId: 'task1', description: 'build feature', priority: 1 } satisfies TaskEvent,
  { type: 'TASK_STARTED', taskId: 'task1' } satisfies TaskEvent,
  { type: 'TASK_BLOCKED', taskId: 'task1', reason: 'waiting' } satisfies TaskEvent,
  { type: 'TASK_PROGRESS', taskId: 'task1', progress: 50 } satisfies TaskEvent,
  { type: 'TASK_COMPLETED', taskId: 'task1', durationMs: 200 } satisfies TaskEvent,
  { type: 'TASK_FAILED', taskId: 'task1', error: 'exception', durationMs: 100 } satisfies TaskEvent,
  { type: 'TASK_CANCELLED', taskId: 'task1' } satisfies TaskEvent,
  // agents
  { type: 'AGENT_SPAWNING', agentId: 'a1', task: 'implement feature' } satisfies AgentEvent,
  { type: 'AGENT_RUNNING', agentId: 'a1' } satisfies AgentEvent,
  { type: 'AGENT_PROGRESS', agentId: 'a1', progress: '50%' } satisfies AgentEvent,
  { type: 'AGENT_STREAM_DELTA', agentId: 'a1', content: 'hi', accumulated: 'hi' } satisfies AgentEvent,
  { type: 'AGENT_AWAITING_MESSAGE', agentId: 'a1' } satisfies AgentEvent,
  { type: 'AGENT_AWAITING_TOOL', agentId: 'a1', callId: 'c1', tool: 'bash' } satisfies AgentEvent,
  { type: 'AGENT_FINALIZING', agentId: 'a1' } satisfies AgentEvent,
  { type: 'AGENT_COMPLETED', agentId: 'a1', durationMs: 500 } satisfies AgentEvent,
  { type: 'AGENT_FAILED', agentId: 'a1', error: 'timeout', durationMs: 100 } satisfies AgentEvent,
  { type: 'AGENT_CANCELLED', agentId: 'a1' } satisfies AgentEvent,
  // workflows
  { type: 'WORKFLOW_CHAIN_CREATED', chainId: 'ch1', task: 'implement' } satisfies WorkflowEvent,
  { type: 'WORKFLOW_STATE_CHANGED', chainId: 'ch1', from: 'engineering', to: 'reviewing' } satisfies WorkflowEvent,
  { type: 'WORKFLOW_REVIEW_COMPLETED', chainId: 'ch1', score: 9, passed: true } satisfies WorkflowEvent,
  { type: 'WORKFLOW_FIX_ATTEMPTED', chainId: 'ch1', attempt: 1, maxAttempts: 3 } satisfies WorkflowEvent,
  { type: 'WORKFLOW_GATE_RESULT', chainId: 'ch1', gate: 'typecheck', passed: true } satisfies WorkflowEvent,
  { type: 'WORKFLOW_CHAIN_PASSED', chainId: 'ch1' } satisfies WorkflowEvent,
  { type: 'WORKFLOW_CHAIN_FAILED', chainId: 'ch1', reason: 'max retries' } satisfies WorkflowEvent,
  { type: 'WORKFLOW_AUTO_COMMITTED', chainId: 'ch1' } satisfies WorkflowEvent,
  { type: 'WORKFLOW_CASCADE_ABORTED', chainId: 'ch1', reason: 'user cancelled' } satisfies WorkflowEvent,
  // orchestration
  { type: 'ORCHESTRATION_GRAPH_CREATED', graphId: 'g1', title: 'plan', mode: 'parallel-workers' } satisfies OrchestrationEvent,
  { type: 'ORCHESTRATION_NODE_ADDED', graphId: 'g1', nodeId: 'n1', title: 'engineer', role: 'engineer' } satisfies OrchestrationEvent,
  { type: 'ORCHESTRATION_NODE_READY', graphId: 'g1', nodeId: 'n1' } satisfies OrchestrationEvent,
  { type: 'ORCHESTRATION_NODE_STARTED', graphId: 'g1', nodeId: 'n1' } satisfies OrchestrationEvent,
  { type: 'ORCHESTRATION_NODE_PROGRESS', graphId: 'g1', nodeId: 'n1', message: 'halfway' } satisfies OrchestrationEvent,
  { type: 'ORCHESTRATION_NODE_BLOCKED', graphId: 'g1', nodeId: 'n1', reason: 'dep' } satisfies OrchestrationEvent,
  { type: 'ORCHESTRATION_NODE_COMPLETED', graphId: 'g1', nodeId: 'n1' } satisfies OrchestrationEvent,
  { type: 'ORCHESTRATION_NODE_FAILED', graphId: 'g1', nodeId: 'n1', error: 'err' } satisfies OrchestrationEvent,
  { type: 'ORCHESTRATION_NODE_CANCELLED', graphId: 'g1', nodeId: 'n1' } satisfies OrchestrationEvent,
  { type: 'ORCHESTRATION_RECURSION_GUARD_TRIGGERED', graphId: 'g1', depth: 5, activeAgents: 3, reason: 'depth exceeded' } satisfies OrchestrationEvent,
  // communication
  { type: 'COMMUNICATION_SENT', messageId: 'm1', fromId: 'a1', toId: 'a2', scope: 'direct', kind: 'directive', content: 'do it' } satisfies CommunicationEvent,
  { type: 'COMMUNICATION_DELIVERED', messageId: 'm1', fromId: 'a1', toId: 'a2', scope: 'direct', kind: 'directive' } satisfies CommunicationEvent,
  { type: 'COMMUNICATION_BLOCKED', messageId: 'm1', fromId: 'a1', toId: 'a2', scope: 'direct', kind: 'directive', reason: 'policy' } satisfies CommunicationEvent,
  // permissions
  { type: 'PERMISSION_REQUESTED', callId: 'c1', tool: 'bash', args: {}, category: 'exec' } satisfies PermissionEvent,
  { type: 'RULES_COLLECTED', callId: 'c1', tool: 'bash', ruleCount: 3 } satisfies PermissionEvent,
  { type: 'INPUT_NORMALIZED', callId: 'c1', tool: 'bash' } satisfies PermissionEvent,
  { type: 'POLICY_EVALUATED', callId: 'c1', tool: 'bash', result: 'allow' } satisfies PermissionEvent,
  { type: 'MODE_EVALUATED', callId: 'c1', tool: 'bash', mode: 'yolo', result: 'allow' } satisfies PermissionEvent,
  { type: 'SESSION_OVERRIDE_EVALUATED', callId: 'c1', tool: 'bash', overrideApplied: true } satisfies PermissionEvent,
  { type: 'SAFETY_CHECKED', callId: 'c1', tool: 'bash', safe: true, warnings: [] } satisfies PermissionEvent,
  { type: 'DECISION_EMITTED', callId: 'c1', tool: 'bash', approved: true, source: 'policy' } satisfies PermissionEvent,
  // plugins
  { type: 'PLUGIN_DISCOVERED', pluginId: 'p1', path: '/plugins/p1', version: '1.0.0' } satisfies PluginEvent,
  { type: 'PLUGIN_LOADING', pluginId: 'p1', path: '/plugins/p1' } satisfies PluginEvent,
  { type: 'PLUGIN_LOADED', pluginId: 'p1', version: '1.0.0', capabilities: ['tool'] } satisfies PluginEvent,
  { type: 'PLUGIN_ACTIVE', pluginId: 'p1' } satisfies PluginEvent,
  { type: 'PLUGIN_DEGRADED', pluginId: 'p1', reason: 'error', affectedCapabilities: [] } satisfies PluginEvent,
  { type: 'PLUGIN_ERROR', pluginId: 'p1', error: 'crash', fatal: false } satisfies PluginEvent,
  { type: 'PLUGIN_UNLOADING', pluginId: 'p1' } satisfies PluginEvent,
  { type: 'PLUGIN_DISABLED', pluginId: 'p1', reason: 'error' } satisfies PluginEvent,
  // mcp
  { type: 'MCP_CONFIGURED', serverId: 'mcp1', transport: 'stdio' } satisfies McpEvent,
  { type: 'MCP_CONNECTING', serverId: 'mcp1' } satisfies McpEvent,
  { type: 'MCP_CONNECTED', serverId: 'mcp1', toolCount: 5, resourceCount: 2 } satisfies McpEvent,
  { type: 'MCP_DEGRADED', serverId: 'mcp1', reason: 'partial', availableTools: ['bash'] } satisfies McpEvent,
  { type: 'MCP_AUTH_REQUIRED', serverId: 'mcp1', authType: 'oauth' } satisfies McpEvent,
  { type: 'MCP_RECONNECTING', serverId: 'mcp1', attempt: 1, maxAttempts: 5 } satisfies McpEvent,
  { type: 'MCP_DISCONNECTED', serverId: 'mcp1', willRetry: true } satisfies McpEvent,
  { type: 'MCP_SCHEMA_QUARANTINED', serverId: 'mcp1', reason: 'hash_mismatch' } satisfies McpEvent,
  { type: 'MCP_SCHEMA_QUARANTINE_APPROVED', serverId: 'mcp1', operatorId: 'op1' } satisfies McpEvent,
  { type: 'MCP_POLICY_UPDATED', serverId: 'mcp1', role: 'readonly', trustMode: 'prompt', allowedPaths: [], allowedHosts: [] } satisfies McpEvent,
  // transport
  { type: 'TRANSPORT_INITIALIZING', transportId: 'tr1', protocol: 'sse' } satisfies TransportEvent,
  { type: 'TRANSPORT_AUTHENTICATING', transportId: 'tr1' } satisfies TransportEvent,
  { type: 'TRANSPORT_CONNECTED', transportId: 'tr1', endpoint: 'http://localhost:8080' } satisfies TransportEvent,
  { type: 'TRANSPORT_SYNCING', transportId: 'tr1' } satisfies TransportEvent,
  { type: 'TRANSPORT_DEGRADED', transportId: 'tr1', reason: 'packet loss' } satisfies TransportEvent,
  { type: 'TRANSPORT_RECONNECTING', transportId: 'tr1', attempt: 1, maxAttempts: 5 } satisfies TransportEvent,
  { type: 'TRANSPORT_DISCONNECTED', transportId: 'tr1', willRetry: true } satisfies TransportEvent,
  { type: 'TRANSPORT_TERMINAL_FAILURE', transportId: 'tr1', error: 'refused' } satisfies TransportEvent,
  // compaction
  { type: 'COMPACTION_CHECK', sessionId: 's1', tokenCount: 1000, threshold: 5000 } satisfies CompactionEvent,
  { type: 'COMPACTION_MICROCOMPACT', sessionId: 's1', turnCount: 5, tokensBefore: 1000, tokensAfter: 500 } satisfies CompactionEvent,
  { type: 'COMPACTION_COLLAPSE', sessionId: 's1', messageCount: 20, tokensBefore: 2000, tokensAfter: 500 } satisfies CompactionEvent,
  { type: 'COMPACTION_AUTOCOMPACT', sessionId: 's1', strategy: 'collapse', tokensBefore: 2000, tokensAfter: 500 } satisfies CompactionEvent,
  { type: 'COMPACTION_REACTIVE', sessionId: 's1', tokenCount: 9000, limit: 8192 } satisfies CompactionEvent,
  { type: 'COMPACTION_BOUNDARY_COMMIT', sessionId: 's1', checkpointId: 'cp1' } satisfies CompactionEvent,
  { type: 'COMPACTION_DONE', sessionId: 's1', strategy: 'collapse', tokensBefore: 2000, tokensAfter: 500, durationMs: 50 } satisfies CompactionEvent,
  { type: 'COMPACTION_FAILED', sessionId: 's1', strategy: 'collapse', error: 'oom' } satisfies CompactionEvent,
  { type: 'COMPACTION_RESUME_REPAIR', sessionId: 's1', repaired: true, actionsCount: 3, safeToResume: true } satisfies CompactionEvent,
  { type: 'COMPACTION_QUALITY_SCORE', sessionId: 's1', strategy: 'collapse', score: 0.9, grade: 'A', compressionRatio: 0.5, retentionScore: 0.95, isLowQuality: false, description: 'excellent' } satisfies CompactionEvent,
  { type: 'COMPACTION_STRATEGY_SWITCH', sessionId: 's1', fromStrategy: 'collapse', toStrategy: 'microcompact', reason: 'low quality', score: 0.3 } satisfies CompactionEvent,
  // ui
  { type: 'UI_RENDER_REQUEST' } satisfies UIEvent,
  { type: 'UI_SCROLL_DELTA', delta: 5 } satisfies UIEvent,
  { type: 'UI_SCROLL_TO', line: 100 } satisfies UIEvent,
  { type: 'UI_BLOCK_TOGGLE_COLLAPSE', blockIndex: 2 } satisfies UIEvent,
  { type: 'UI_BLOCK_RERUN', blockIndex: 2, content: 'ls -la' } satisfies UIEvent,
  { type: 'UI_CLEAR_SCREEN' } satisfies UIEvent,
  { type: 'UI_PANEL_OPEN', panelId: 'tools' } satisfies UIEvent,
  { type: 'UI_PANEL_CLOSE', panelId: 'tools' } satisfies UIEvent,
  { type: 'UI_PANEL_FOCUS', panelId: 'tools' } satisfies UIEvent,
  { type: 'UI_VIEW_CHANGED', from: 'chat', to: 'search' } satisfies UIEvent,
  // ops
  { type: 'OPS_CONTEXT_WARNING', usage: 0.9, threshold: 0.8 } satisfies OpsEvent,
  { type: 'OPS_CACHE_METRICS', hitRate: 0.7, cacheReadTokens: 100, cacheWriteTokens: 50, totalInputTokens: 200, turns: 5 } satisfies OpsEvent,
  { type: 'OPS_HELPER_USAGE', inputTokens: 100, outputTokens: 50, calls: 3 } satisfies OpsEvent,
  { type: 'OPS_TASK_CANCELLED', taskId: 'task1', reason: 'user_requested' } satisfies OpsEvent,
  { type: 'OPS_TASK_PAUSED', taskId: 'task1', reason: 'ops_pause' } satisfies OpsEvent,
  { type: 'OPS_TASK_RESUMED', taskId: 'task1', reason: 'ops_resume' } satisfies OpsEvent,
  { type: 'OPS_TASK_RETRIED', taskId: 'task1', reason: 'ops_retry' } satisfies OpsEvent,
  { type: 'OPS_AGENT_CANCELLED', agentId: 'a1', reason: 'ops_agent_cancel' } satisfies OpsEvent,
  { type: 'OPS_AUDIT', action: 'cancel', targetId: 'task1', targetKind: 'task', reason: 'user_requested', outcome: 'success' } satisfies OpsEvent,
  // forensics
  { type: 'FORENSICS_REPORT_CREATED', reportId: 'r1', classification: 'tool_failure' } satisfies ForensicsEvent,
  { type: 'FORENSICS_REPORT_EXPORTED', reportId: 'r1', destination: 'stdout' } satisfies ForensicsEvent,
  // security
  { type: 'TOKEN_SCOPE_VIOLATION', tokenId: 'tok1', label: 'my-token', policyId: 'pol1', excessScopes: ['write'] } satisfies SecurityEvent,
  { type: 'TOKEN_ROTATION_WARNING', tokenId: 'tok1', label: 'my-token', msUntilDue: 3600000, dueAt: Date.now() + 3600000, ageMs: 86400000 } satisfies SecurityEvent,
  { type: 'TOKEN_ROTATION_EXPIRED', tokenId: 'tok1', label: 'my-token', ageMs: 90000000, cadenceMs: 86400000, dueAt: Date.now() - 3600000 } satisfies SecurityEvent,
  { type: 'TOKEN_BLOCKED', tokenId: 'tok1', label: 'my-token', reason: 'scope_violation' } satisfies SecurityEvent,
  // automation
  { type: 'AUTOMATION_JOB_CREATED', jobId: 'j1', name: 'daily-sync', scheduleKind: 'cron', enabled: true } satisfies AutomationEvent,
  { type: 'AUTOMATION_JOB_UPDATED', jobId: 'j1', changedFields: ['name'] } satisfies AutomationEvent,
  { type: 'AUTOMATION_JOB_ENABLED', jobId: 'j1' } satisfies AutomationEvent,
  { type: 'AUTOMATION_JOB_DISABLED', jobId: 'j1', reason: 'error' } satisfies AutomationEvent,
  { type: 'AUTOMATION_RUN_QUEUED', jobId: 'j1', runId: 'r1', scheduledAt: Date.now(), forced: false } satisfies AutomationEvent,
  { type: 'AUTOMATION_RUN_STARTED', jobId: 'j1', runId: 'r1', startedAt: Date.now(), attempt: 1 } satisfies AutomationEvent,
  { type: 'AUTOMATION_RUN_COMPLETED', jobId: 'j1', runId: 'r1', startedAt: Date.now() - 100, completedAt: Date.now(), durationMs: 100, outcome: 'success' } satisfies AutomationEvent,
  { type: 'AUTOMATION_RUN_FAILED', jobId: 'j1', runId: 'r1', startedAt: Date.now() - 100, failedAt: Date.now(), error: 'crash', retryable: true } satisfies AutomationEvent,
  { type: 'AUTOMATION_RUN_CANCELLED', jobId: 'j1', runId: 'r1', cancelledAt: Date.now(), reason: 'user' } satisfies AutomationEvent,
  { type: 'AUTOMATION_SCHEDULE_ERROR', jobId: 'j1', scheduleText: 'bad cron', error: 'invalid' } satisfies AutomationEvent,
  { type: 'AUTOMATION_JOB_AUTO_DISABLED', jobId: 'j1', reason: 'consecutive failures', consecutiveFailures: 5 } satisfies AutomationEvent,
  // routes
  { type: 'ROUTE_BINDING_CREATED', bindingId: 'b1', surfaceKind: 'slack', externalId: 'C123', targetKind: 'session', targetId: 's1' } satisfies RouteEvent,
  { type: 'ROUTE_BINDING_UPDATED', bindingId: 'b1', changedFields: ['targetId'] } satisfies RouteEvent,
  { type: 'ROUTE_BINDING_REMOVED', bindingId: 'b1', surfaceKind: 'slack', externalId: 'C123' } satisfies RouteEvent,
  { type: 'ROUTE_BINDING_RESOLVED', bindingId: 'b1', surfaceKind: 'slack', externalId: 'C123', targetKind: 'session', targetId: 's1' } satisfies RouteEvent,
  { type: 'ROUTE_REPLY_TARGET_CAPTURED', bindingId: 'b1', surfaceKind: 'slack', externalId: 'C123', replyTargetId: 'msg1', threadId: 'th1' } satisfies RouteEvent,
  { type: 'ROUTE_BINDING_FAILED', surfaceKind: 'slack', externalId: 'C123', error: 'not found' } satisfies RouteEvent,
  // control-plane
  { type: 'CONTROL_PLANE_CLIENT_CONNECTED', clientId: 'cl1', clientKind: 'tui', transport: 'sse' } satisfies ControlPlaneEvent,
  { type: 'CONTROL_PLANE_CLIENT_DISCONNECTED', clientId: 'cl1', reason: 'timeout' } satisfies ControlPlaneEvent,
  { type: 'CONTROL_PLANE_SUBSCRIPTION_CREATED', clientId: 'cl1', subscriptionId: 'sub1', topics: ['turn'] } satisfies ControlPlaneEvent,
  { type: 'CONTROL_PLANE_SUBSCRIPTION_DROPPED', clientId: 'cl1', subscriptionId: 'sub1', reason: 'disconnect' } satisfies ControlPlaneEvent,
  { type: 'CONTROL_PLANE_AUTH_GRANTED', clientId: 'cl1', principalId: 'user1', principalKind: 'user', scopes: ['read'] } satisfies ControlPlaneEvent,
  { type: 'CONTROL_PLANE_AUTH_REJECTED', clientId: 'cl1', principalId: 'user1', reason: 'bad token' } satisfies ControlPlaneEvent,
  // deliveries
  { type: 'DELIVERY_QUEUED', deliveryId: 'd1', jobId: 'j1', runId: 'r1', surfaceKind: 'slack', targetId: 't1', deliveryKind: 'notification' } satisfies DeliveryEvent,
  { type: 'DELIVERY_STARTED', deliveryId: 'd1', jobId: 'j1', runId: 'r1', surfaceKind: 'slack', targetId: 't1', startedAt: Date.now() } satisfies DeliveryEvent,
  { type: 'DELIVERY_SUCCEEDED', deliveryId: 'd1', jobId: 'j1', runId: 'r1', surfaceKind: 'slack', targetId: 't1', completedAt: Date.now(), durationMs: 50, statusCode: 200 } satisfies DeliveryEvent,
  { type: 'DELIVERY_FAILED', deliveryId: 'd1', jobId: 'j1', runId: 'r1', surfaceKind: 'slack', targetId: 't1', failedAt: Date.now(), error: 'timeout', retryable: true } satisfies DeliveryEvent,
  { type: 'DELIVERY_DEAD_LETTERED', deliveryId: 'd1', jobId: 'j1', runId: 'r1', surfaceKind: 'slack', targetId: 't1', reason: 'max retries', attempts: 3 } satisfies DeliveryEvent,
  // watchers
  { type: 'WATCHER_STARTED', watcherId: 'w1', sourceKind: 'poll', name: 'repo-check' } satisfies WatcherEvent,
  { type: 'WATCHER_HEARTBEAT', watcherId: 'w1', sourceKind: 'poll', seenAt: Date.now(), checkpoint: 'abc' } satisfies WatcherEvent,
  { type: 'WATCHER_CHECKPOINT_ADVANCED', watcherId: 'w1', sourceKind: 'poll', checkpoint: 'def' } satisfies WatcherEvent,
  { type: 'WATCHER_FAILED', watcherId: 'w1', sourceKind: 'poll', error: 'timeout', retryable: true } satisfies WatcherEvent,
  { type: 'WATCHER_STOPPED', watcherId: 'w1', sourceKind: 'poll', reason: 'user' } satisfies WatcherEvent,
  // surfaces
  { type: 'SURFACE_ENABLED', surfaceKind: 'slack', surfaceId: 'sl1', accountId: 'acc1' } satisfies SurfaceEvent,
  { type: 'SURFACE_DISABLED', surfaceKind: 'slack', surfaceId: 'sl1', reason: 'error' } satisfies SurfaceEvent,
  { type: 'SURFACE_ACCOUNT_CONNECTED', surfaceKind: 'slack', surfaceId: 'sl1', accountId: 'acc1', displayName: 'My Workspace' } satisfies SurfaceEvent,
  { type: 'SURFACE_ACCOUNT_DEGRADED', surfaceKind: 'slack', surfaceId: 'sl1', accountId: 'acc1', error: 'rate limit' } satisfies SurfaceEvent,
  { type: 'SURFACE_CAPABILITY_CHANGED', surfaceKind: 'slack', surfaceId: 'sl1', capability: 'reactions', enabled: false } satisfies SurfaceEvent,
  // knowledge
  { type: 'KNOWLEDGE_INGEST_STARTED', sourceId: 'src1', connectorId: 'c1', sourceType: 'git' } satisfies KnowledgeEvent,
  { type: 'KNOWLEDGE_INGEST_COMPLETED', sourceId: 'src1', status: 'success' } satisfies KnowledgeEvent,
  { type: 'KNOWLEDGE_INGEST_FAILED', sourceId: 'src1', error: 'auth' } satisfies KnowledgeEvent,
  { type: 'KNOWLEDGE_EXTRACTION_COMPLETED', sourceId: 'src1', extractionId: 'e1', format: 'markdown', estimatedTokens: 500 } satisfies KnowledgeEvent,
  { type: 'KNOWLEDGE_EXTRACTION_FAILED', sourceId: 'src1', error: 'parse' } satisfies KnowledgeEvent,
  { type: 'KNOWLEDGE_COMPILE_COMPLETED', sourceId: 'src1', nodeCount: 50, edgeCount: 30 } satisfies KnowledgeEvent,
  { type: 'KNOWLEDGE_LINT_COMPLETED', issueCount: 2 } satisfies KnowledgeEvent,
  { type: 'KNOWLEDGE_PACKET_BUILT', task: 'build feature', itemCount: 10, estimatedTokens: 200, detail: 'standard' } satisfies KnowledgeEvent,
  { type: 'KNOWLEDGE_PROJECTION_RENDERED', targetId: 'tgt1', pageCount: 3 } satisfies KnowledgeEvent,
  { type: 'KNOWLEDGE_PROJECTION_MATERIALIZED', targetId: 'tgt1', artifactId: 'art1', pageCount: 3 } satisfies KnowledgeEvent,
  { type: 'KNOWLEDGE_JOB_QUEUED', jobId: 'j1', runId: 'r1', mode: 'background' } satisfies KnowledgeEvent,
  { type: 'KNOWLEDGE_JOB_STARTED', jobId: 'j1', runId: 'r1', mode: 'background' } satisfies KnowledgeEvent,
  { type: 'KNOWLEDGE_JOB_COMPLETED', jobId: 'j1', runId: 'r1', durationMs: 500 } satisfies KnowledgeEvent,
  { type: 'KNOWLEDGE_JOB_FAILED', jobId: 'j1', runId: 'r1', error: 'oom', durationMs: 100 } satisfies KnowledgeEvent,
  // planner (covered with plain-object fixture; type import omitted as it requires internal deps)
  { type: 'PLAN_STRATEGY_SELECTED', strategy: 'direct', confidence: 0.9, reasons: [], taskHint: 'build' },
  { type: 'PLAN_STRATEGY_OVERRIDDEN', strategy: null },
];
