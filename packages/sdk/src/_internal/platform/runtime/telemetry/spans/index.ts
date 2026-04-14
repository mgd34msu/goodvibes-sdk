/**
 * Barrel export for span helpers.
 */
export type { TurnSpanContext, TurnSpanEndContext } from './turn.js';
export { startTurnSpan, endTurnSpan } from './turn.js';

export type { ToolSpanContext, ToolSpanEndContext, ToolPhase } from './tool.js';
export { startToolSpan, recordToolPhase, endToolSpan } from './tool.js';

export type {
  LlmSpanContext,
  LlmSpanEndContext,
  LlmTokenUsage,
} from './llm.js';
export { startLlmSpan, recordLlmStreamStart, endLlmSpan } from './llm.js';

export type { PluginSpanContext, PluginSpanEndContext, PluginPhase } from './plugin.js';
export { startPluginSpan, recordPluginPhase, endPluginSpan } from './plugin.js';

export type { McpSpanContext, McpSpanEndContext, McpPhase } from './mcp.js';
export { startMcpSpan, recordMcpPhase, endMcpSpan } from './mcp.js';

export type { TransportSpanContext, TransportSpanEndContext, TransportPhase } from './transport.js';
export { startTransportSpan, recordTransportPhase, endTransportSpan } from './transport.js';

export type { TaskSpanContext, TaskSpanEndContext, TaskPhase } from './task.js';
export { startTaskSpan, recordTaskPhase, endTaskSpan } from './task.js';

export type { AgentSpanContext, AgentSpanEndContext, AgentPhase } from './agent.js';
export { startAgentSpan, recordAgentPhase, endAgentSpan } from './agent.js';

export type { PermissionSpanContext, PermissionSpanEndContext, PermissionPhase } from './permission.js';
export { startPermissionSpan, recordPermissionPhase, endPermissionSpan } from './permission.js';

export type { SessionSpanContext, SessionSpanEndContext, SessionPhase } from './session.js';
export { startSessionSpan, recordSessionPhase, endSessionSpan } from './session.js';

export type { CompactionSpanContext, CompactionSpanEndContext, CompactionPhase } from './compaction.js';
export { startCompactionSpan, recordCompactionPhase, endCompactionSpan } from './compaction.js';

export type { HealthCascadeSpanContext } from './health.js';
export { recordHealthCascadeSpan } from './health.js';
