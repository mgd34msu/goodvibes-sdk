/**
 * Diagnostics system — barrel re-exports and factory.
 *
 * This module provides the public API for the runtime diagnostics system.
 * Import from here to access types, providers, and the factory function.
 *
 * Usage:
 * ```ts
 * import { createDiagnosticsProvider } from '../runtime/diagnostics/index.js';
 *
 * const provider = createDiagnosticsProvider({
 *   eventBus,
 *   healthAggregator,
 *   domains: [...],
 * });
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────────────
export type {
  DiagnosticFilter,
  DiagnosticLevel,
  ComponentConfig,
  ToolCallEntry,
  ToolCallPhase,
  ToolCallPermission,
  AgentEntry,
  AgentDiagnosticState,
  TaskEntry,
  EventEntry,
  DomainStateEntry,
  RuntimeStateSnapshot,
  DomainHealthSummary,
  HealthDashboardData,
} from './types.js';
export { DEFAULT_BUFFER_LIMIT, DEFAULT_COMPONENT_CONFIG, applyFilter, appendBounded } from './types.js';

// ── Action system ────────────────────────────────────────────────────────────
export type {
  DiagnosticActionType,
  DiagnosticActionPermission,
  DiagnosticActionPayload,
  DiagnosticAction,
  HighSeverityDiagnostic,
  ActionResult,
  NavigateToEntryCallback,
  PermissionChecker,
  DiagnosticActionDispatcherConfig,
  LoadReplayPayload,
  RunPolicySimulationPayload,
  JumpToTaskPayload,
  JumpToAgentPayload,
  JumpToToolCallPayload,
  RetryTaskPayload,
  CancelTaskPayload,
  CancelAgentPayload,
} from './actions.js';
export {
  DiagnosticActionDispatcher,
  buildLoadReplayAction,
  buildRunPolicySimulationAction,
  buildJumpToTaskAction,
  buildJumpToAgentAction,
  buildJumpToToolCallAction,
  buildRetryTaskAction,
  buildCancelTaskAction,
  buildCancelAgentAction,
  diagnosticFromTaskFailure,
  diagnosticFromAgentFailure,
  diagnosticFromToolContractViolation,
  diagnosticFromForensicsRun,
} from './actions.js';

// ── Panel data providers ─────────────────────────────────────────────────────
export { ToolCallsPanel } from './panels/tool-calls.js';
export { AgentsPanel } from './panels/agents.js';
export { TasksPanel } from './panels/tasks.js';
export { EventsPanel } from './panels/events.js';
export { StateInspectorPanel } from './panels/state-inspector.js';
export type { InspectableDomain } from './panels/state-inspector.js';
export { HealthPanel } from './panels/health.js';

// ── Provider ─────────────────────────────────────────────────────────────────
export { DiagnosticsProvider } from './provider.js';
export type { DiagnosticsProviderConfig, DiagnosticPanelName } from './provider.js';

// ── Factory ───────────────────────────────────────────────────────────────────
import { DiagnosticsProvider, type DiagnosticsProviderConfig } from './provider.js';

/**
 * Factory function that creates a fully wired DiagnosticsProvider.
 *
 * @param config - Configuration including the event bus, health aggregator,
 *   optional domain adapters, and optional per-panel buffer config.
 * @returns A ready-to-use DiagnosticsProvider.
 */
export function createDiagnosticsProvider(config: DiagnosticsProviderConfig): DiagnosticsProvider {
  return new DiagnosticsProvider(config);
}
