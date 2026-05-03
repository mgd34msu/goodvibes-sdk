/**
 * Typed selectors for the runtime store.
 *
 * Each domain has a primary selector plus derived selectors for
 * common access patterns. All selectors are pure functions of RuntimeState.
 *
 * No ad hoc direct `set` from arbitrary modules.
 * Selectors are the read path; mutations go through DomainDispatch.
 */

import type { RuntimeState } from '../state.js';
import type { SessionDomainState } from '../domains/session.js';
import type { ModelDomainState } from '../domains/model.js';
import type { ConversationDomainState, TurnState } from '../domains/conversation.js';
import type { OverlayDomainState, OverlayId } from '../domains/overlays.js';
import type { PermissionDomainState, PermissionMode } from '../domains/permissions.js';
import type { TaskDomainState, RuntimeTask, TaskKind } from '../domains/tasks.js';
import type { AgentDomainState, RuntimeAgent } from '../domains/agents.js';
import type { OrchestrationDomainState } from '../domains/orchestration.js';
import type { CommunicationDomainState } from '../domains/communication.js';
import type { AutomationDomainState } from '../domains/automation.js';
import type { RoutesDomainState } from '../domains/routes.js';
import type { ControlPlaneDomainState } from '../domains/control-plane.js';
import type { DeliveryDomainState } from '../domains/deliveries.js';
import type { WatcherDomainState } from '../domains/watchers.js';
import type { SurfaceDomainState } from '../domains/surfaces.js';
import type { ProviderHealthDomainState, CompositeHealthStatus } from '../domains/provider-health.js';
import type { McpDomainState } from '../domains/mcp.js';
import type { PluginDomainState } from '../domains/plugins.js';
import type { DaemonDomainState } from '../domains/daemon.js';
import type { AcpDomainState } from '../domains/acp.js';
import type { IntegrationDomainState } from '../domains/integrations.js';
import type { TelemetryDomainState } from '../domains/telemetry.js';
import type { GitDomainState } from '../domains/git.js';
import type { DiscoveryDomainState } from '../domains/discovery.js';
import type { IntelligenceDomainState } from '../domains/intelligence.js';
import type { SurfacePerfDomainState } from '../domains/surface-perf.js';

// ---------------------------------------------------------------------------
// Primary domain selectors (one per domain)
// ---------------------------------------------------------------------------

/** Select the full session domain slice. */
export function selectSession(state: RuntimeState): SessionDomainState {
  return state.session;
}

/** Select the full model domain slice. */
export function selectModel(state: RuntimeState): ModelDomainState {
  return state.model;
}

/** Select the full conversation domain slice. */
export function selectConversation(state: RuntimeState): ConversationDomainState {
  return state.conversation;
}

/** Select the full overlays domain slice. */
export function selectOverlays(state: RuntimeState): OverlayDomainState {
  return state.overlays;
}

/** Select the full permissions domain slice. */
export function selectPermissions(state: RuntimeState): PermissionDomainState {
  return state.permissions;
}

/** Select the full tasks domain slice. */
export function selectTasks(state: RuntimeState): TaskDomainState {
  return state.tasks;
}

/** Select the full agents domain slice. */
export function selectAgents(state: RuntimeState): AgentDomainState {
  return state.agents;
}

/** Select the full provider health domain slice. */
export function selectProviderHealth(state: RuntimeState): ProviderHealthDomainState {
  return state.providerHealth;
}

/** Select the full MCP domain slice. */
export function selectMcp(state: RuntimeState): McpDomainState {
  return state.mcp;
}

/** Select the full plugins domain slice. */
export function selectPlugins(state: RuntimeState): PluginDomainState {
  return state.plugins;
}

/** Select the full daemon domain slice. */
export function selectDaemon(state: RuntimeState): DaemonDomainState {
  return state.daemon;
}

/** Select the full ACP domain slice. */
export function selectAcp(state: RuntimeState): AcpDomainState {
  return state.acp;
}

/** Select the full integrations domain slice. */
export function selectIntegrations(state: RuntimeState): IntegrationDomainState {
  return state.integrations;
}

/** Select the full telemetry domain slice. */
export function selectTelemetry(state: RuntimeState): TelemetryDomainState {
  return state.telemetry;
}

/** Select the full git domain slice. */
export function selectGit(state: RuntimeState): GitDomainState {
  return state.git;
}

/** Select the full discovery domain slice. */
export function selectDiscovery(state: RuntimeState): DiscoveryDomainState {
  return state.discovery;
}

/** Select the full intelligence domain slice. */
export function selectIntelligence(state: RuntimeState): IntelligenceDomainState {
  return state.intelligence;
}

/** Select the full orchestration domain slice. */
export function selectOrchestration(state: RuntimeState): OrchestrationDomainState {
  return state.orchestration;
}

/** Select the full communication domain slice. */
export function selectCommunication(state: RuntimeState): CommunicationDomainState {
  return state.communication;
}

/** Select the full automation domain slice. */
export function selectAutomation(state: RuntimeState): AutomationDomainState {
  return state.automation;
}

/** Select the full routes domain slice. */
export function selectRoutes(state: RuntimeState): RoutesDomainState {
  return state.routes;
}

/** Select the full control plane domain slice. */
export function selectControlPlane(state: RuntimeState): ControlPlaneDomainState {
  return state.controlPlane;
}

/** Select the full deliveries domain slice. */
export function selectDeliveries(state: RuntimeState): DeliveryDomainState {
  return state.deliveries;
}

/** Select the full watchers domain slice. */
export function selectWatchers(state: RuntimeState): WatcherDomainState {
  return state.watchers;
}

/** Select the full surfaces domain slice. */
export function selectSurfaces(state: RuntimeState): SurfaceDomainState {
  return state.surfaces;
}

/** Select the full surface performance domain slice. */
export function selectSurfacePerf(state: RuntimeState): SurfacePerfDomainState {
  return state.surfacePerf;
}

// ---------------------------------------------------------------------------
// Derived selectors
// ---------------------------------------------------------------------------

/** Active model summary — the three most-used fields for display and routing. */
export interface ActiveModelSummary {
  providerId: string;
  modelId: string;
  displayName: string;
}

/**
 * Returns the active model identity fields.
 * Use this in components that need to display or route by model.
 */
export function selectActiveModel(state: RuntimeState): ActiveModelSummary {
  const { activeProviderId, activeModelId, displayName } = state.model;
  return { providerId: activeProviderId, modelId: activeModelId, displayName };
}

/**
 * Returns all tasks currently in 'running' state, ordered by startedAt.
 */
export function selectRunningTasks(state: RuntimeState): RuntimeTask[] {
  const { tasks, runningIds } = state.tasks;
  return runningIds
    .map((id) => tasks.get(id))
    .filter((t): t is RuntimeTask => t !== undefined)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

/**
 * Returns all agents currently in non-terminal states.
 */
export function selectRunningAgents(state: RuntimeState): RuntimeAgent[] {
  const { agents, activeAgentIds } = state.agents;
  return activeAgentIds
    .map((id) => agents.get(id))
    .filter((a): a is RuntimeAgent => a !== undefined);
}

/**
 * Domain names that have a health record in providerHealth.
 * Used to look up health status by a named domain.
 */
export type HealthDomain = 'providerHealth' | 'mcp' | 'daemon' | 'acp' | 'integrations';

/**
 * Derives a simplified HealthStatus for a named domain.
 * Returns 'healthy', 'degraded', 'critical', or 'unknown'.
 */
export function selectDomainHealth(
  state: RuntimeState,
  domain: HealthDomain,
): CompositeHealthStatus {
  switch (domain) {
    case 'providerHealth':
      return state.providerHealth.compositeStatus;
    case 'mcp': {
      const connected = state.mcp.connectedServerNames.length;
      const total = state.mcp.servers.size;
      if (total === 0) return 'unknown';
      if (connected === total) return 'healthy';
      if (connected === 0) return 'critical';
      return 'degraded';
    }
    case 'daemon': {
      const ts = state.daemon.transportState;
      if (ts === 'connected') return 'healthy';
      if (ts === 'degraded' || ts === 'reconnecting') return 'degraded';
      if (ts === 'terminal_failure') return 'critical';
      return 'unknown';
    }
    case 'acp': {
      const ts = state.acp.managerTransportState;
      if (ts === 'connected') return 'healthy';
      if (ts === 'degraded' || ts === 'reconnecting') return 'degraded';
      if (ts === 'terminal_failure') return 'critical';
      return 'unknown';
    }
    case 'integrations': {
      const { problemIds, integrations } = state.integrations;
      if (integrations.size === 0) return 'unknown';
      if (problemIds.length === 0) return 'healthy';
      if (problemIds.length === integrations.size) return 'critical';
      return 'degraded';
    }
  }
}

/** Composite system health summary across all tracked subsystems. */
export interface CompositeSystemHealth {
  status: CompositeHealthStatus;
  /** Per-domain breakdown. */
  domains: Record<HealthDomain, CompositeHealthStatus>;
  /** Whether any domain is in critical state. */
  hasCritical: boolean;
  /** Whether any domain is degraded. */
  hasDegraded: boolean;
}

/**
 * Returns a composite system health summary across all tracked subsystems.
 */
export function selectSystemHealth(state: RuntimeState): CompositeSystemHealth {
  const domains: Record<HealthDomain, CompositeHealthStatus> = {
    providerHealth: selectDomainHealth(state, 'providerHealth'),
    mcp: selectDomainHealth(state, 'mcp'),
    daemon: selectDomainHealth(state, 'daemon'),
    acp: selectDomainHealth(state, 'acp'),
    integrations: selectDomainHealth(state, 'integrations'),
  };

  const values = Object.values(domains) as CompositeHealthStatus[];
  const hasCritical = values.includes('critical');
  const hasDegraded = values.includes('degraded');

  let status: CompositeHealthStatus;
  if (hasCritical) {
    status = 'critical';
  } else if (hasDegraded) {
    status = 'degraded';
  } else if (values.every((v) => v === 'healthy')) {
    status = 'healthy';
  } else {
    status = 'unknown';
  }

  return { status, domains, hasCritical, hasDegraded };
}

/**
 * Returns the current permission mode.
 */
export function selectPermissionMode(state: RuntimeState): PermissionMode {
  return state.permissions.mode;
}

/**
 * Returns whether any overlay is currently visible.
 */
export function selectAnyOverlayVisible(state: RuntimeState): boolean {
  return state.overlays.visibleStack.length > 0;
}

/**
 * Returns whether a specific overlay is visible.
 */
export function selectOverlayVisible(
  state: RuntimeState,
  overlayId: OverlayId,
): boolean {
  return state.overlays.visibleStack.includes(overlayId);
}

/**
 * Returns the current turn state from the conversation domain.
 */
export function selectTurnState(
  state: RuntimeState,
): TurnState {
  return state.conversation.turnState;
}

/**
 * Returns the current store-owned partial tool preview for the active stream.
 */
export function selectStreamToolPreview(state: RuntimeState): string | undefined {
  return state.conversation.stream.partialToolPreview;
}

/**
 * Returns whether a turn is currently active (not idle or terminal).
 */
export function selectIsTurnActive(state: RuntimeState): boolean {
  const ts = state.conversation.turnState;
  return ts !== 'idle' && ts !== 'completed' && ts !== 'failed' && ts !== 'cancelled';
}

/**
 * Returns whether the session is fully initialized and ready.
 */
export function selectIsSessionReady(state: RuntimeState): boolean {
  return (
    state.session.status === 'active' &&
    state.session.recoveryState === 'ready'
  );
}

/**
 * Returns the number of currently running tasks, grouped by kind.
 */
export function selectRunningTaskCountByKind(
  state: RuntimeState,
): Partial<Record<TaskKind, number>> {
  const counts: Record<string, number> = {};
  for (const id of state.tasks.runningIds) {
    const task = state.tasks.tasks.get(id);
    if (task) {
      counts[task.kind] = (counts[task.kind] ?? 0) + 1;
    }
  }
  return counts as Partial<Record<TaskKind, number>>;
}
