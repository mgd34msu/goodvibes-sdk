// ── Diagnostics ──────────────────────────────────────────────────────────────
// MIN-05: Wildcard policy for `platform/runtime/observability` barrel.
//
// Unlike sibling barrels (e.g., `ui.ts`, `shell.ts`, `state.ts`) that use
// `export *` from sub-barrels, this file uses ONLY named re-exports. Reasons:
//
// 1. Sub-barrels (`diagnostics/index.js`, `eval/index.js`, `forensics/index.js`,
//    `health/index.js`, `inspection/index.js`) themselves contain symbols not
//    intended for the public observability surface. Named re-exports here keep
//    the public surface a deliberate curated allowlist instead of an inherited
//    snapshot that grows whenever a sub-barrel adds an export.
// 2. The `./platform/runtime/observability` subpath is one of the most-touched
//    public entry points (sec-XX, obs-XX tests run through it). Forgotten or
//    accidental exports here would surface in `etc/goodvibes-sdk.api.md` diff
//    review, but a named-only barrel makes the contract explicit at edit time
//    rather than catch-time.
// 3. The `_N` suffix collisions historically traced to wildcard chains; this
//    barrel pre-empts that class of problem by construction.
//
// If a new symbol must be exposed here, add it explicitly below. Do not switch
// to `export *` for convenience.

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
  ComponentResourceEntry,
  ComponentResourceSnapshot,
} from './diagnostics/index.js';
export {
  DEFAULT_BUFFER_LIMIT,
  DEFAULT_COMPONENT_CONFIG,
  applyFilter,
  appendBounded,
} from './diagnostics/index.js';
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
} from './diagnostics/index.js';
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
} from './diagnostics/index.js';
export {
  ToolCallsPanel,
  AgentsPanel,
  TasksPanel,
  EventsPanel,
  StateInspectorPanel,
  HealthPanel,
  ForensicsDataPanel,
  DivergencePanel,
  ReplayPanel,
  SecurityPanel,
  ToolContractsPanel,
  TransportPanel,
} from './diagnostics/index.js';
export type {
  SecurityPanelSnapshot,
  TransportPanelSnapshot,
} from './diagnostics/index.js';
export { DiagnosticsProvider, createDiagnosticsProvider } from './diagnostics/index.js';
export type { DiagnosticsProviderConfig, DiagnosticPanelName } from './diagnostics/index.js';

// ── Eval ─────────────────────────────────────────────────────────────────────
export type {
  EvalScenario,
  EvalRawResult,
  EvalResult,
  EvalSuiteResult,
  EvalScorecard,
  EvalBaseline,
  EvalGateResult,
  EvalDimension,
  DimensionScore,
  RegressionEntry,
  BaselineSuiteSummary,
  EvalRunnerOptions,
} from './eval/index.js';
export {
  EvalRunner,
  scoreScenario,
  formatScorecard,
  DIMENSION_FLOOR,
  BUILTIN_SUITES,
  ALL_SCENARIOS,
  captureBaseline,
  serialiseBaseline,
  deserialiseBaseline,
  writeBaseline,
  loadBaseline,
  formatBaselineComparison,
  formatSuiteResult,
  formatGateResult,
} from './eval/index.js';

// ── Forensics ─────────────────────────────────────────────────────────────────
export type {
  FailureReport,
  FailureClass,
  PhaseTimingEntry,
  CausalChainEntry,
  ForensicsJumpLink,
  ForensicsBundle,
  ForensicsReplayEvidence,
  ForensicsEvidenceSummary,
  ReplaySnapshotInput,
} from './forensics/index.js';
export {
  classifyFailure,
  summariseFailure,
  ForensicsRegistry,
  DEFAULT_REGISTRY_LIMIT,
  ForensicsCollector,
} from './forensics/index.js';

// ── Idempotency ───────────────────────────────────────────────────────────────
export type {
  IdempotencyKeyContext,
  IdempotencyRecord,
  IdempotencyStoreConfig,
  IdempotencyStatus,
} from './idempotency/index.js';
export { IdempotencyStore } from './idempotency/index.js';

// ── Perf ─────────────────────────────────────────────────────────────────────
export type {
  PerfBudget,
  PerfMetric,
  BudgetViolation,
  PerfReport,
  PerfUnit,
  PerfSnapshot,
  ComponentResourceContract,
  ComponentHealthState,
  ComponentThrottleStatus,
  ComponentHealthStatus,
  PanelResourceContract,
  PanelHealthState,
  PanelThrottleStatus,
  PanelHealthStatus,
} from './perf/index.js';
export {
  DEFAULT_BUDGETS,
  PerfMonitor,
  formatReport,
  exitCode,
  SloCollector,
  SLO_METRICS,
  CATEGORY_CONTRACTS,
  buildContract,
  createInitialComponentHealthState,
  createInitialPanelHealthState,
  ComponentHealthMonitor,
} from './perf/index.js';
// PanelHealthMonitor is an alias for ComponentHealthMonitor, preserved for backwards-compat.
// The 'Component' prefix was renamed to 'Panel' at the public surface to better reflect its
// role as a runtime panel health tracker. Both names resolve to the same implementation.
export { ComponentHealthMonitor as PanelHealthMonitor } from './perf/index.js';
// DiagnosticsProviderConfig and DiagnosticPanelName are included via the diagnostics block above.
export {
  RuntimeHealthAggregator,
} from './health/aggregator.js';
export { CascadeEngine } from './health/cascade-engine.js';
export { CASCADE_RULES } from './health/cascade-rules.js';
export {
  ALL_CASCADE_RULE_IDS,
  CASCADE_PLAYBOOK_MAP,
  CascadeTimer,
  createCascadeAppliedEvent,
  createHealthSystem,
  deriveCascadeSeverity,
} from './health/index.js';
export type {
  HealthStatus,
  HealthDomain as RuntimeHealthDomain,
  DomainHealth,
  CompositeHealth,
  CascadeRule,
  CascadeEffect,
  CascadeResult,
  EvaluateResult,
  CascadeAppliedEvent,
} from './health/types.js';
export {
  BoundedTransitionLog,
  TimelineBuffer,
  SelectorHotspotSampler,
  StateInspectorProvider,
  createStateInspector,
} from './inspection/state-inspector/index.js';
export type {
  CreateStateInspectorOptions,
  DomainSnapshot,
  HotspotReport,
  HotspotSamplerConfig,
  SelectorHotspot,
  StateInspectorConfig,
  StateSnapshot,
  SubscriptionInfo,
  TimeTravelCursor,
  TimelineEvent,
  TransitionEntry,
} from './inspection/state-inspector/index.js';
export {
  TelemetryApiService,
} from './telemetry/index.js';
export type {
  LedgerEntry,
} from './telemetry/exporters/local-ledger.js';
export { getSecuritySettingsReport } from './security-settings.js';
export type { SecuritySettingReport, SecuritySettingsReporter } from './security-settings.js';
export type { ComponentConfig as PanelConfig } from './diagnostics/types.js';
export { DEFAULT_COMPONENT_CONFIG as DEFAULT_PANEL_CONFIG } from './diagnostics/types.js';
