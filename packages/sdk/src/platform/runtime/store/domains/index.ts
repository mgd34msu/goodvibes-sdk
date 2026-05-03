/**
 * Barrel export for all runtime store domain types and initial state factories.
 */

export type {
  SessionRecoveryState,
  SessionStatus,
  SessionLineageEntry,
  SessionDomainState,
} from './session.js';
export { createInitialSessionState } from './session.js';

export type {
  ReasoningEffort,
  ProviderTier,
  ModelTokenLimits,
  FallbackChainEntry,
  ModelDomainState,
} from './model.js';
export { createInitialModelState } from './model.js';

export type {
  TurnState,
  ToolExecutionState,
  ActiveToolCall,
  TurnUsage,
  StreamProgress,
  ConversationDomainState,
} from './conversation.js';
export { createInitialConversationState } from './conversation.js';

export type {
  OverlayId,
  OverlayInstance,
  OverlayDomainState,
} from './overlays.js';
export { createInitialOverlaysState } from './overlays.js';

export type {
  PanelId,
  PanelPosition,
  PanelState,
  PanelDomainState,
} from './panels.js';
export { createInitialPanelsState } from './panels.js';

export type {
  PermissionMode,
  PermissionDecisionMachineState,
  PermissionDecisionOutcome,
  PermissionSourceLayer,
  PermissionDecisionReason,
  PermissionDecision,
  PermissionDomainState,
} from './permissions.js';
export { createInitialPermissionsState } from './permissions.js';

export type {
  TaskLifecycleState,
  TaskKind,
  TaskRetryPolicy,
  RuntimeTask,
  TaskDomainState,
} from './tasks.js';
export { createInitialTasksState } from './tasks.js';

export type {
  AgentLifecycleState,
  AgentRole,
  AgentWrfcRef,
  RuntimeAgent,
  AgentDomainState,
} from './agents.js';
export { createInitialAgentsState } from './agents.js';

export type {
  OrchestrationMode,
  OrchestrationNodeRole,
  OrchestrationNodeState,
  OrchestrationGraphState,
  OrchestrationNodeRecord,
  OrchestrationGraphRecord,
  OrchestrationDomainState,
} from './orchestration.js';
export { createInitialOrchestrationState } from './orchestration.js';

export type {
  RuntimeCommunicationRecord,
  CommunicationDomainState,
} from './communication.js';
export { createInitialCommunicationState } from './communication.js';

export type {
  ProviderStatus,
  CompositeHealthStatus,
  ProviderCallStats,
  ProviderCacheMetrics,
  ProviderHealthRecord,
  ProviderHealthDomainState,
} from './provider-health.js';
export { createInitialProviderHealthState } from './provider-health.js';

export type {
  McpServerLifecycleState,
  McpRegisteredTool,
  McpServerRecord,
  McpDomainState,
} from './mcp.js';
export { createInitialMcpState } from './mcp.js';

export type {
  PluginLifecycleState,
  RuntimePlugin,
  PluginDomainState,
} from './plugins.js';
export { createInitialPluginsState } from './plugins.js';

export type {
  DaemonTransportState,
  DaemonProcessInfo,
  DaemonJob,
  DaemonDomainState,
} from './daemon.js';
export { createInitialDaemonState } from './daemon.js';

export type {
  AutomationDomainState,
} from './automation.js';
export { createInitialAutomationState } from './automation.js';

export type {
  RoutesDomainState,
} from './routes.js';
export { createInitialRoutesState } from './routes.js';

export type {
  ControlPlaneClientKind,
  ControlPlaneTransportKind,
  ControlPlaneConnectionState,
  ControlPlaneClientRecord,
  ControlPlaneDomainState,
} from './control-plane.js';
export { createInitialControlPlaneState } from './control-plane.js';

export type {
  DeliveryLifecycleState,
  DeliveryDomainState,
} from './deliveries.js';
export { createInitialDeliveryState } from './deliveries.js';

export type {
  WatcherKind,
  WatcherState,
  WatcherSourceStatus,
  WatcherRecord,
  WatcherDomainState,
} from './watchers.js';
export { createInitialWatcherState } from './watchers.js';

export type {
  SurfaceConnectionState,
  SurfaceRecord,
  SurfaceDomainState,
} from './surfaces.js';
export { createInitialSurfaceState } from './surfaces.js';

export type {
  AcpTransportState,
  AcpConnection,
  AcpDomainState,
} from './acp.js';
export { createInitialAcpState } from './acp.js';

export type {
  IntegrationStatus,
  IntegrationCategory,
  IntegrationRecord,
  IntegrationDomainState,
} from './integrations.js';
export { createInitialIntegrationsState } from './integrations.js';

export type {
  TelemetryEventRecord,
  SessionMetrics,
  TraceContext,
  TelemetryDomainState,
} from './telemetry.js';
export { createInitialTelemetryState } from './telemetry.js';

export type {
  GitFileStatus,
  GitFileRecord,
  GitCommitSummary,
  GitBranchInfo,
  GitDomainState,
} from './git.js';
export { createInitialGitState } from './git.js';

export type {
  IndexStatus,
  LanguageServerRecord,
  FileWatcherStatus,
  DiscoveryDomainState,
} from './discovery.js';
export { createInitialDiscoveryState } from './discovery.js';

export type {
  IntelligenceFeatureStatus,
  LspDiagnostic,
  WorkspaceSymbol,
  IntelligenceHoverState,
  IntelligenceDomainState,
} from './intelligence.js';
export { createInitialIntelligenceState } from './intelligence.js';

export type {
  RenderBudgetStatus,
  RenderCycleRecord,
  InputLatencySample,
  UiPerfDomainState,
} from './ui-perf.js';
export { createInitialUiPerfState } from './ui-perf.js';

export type {
  SurfacePerfDomainState,
} from './surface-perf.js';
export { createInitialSurfacePerfState } from './surface-perf.js';
