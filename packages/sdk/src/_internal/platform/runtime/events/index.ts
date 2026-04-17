/**
 * Runtime Events — barrel re-exports and RuntimeEventBus.
 *
 * Import from this module to access the typed event system:
 * ```ts
 * import { RuntimeEventBus, createEventEnvelope } from '../runtime/events/index.js';
 * ```
 */
import { logger } from '../../utils/logger.js';
import type { RuntimeEventEnvelope } from './envelope.js';
import type { AnyRuntimeEvent, RuntimeEventDomain, DomainEventMap } from './domain-map.js';
import { summarizeError } from '../../utils/error-display.js';

export type { RuntimeEventEnvelope, EnvelopeContext } from './envelope.js';
export { createEventEnvelope } from './envelope.js';
export type { SessionEvent, SessionEventType } from './session.js';
export type { TurnEvent, TurnEventType } from './turn.js';
export type { ProviderEvent, ProviderEventType } from './providers.js';
export type { ToolEvent, ToolEventType } from './tools.js';
export type { TaskEvent, TaskEventType } from './tasks.js';
export type { AgentEvent, AgentEventType } from './agents.js';
export type { WorkflowEvent, WorkflowEventType } from './workflows.js';
export type { OrchestrationEvent, OrchestrationEventType, OrchestrationTaskContract } from './orchestration.js';
export type { CommunicationEvent, CommunicationEventType, CommunicationKind, CommunicationScope } from './communication.js';
export type { PlannerEvent, PlannerEventType } from './planner.js';
export type { PermissionEvent, PermissionEventType } from './permissions.js';
export type { PluginEvent, PluginEventType } from './plugins.js';
export type { McpEvent, McpEventType } from './mcp.js';
export type { TransportEvent, TransportEventType } from './transport.js';
export type { CompactionEvent, CompactionEventType } from './compaction.js';
export type { UIEvent, UIEventType } from './ui.js';
export type { OpsEvent, OpsEventType } from './ops.js';
export { RUNTIME_EVENT_DOMAINS, isRuntimeEventDomain } from './domain-map.js';
export type { AnyRuntimeEvent, RuntimeEventPayload, RuntimeEventDomain, DomainEventMap, RuntimeEventRecord } from './domain-map.js';
export type { AutomationEvent, AutomationEventType, AutomationScheduleKind, AutomationExecutionMode, AutomationRunOutcome } from './automation.js';
export { AUTOMATION_SCHEDULE_KINDS, AUTOMATION_RUN_OUTCOMES } from './automation.js';
export type { RouteEvent, RouteEventType, RouteSurfaceKind, RouteTargetKind } from './routes.js';
export { ROUTE_SURFACE_KINDS, ROUTE_TARGET_KINDS } from './routes.js';
export type { ControlPlaneEvent, ControlPlaneEventType, ControlPlaneClientKind, ControlPlaneTransportKind, ControlPlanePrincipalKind } from './control-plane.js';
export { CONTROL_PLANE_CLIENT_KINDS, CONTROL_PLANE_TRANSPORT_KINDS, CONTROL_PLANE_PRINCIPAL_KINDS } from './control-plane.js';
export type { DeliveryEvent, DeliveryEventType, DeliveryKind } from './deliveries.js';
export { DELIVERY_KINDS } from './deliveries.js';
export type { WatcherEvent, WatcherEventType, WatcherSourceKind } from './watchers.js';
export { WATCHER_SOURCE_KINDS } from './watchers.js';
export type { SurfaceEvent, SurfaceEventType, SurfaceKind } from './surfaces.js';
export { SURFACE_KINDS } from './surfaces.js';
export type { KnowledgeEvent, KnowledgeEventType } from './knowledge.js';

/** Listener callback receiving a fully-formed envelope. */
export type EnvelopeListener<T extends AnyRuntimeEvent = AnyRuntimeEvent> = (
  envelope: RuntimeEventEnvelope<T['type'], T>
) => void;

/**
 * Maximum listeners per channel before a potential memory leak warning is emitted.
 *
 * 100 is a generous threshold for a single event type or domain; normal usage
 * rarely exceeds single-digit listeners. Exceeding this strongly suggests a
 * subscriber is being registered without a corresponding unsubscribe.
 */
const MAX_LISTENERS = 100;

/**
 * RuntimeEventBus — typed event bus for domain-structured runtime events.
 *
 * Supports two subscription modes:
 * - `on(eventType, callback)` — subscribe to a specific event type
 * - `onDomain(domain, callback)` — subscribe to all events in a domain
 *
 * All events are wrapped in a RuntimeEventEnvelope providing traceId,
 * sessionId, timestamps, and source context.
 *
 * This is the authoritative event transport for runtime domain signaling.
 */
export class RuntimeEventBus {
  /** Per-event-type listener sets. Keyed by the exact event type string. */
  private readonly _listeners = new Map<AnyRuntimeEvent['type'], Set<EnvelopeListener>>();
  /** Per-domain listener sets. Keyed by RuntimeEventDomain. */
  private readonly _domainListeners = new Map<RuntimeEventDomain, Set<EnvelopeListener>>();

  /**
   * Subscribe to a specific event type.
   *
   * @param eventType - The exact event type string to listen for.
   * @param callback - Called with the full envelope on each emission.
   * @returns An unsubscribe function.
   */
  public on<T extends AnyRuntimeEvent>(
    eventType: T['type'],
    callback: EnvelopeListener<T>
  ): () => void {
    if (!this._listeners.has(eventType)) {
      this._listeners.set(eventType, new Set());
    }
    const set = this._listeners.get(eventType)!;
    set.add(callback as EnvelopeListener);
    if (set.size > MAX_LISTENERS) {
      logger.warn('[RuntimeEventBus] possible listener leak detected', {
        eventType,
        count: set.size,
        max: MAX_LISTENERS,
      });
    }
    return () => this._off(eventType, callback as EnvelopeListener);
  }

  /**
   * Subscribe to all events in a named domain.
   *
   * @param domain - Domain name (e.g. 'turn', 'tools', 'session').
   * @param callback - Called with the full envelope for each domain event.
   * @returns An unsubscribe function.
   */
  public onDomain<D extends RuntimeEventDomain>(
    domain: D,
    callback: EnvelopeListener<DomainEventMap[D]>
  ): () => void {
    if (!this._domainListeners.has(domain)) {
      this._domainListeners.set(domain, new Set());
    }
    const set = this._domainListeners.get(domain)!;
    set.add(callback as EnvelopeListener);
    if (set.size > MAX_LISTENERS) {
      logger.warn('[RuntimeEventBus] possible domain listener leak detected', {
        domain,
        count: set.size,
        max: MAX_LISTENERS,
      });
    }
    return () => this._offDomain(domain, callback as EnvelopeListener);
  }

  /**
   * Emit a runtime event envelope to all matching per-type and per-domain subscribers.
   *
   * @internal Callers MUST use the typed emitter wrapper functions from
   * `src/runtime/emitters/` rather than calling this method directly.
   * Direct usage bypasses domain-event type enforcement: TypeScript cannot
   * statically link the `domain` argument to the `envelope` payload type due
   * to union complexity limitations (TS2590), meaning mismatched pairs compile
   * without error.
   *
   * @see emitTurnSubmitted, emitToolReceived, etc. in `src/runtime/emitters/`
   *
   * @param domain - Domain this event belongs to.
   * @param envelope - The fully-formed envelope to dispatch.
   */
  public emit(
    domain: RuntimeEventDomain,
    envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
  ): void {
    // Snapshot both sets before iterating so that subscribe/unsubscribe calls
    // triggered by a handler do not mutate the live Set mid-iteration (C3 fix).
    const typeSet = this._listeners.get(envelope.type);
    const typeHandlers = typeSet ? Array.from(typeSet) : [];
    const domainSet = this._domainListeners.get(domain);
    const domainHandlers = domainSet ? Array.from(domainSet) : [];

    // Dispatch to per-type listeners
    for (const handler of typeHandlers) {
      try {
        handler(envelope as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>);
      } catch (err) {
        logger.error('[RuntimeEventBus] listener error', {
          eventType: envelope.type,
          error: summarizeError(err),
        });
      }
    }
    // Dispatch to per-domain listeners
    for (const handler of domainHandlers) {
      try {
        handler(envelope as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>);
      } catch (err) {
        logger.error('[RuntimeEventBus] domain listener error', {
          domain,
          eventType: envelope.type,
          error: summarizeError(err),
        });
      }
    }
  }

  private _off(eventType: AnyRuntimeEvent['type'], callback: EnvelopeListener): void {
    const set = this._listeners.get(eventType);
    set?.delete(callback);
    if (set?.size === 0) this._listeners.delete(eventType);
  }

  private _offDomain(domain: RuntimeEventDomain, callback: EnvelopeListener): void {
    const set = this._domainListeners.get(domain);
    set?.delete(callback);
    if (set?.size === 0) this._domainListeners.delete(domain);
  }
}
