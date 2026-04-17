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
import type { UIEvent } from './ui.js';
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
  | KnowledgeEvent;

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

/**
 * Domain labels for use with domain-scoped subscriptions.
 *
 * This is the source-of-truth vocabulary for runtime transport/event surfaces.
 */
export const RUNTIME_EVENT_DOMAINS = [
  'session',
  'turn',
  'providers',
  'tools',
  'tasks',
  'agents',
  'workflows',
  'orchestration',
  'communication',
  'planner',
  'permissions',
  'plugins',
  'mcp',
  'transport',
  'compaction',
  'ui',
  'ops',
  'forensics',
  'security',
  'automation',
  'routes',
  'control-plane',
  'deliveries',
  'watchers',
  'surfaces',
  'knowledge',
] as const;

/**
 * Domain label type for use with domain-scoped subscriptions.
 */
export type RuntimeEventDomain = typeof RUNTIME_EVENT_DOMAINS[number];

export function isRuntimeEventDomain(value: string): value is RuntimeEventDomain {
  return (RUNTIME_EVENT_DOMAINS as readonly string[]).includes(value);
}

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
};

/**
 * Legacy alias for `AnyRuntimeEvent` used by transport-layer generics.
 *
 * Historically the transport layer used `{ readonly type: string }` as a loose
 * catch-all bound. This alias replaces that with the fully-typed discriminated
 * union so TypeScript narrows `payload` automatically on `type` match.
 *
 * @deprecated Prefer `AnyRuntimeEvent` for new code.
 */
export type RuntimeEventRecord = AnyRuntimeEvent;
