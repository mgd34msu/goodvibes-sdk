/**
 * RuntimeState — the canonical top-level state shape for the GoodVibes
 * runtime store. All domain slices are defined here.
 *
 * Each domain includes revision, lastUpdatedAt, and source metadata fields.
 * These are defined per-domain in the domain files.
 */

import type { SessionDomainState } from './domains/session.js';
import type { ModelDomainState } from './domains/model.js';
import type { ConversationDomainState } from './domains/conversation.js';
import type { OverlayDomainState } from './domains/overlays.js';
import type { PermissionDomainState } from './domains/permissions.js';
import type { TaskDomainState } from './domains/tasks.js';
import type { AgentDomainState } from './domains/agents.js';
import type { OrchestrationDomainState } from './domains/orchestration.js';
import type { CommunicationDomainState } from './domains/communication.js';
import type { ProviderHealthDomainState } from './domains/provider-health.js';
import type { McpDomainState } from './domains/mcp.js';
import type { PluginDomainState } from './domains/plugins.js';
import type { DaemonDomainState } from './domains/daemon.js';
import type { AutomationDomainState } from './domains/automation.js';
import type { AcpDomainState } from './domains/acp.js';
import type { RoutesDomainState } from './domains/routes.js';
import type { ControlPlaneDomainState } from './domains/control-plane.js';
import type { DeliveryDomainState } from './domains/deliveries.js';
import type { WatcherDomainState } from './domains/watchers.js';
import type { SurfaceDomainState } from './domains/surfaces.js';
import type { IntegrationDomainState } from './domains/integrations.js';
import type { TelemetryDomainState } from './domains/telemetry.js';
import type { GitDomainState } from './domains/git.js';
import type { DiscoveryDomainState } from './domains/discovery.js';
import type { IntelligenceDomainState } from './domains/intelligence.js';
import type { SurfacePerfDomainState } from './domains/surface-perf.js';

import { createInitialSessionState } from './domains/session.js';
import { createInitialModelState } from './domains/model.js';
import { createInitialConversationState } from './domains/conversation.js';
import { createInitialOverlaysState } from './domains/overlays.js';
import { createInitialPermissionsState } from './domains/permissions.js';
import { createInitialTasksState } from './domains/tasks.js';
import { createInitialAgentsState } from './domains/agents.js';
import { createInitialOrchestrationState } from './domains/orchestration.js';
import { createInitialCommunicationState } from './domains/communication.js';
import { createInitialProviderHealthState } from './domains/provider-health.js';
import { createInitialMcpState } from './domains/mcp.js';
import { createInitialPluginsState } from './domains/plugins.js';
import { createInitialDaemonState } from './domains/daemon.js';
import { createInitialAutomationState } from './domains/automation.js';
import { createInitialAcpState } from './domains/acp.js';
import { createInitialRoutesState } from './domains/routes.js';
import { createInitialControlPlaneState } from './domains/control-plane.js';
import { createInitialDeliveryState } from './domains/deliveries.js';
import { createInitialWatcherState } from './domains/watchers.js';
import { createInitialSurfaceState } from './domains/surfaces.js';
import { createInitialIntegrationsState } from './domains/integrations.js';
import { createInitialTelemetryState } from './domains/telemetry.js';
import { createInitialGitState } from './domains/git.js';
import { createInitialDiscoveryState } from './domains/discovery.js';
import { createInitialIntelligenceState } from './domains/intelligence.js';
import { createInitialSurfacePerfState } from './domains/surface-perf.js';

/**
 * RuntimeState — the complete state shape managed by the runtime store.
 *
 * Domain slices, each with revision/lastUpdatedAt/source metadata.
 * All mutations must go through typed domain dispatch APIs.
 */
export interface RuntimeState {
  session: SessionDomainState;
  model: ModelDomainState;
  conversation: ConversationDomainState;
  overlays: OverlayDomainState;
  panels: Record<string, unknown>;
  permissions: PermissionDomainState;
  tasks: TaskDomainState;
  agents: AgentDomainState;
  orchestration: OrchestrationDomainState;
  communication: CommunicationDomainState;
  providerHealth: ProviderHealthDomainState;
  mcp: McpDomainState;
  plugins: PluginDomainState;
  daemon: DaemonDomainState;
  automation: AutomationDomainState;
  routes: RoutesDomainState;
  controlPlane: ControlPlaneDomainState;
  deliveries: DeliveryDomainState;
  watchers: WatcherDomainState;
  surfaces: SurfaceDomainState;
  acp: AcpDomainState;
  integrations: IntegrationDomainState;
  telemetry: TelemetryDomainState;
  git: GitDomainState;
  discovery: DiscoveryDomainState;
  intelligence: IntelligenceDomainState;
  surfacePerf: SurfacePerfDomainState;
}

/**
 * Creates and returns a fully initialized RuntimeState with all domains
 * set to their default initial values.
 *
 * This is the factory used by `createRuntimeStore()` and test harnesses.
 */
export function createInitialRuntimeState(): RuntimeState {
  return {
    session: createInitialSessionState(),
    model: createInitialModelState(),
    conversation: createInitialConversationState(),
    overlays: createInitialOverlaysState(),
    panels: {},
    permissions: createInitialPermissionsState(),
    tasks: createInitialTasksState(),
    agents: createInitialAgentsState(),
    orchestration: createInitialOrchestrationState(),
    communication: createInitialCommunicationState(),
    providerHealth: createInitialProviderHealthState(),
    mcp: createInitialMcpState(),
    plugins: createInitialPluginsState(),
    daemon: createInitialDaemonState(),
    automation: createInitialAutomationState(),
    routes: createInitialRoutesState(),
    controlPlane: createInitialControlPlaneState(),
    deliveries: createInitialDeliveryState(),
    watchers: createInitialWatcherState(),
    surfaces: createInitialSurfaceState(),
    acp: createInitialAcpState(),
    integrations: createInitialIntegrationsState(),
    telemetry: createInitialTelemetryState(),
    git: createInitialGitState(),
    discovery: createInitialDiscoveryState(),
    intelligence: createInitialIntelligenceState(),
    surfacePerf: createInitialSurfacePerfState(),
  };
}
