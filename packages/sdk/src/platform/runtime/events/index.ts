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
import { createEventEnvelope } from './envelope.js';
import type { AnyRuntimeEvent, RuntimeEventDomain, DomainEventMap } from '../../../events/domain-map.js';
import { summarizeError } from '../../utils/error-display.js';
import type { OpsEvent } from '../../../events/ops.js';
import { listenerErrorsTotal } from '../metrics.js';

export type { RuntimeEventEnvelope, EnvelopeContext } from './envelope.js';
export { createEventEnvelope } from './envelope.js';
export type { SessionEvent, SessionEventType } from '../../../events/session.js';
export type { TurnEvent, TurnEventType, TurnInputOrigin } from '../../../events/turn.js';
export type { ProviderEvent, ProviderEventType } from '../../../events/providers.js';
export type { ToolEvent, ToolEventType } from '../../../events/tools.js';
export type { TaskEvent, TaskEventType } from '../../../events/tasks.js';
export type { AgentEvent, AgentEventType } from '../../../events/agents.js';
export type { WorkflowEvent, WorkflowEventType } from '../../../events/workflows.js';
export type { OrchestrationEvent, OrchestrationEventType, OrchestrationTaskContract } from '../../../events/orchestration.js';
export type { CommunicationEvent, CommunicationEventType, CommunicationKind, CommunicationScope } from '../../../events/communication.js';
export type { PlannerEvent, PlannerEventType } from '../../../events/planner.js';
export type { PermissionEvent, PermissionEventType } from '../../../events/permissions.js';
export type { PluginEvent, PluginEventType } from '../../../events/plugins.js';
export type { McpEvent, McpEventType } from '../../../events/mcp.js';
export type { TransportEvent, TransportEventType } from '../../../events/transport.js';
export type { CompactionEvent, CompactionEventType } from '../../../events/compaction.js';
export type { UIEvent, UIEventType } from '../../../events/ui.js';
export type { OpsEvent, OpsEventType } from '../../../events/ops.js';
export type { OpsInterventionReason } from '../../../events/ops.js';
export { RUNTIME_EVENT_DOMAINS, isRuntimeEventDomain } from '../../../events/domain-map.js';
export { registeredEventTypes, validateEvent } from '../../../events/contracts.js';
export type { AnyRuntimeEvent, RuntimeEventPayload, RuntimeEventDomain, DomainEventMap, RuntimeEventRecord } from '../../../events/domain-map.js';
export type { AutomationEvent, AutomationEventType, AutomationScheduleKind, AutomationExecutionMode, AutomationRunOutcome } from '../../../events/automation.js';
export { AUTOMATION_SCHEDULE_KINDS, AUTOMATION_RUN_OUTCOMES } from '../../../events/automation.js';
export type { RouteEvent, RouteEventType, RouteSurfaceKind, RouteTargetKind } from '../../../events/routes.js';
export { ROUTE_SURFACE_KINDS, ROUTE_TARGET_KINDS } from '../../../events/routes.js';
export type { ControlPlaneEvent, ControlPlaneEventType, ControlPlaneClientKind, ControlPlaneTransportKind, ControlPlanePrincipalKind } from '../../../events/control-plane.js';
export { CONTROL_PLANE_CLIENT_KINDS, CONTROL_PLANE_TRANSPORT_KINDS, CONTROL_PLANE_PRINCIPAL_KINDS } from '../../../events/control-plane.js';
export type { DeliveryEvent, DeliveryEventType, DeliveryKind } from '../../../events/deliveries.js';
export { DELIVERY_KINDS } from '../../../events/deliveries.js';
export type { WatcherEvent, WatcherEventType, WatcherSourceKind } from '../../../events/watchers.js';
export { WATCHER_SOURCE_KINDS } from '../../../events/watchers.js';
export type { SurfaceEvent, SurfaceEventType, SurfaceKind } from '../../../events/surfaces.js';
export { SURFACE_KINDS } from '../../../events/surfaces.js';
export type { KnowledgeEvent, KnowledgeEventType } from '../../../events/knowledge.js';

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
export const MAX_LISTENERS = 100;

/**
 * Options accepted by the RuntimeEventBus constructor.
 */
export interface RuntimeEventBusOptions {
  /**
   * Override the maximum number of listeners per channel.
   * Defaults to MAX_LISTENERS (100).
   * Values above zero are accepted; the cap is applied per event-type channel
   * and per domain channel independently.
   */
  maxListeners?: number;
}

/** Extract a plain string error message from an unknown thrown value. */
function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return summarizeError(err);
}

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
  /** Effective listener cap for this instance. */
  private readonly _maxListeners: number;
  /** Track per-listener error counts for misbehaving-listener dedup. */
  private readonly _listenerErrorCounts = new WeakMap<EnvelopeListener, number>();
  /** Number of errors a listener must throw before OPS_LISTENER_MISBEHAVING is emitted. */
  private static readonly _MISBEHAVE_DEDUP_THRESHOLD = 1;

  constructor(opts?: RuntimeEventBusOptions) {
    this._maxListeners = opts?.maxListeners ?? MAX_LISTENERS;
  }

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
    if (set.size > this._maxListeners) {
      if (process.env['NODE_ENV'] === 'development') {
        // Remove the just-added listener before throwing to maintain state consistency.
        set.delete(callback as EnvelopeListener);
        if (set.size === 0) this._listeners.delete(eventType);
        throw new RangeError(
          `[RuntimeEventBus] listener cap exceeded — maxListeners=${this._maxListeners} eventType=${String(eventType)}`
        );
      }
      logger.warn('[RuntimeEventBus] possible listener leak detected', {
        eventType,
        count: set.size,
        max: this._maxListeners,
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
    if (set.size > this._maxListeners) {
      if (process.env['NODE_ENV'] === 'development') {
        // Remove the just-added listener before throwing to maintain state consistency.
        set.delete(callback as EnvelopeListener);
        if (set.size === 0) this._domainListeners.delete(domain);
        throw new RangeError(
          `[RuntimeEventBus] domain listener cap exceeded — maxListeners=${this._maxListeners} domain=${String(domain)}`
        );
      }
      logger.warn('[RuntimeEventBus] possible domain listener leak detected', {
        domain,
        count: set.size,
        max: this._maxListeners,
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
   * Domain-keyed overload: when the domain is statically known, the envelope
   * type is narrowed to the corresponding DomainEventMap entry — no cast needed.
   *
   * @param domain - Domain this event belongs to.
   * @param envelope - The fully-formed envelope to dispatch.
   */
  public emit<D extends RuntimeEventDomain>(
    domain: D,
    envelope: RuntimeEventEnvelope<DomainEventMap[D]['type'], DomainEventMap[D]>
  ): void;
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

    // OBS-14: Dispatch each subscriber in its own microtask so a slow or
    // throwing subscriber cannot block the emitter. Errors are caught and
    // logged per-subscriber; a single bad handler never cascades to others.

    // Dispatch to per-type listeners
    for (const handler of typeHandlers) {
      const h = handler;
      const ev = envelope as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>;
      const evType = envelope.type;
      queueMicrotask(() => {
        try {
          h(ev);
        } catch (err) {
          this._recordListenerError(h, evType, err);
        }
      });
    }
    // Dispatch to per-domain listeners
    for (const handler of domainHandlers) {
      const h = handler;
      const ev = envelope as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>;
      const evType = envelope.type;
      const d = domain;
      queueMicrotask(() => {
        try {
          h(ev);
        } catch (err) {
          this._recordListenerError(h, evType, err, String(d));
        }
      });
    }
  }

  /**
   * Record a listener error: increment metrics, update error count, emit
   * OPS_LISTENER_MISBEHAVING once the dedup threshold is reached, and log.
   *
   * @param listener - The misbehaving listener function.
   * @param eventType - The event type that triggered the listener.
   * @param err - The thrown value caught from the listener.
   * @param domain - Optional domain name, present when the listener was a domain subscriber.
   */
  private _recordListenerError(
    listener: EnvelopeListener,
    eventType: AnyRuntimeEvent['type'],
    err: unknown,
    domain?: string
  ): void {
    const errMsg = extractErrorMessage(err);
    listenerErrorsTotal.add(1, { event_type: eventType });
    const prev = this._listenerErrorCounts.get(listener) ?? 0;
    const next = prev + 1;
    this._listenerErrorCounts.set(listener, next);
    if (next === RuntimeEventBus._MISBEHAVE_DEDUP_THRESHOLD) {
      this._emitListenerMisbehaving(listener, String(eventType), errMsg, next);
    }
    if (domain !== undefined) {
      logger.error('[RuntimeEventBus] domain listener error', {
        domain,
        eventType,
        error: summarizeError(err),
      });
    } else {
      logger.error('[RuntimeEventBus] listener error', {
        eventType,
        error: summarizeError(err),
      });
    }
  }

  /**
   * Directly dispatch an OPS_LISTENER_MISBEHAVING envelope to any registered
   * OPS_LISTENER_MISBEHAVING and 'ops' domain listeners.
   *
   * Bypasses emit() to avoid potential recursion: a listener watching for
   * misbehaving events itself misbehaving would otherwise cause infinite loops.
   */
  private _emitListenerMisbehaving(
    listener: EnvelopeListener,
    eventType: string,
    errorMessage: string,
    errorCount: number
  ): void {
    const payload: OpsEvent & { type: 'OPS_LISTENER_MISBEHAVING' } = {
      type: 'OPS_LISTENER_MISBEHAVING',
      listenerId: listener.name || '(anonymous)',
      eventType,
      errorMessage,
      errorCount,
    };
    const envelope = createEventEnvelope(
      'OPS_LISTENER_MISBEHAVING',
      payload,
      { sessionId: 'runtime-bus', source: 'runtime-bus' }
    ) as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>;

    // Dispatch directly — no queueMicrotask, no recursion path through emit().
    const typeListeners = this._listeners.get('OPS_LISTENER_MISBEHAVING');
    if (typeListeners) {
      for (const h of Array.from(typeListeners)) {
        try {
          h(envelope);
        } catch (error) {
          logger.warn('OPS_LISTENER_MISBEHAVING listener failed', { error: summarizeError(error) });
        }
      }
    }
    const domainListeners = this._domainListeners.get('ops');
    if (domainListeners) {
      for (const h of Array.from(domainListeners)) {
        try {
          h(envelope);
        } catch (error) {
          logger.warn('OPS_LISTENER_MISBEHAVING domain listener failed', { error: summarizeError(error) });
        }
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
