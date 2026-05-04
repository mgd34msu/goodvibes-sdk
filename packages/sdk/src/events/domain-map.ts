/**
 * RuntimeEventMap — master mapping of all typed runtime event types to their payloads.
 *
 * Used by RuntimeEventBus for type-safe subscriptions. Combine all domain
 * discriminated union members into a single flat map keyed by the type string.
 */
import type { SessionEvent } from './session.js';
import type { TurnEvent } from './turn.js';
import type { ProviderEvent } from './providers.js';
import type { ToolEvent } from './tools.js';
import type { TaskEvent } from './tasks.js';
import type { AgentEvent } from './agents.js';
import type { WorkflowEvent } from './workflows.js';
import type { OrchestrationEvent } from './orchestration.js';
import type { CommunicationEvent } from './communication.js';
import type { PlannerEvent } from './planner.js';
import type { PermissionEvent } from './permissions.js';
import type { PluginEvent } from './plugins.js';
import type { McpEvent } from './mcp.js';
import type { TransportEvent } from './transport.js';
import type { CompactionEvent } from './compaction.js';
import type { GoodVibesUIEvent as UIEvent } from './ui.js';
import type { OpsEvent } from './ops.js';
import type { ForensicsEvent } from './forensics.js';
import type { SecurityEvent } from './security.js';
import type { AutomationEvent } from './automation.js';
import type { RouteEvent } from './routes.js';
import type { ControlPlaneEvent } from './control-plane.js';
import type { DeliveryEvent } from './deliveries.js';
import type { WatcherEvent } from './watchers.js';
import type { SurfaceEvent } from './surfaces.js';
import type { KnowledgeEvent } from './knowledge.js';
import type { WorkspaceEvent } from './workspace.js';

/** Union of all runtime domain events. */
export type AnyRuntimeEvent =
  | SessionEvent
  | TurnEvent
  | ProviderEvent
  | ToolEvent
  | TaskEvent
  | AgentEvent
  | WorkflowEvent
  | OrchestrationEvent
  | CommunicationEvent
  | PlannerEvent
  | PermissionEvent
  | PluginEvent
  | McpEvent
  | TransportEvent
  | CompactionEvent
  | UIEvent
  | OpsEvent
  | ForensicsEvent
  | SecurityEvent
  | AutomationEvent
  | RouteEvent
  | ControlPlaneEvent
  | DeliveryEvent
  | WatcherEvent
  | SurfaceEvent
  | KnowledgeEvent
  | WorkspaceEvent;

/**
 * Utility type that maps an event type discriminant to its full event shape.
 *
 * Example:
 * ```ts
 * type Payload = RuntimeEventPayload<'TURN_SUBMITTED'>;
 * // => { type: 'TURN_SUBMITTED'; turnId: string; prompt: string }
 * ```
 */
export type RuntimeEventPayload<T extends AnyRuntimeEvent['type']> = Extract<
  AnyRuntimeEvent,
  { type: T }
>;

// RUNTIME_EVENT_DOMAINS, RuntimeEventDomain, and isRuntimeEventDomain re-exported
// from @pellux/goodvibes-contracts (the canonical source-of-truth). This eliminates
// the RUNTIME_EVENT_DOMAINS_2 duplicate identity in the api-extractor report.
export {
  RUNTIME_EVENT_DOMAINS,
  isRuntimeEventDomain,
} from '@pellux/goodvibes-contracts';
export type { RuntimeEventDomain } from '@pellux/goodvibes-contracts';

/** Map from domain label to its event union type. */
export type DomainEventMap = {
  session: SessionEvent;
  turn: TurnEvent;
  providers: ProviderEvent;
  tools: ToolEvent;
  tasks: TaskEvent;
  agents: AgentEvent;
  workflows: WorkflowEvent;
  orchestration: OrchestrationEvent;
  communication: CommunicationEvent;
  planner: PlannerEvent;
  permissions: PermissionEvent;
  plugins: PluginEvent;
  mcp: McpEvent;
  transport: TransportEvent;
  compaction: CompactionEvent;
  ui: UIEvent;
  ops: OpsEvent;
  forensics: ForensicsEvent;
  security: SecurityEvent;
  automation: AutomationEvent;
  routes: RouteEvent;
  'control-plane': ControlPlaneEvent;
  deliveries: DeliveryEvent;
  watchers: WatcherEvent;
  surfaces: SurfaceEvent;
  knowledge: KnowledgeEvent;
  workspace: WorkspaceEvent;
};

/** Transport-layer runtime event record type. */
// Re-export from contracts so transport-layer packages use the same identity.
// Consumers who need the full runtime event union should import AnyRuntimeEvent directly;
// RuntimeEventRecord is now the structural constraint { readonly type: string }.
export type { RuntimeEventRecord } from '@pellux/goodvibes-contracts';
