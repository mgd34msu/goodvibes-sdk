import type { RuntimeEventBus, RuntimeEventEnvelope, AnyRuntimeEvent, WorkflowEvent } from '../runtime/events/index.js';
import type {
  ChannelRenderEvent,
  ChannelRenderPhase,
  ChannelRenderPolicy,
  ChannelRenderRequest,
  ChannelRenderResult,
  ChannelSurface,
} from './types.js';
import type { ChannelPluginRegistry } from './plugin-registry.js';
import type { RouteBindingManager } from './route-manager.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

import { markEventsDelivered, selectUndeliveredEvents } from './reply-delta.js';
import { buildRenderedText, normalizeChannelRenderEventFromRuntime } from './reply-render.js';
import { DEFAULT_POLICY } from './reply-policy.js';

export { normalizeChannelRenderEventFromRuntime } from './reply-render.js';

const MAX_BUFFERED_EVENTS = 64;
const DEFAULT_PROGRESS_INTERVAL_MS = 7_500;

/**
 * How long a run must have been going before it may interrupt anyone with a
 * progress notification.
 *
 * Owner ruling: a progress notification is warranted only when silence would
 * be worse — when the work has been running long enough that a person would
 * reasonably wonder whether it died. Below this floor an exchange produces
 * exactly ONE notification, the answer, which is what asking a question is
 * supposed to feel like.
 *
 * Measured from `pending.createdAt` (when the reply was queued for this
 * agent), so it bounds the WHOLE run rather than the gap between ticks — the
 * pacing interval already does the latter, and pacing alone still let a
 * three-second conversational turn produce a "starting" push before its
 * answer. Applied ahead of `force`, because forcing exists to bypass pacing
 * for something worth interrupting for, and nothing in the first few seconds
 * of a run qualifies.
 */
const MIN_PROGRESS_NOTIFICATION_AGE_MS = 30_000;

export interface TrackedChannelReply {
  readonly agentId: string;
  readonly surfaceKind: ChannelSurface;
  readonly task: string;
  readonly agentTask?: string | undefined;
  readonly workflowChainId?: string | undefined;
  readonly createdAt: number;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly [key: string]: unknown;
}

/**
 * A reply that was produced for a conversation but never reached it.
 *
 * Handed to the host so the miss lands in the same delivery ledger automation
 * deliveries use. Without this, "the agent answered and the answer was lost"
 * and "no message ever arrived" read identically: zero attempts, no record.
 */
export interface UndeliveredChannelReply {
  readonly surfaceKind: ChannelSurface;
  readonly agentId: string;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly phase: ChannelRenderPhase;
  readonly body: string;
  readonly reason: string;
}

export type UndeliveredChannelReplyReporter = (reply: UndeliveredChannelReply) => void;

/** A reply that did reach its conversation, for the same ledger. */
export interface DeliveredChannelReply {
  readonly surfaceKind: ChannelSurface;
  readonly agentId: string;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly responseId?: string | undefined;
}

export type DeliveredChannelReplyReporter = (reply: DeliveredChannelReply) => void;

interface ReplyPipelineDeps {
  readonly channelPlugins: ChannelPluginRegistry;
  readonly routeBindings: RouteBindingManager;
  readonly runtimeBus?: RuntimeEventBus | null | undefined;
  readonly now?: (() => number) | undefined;
  /** Records a produced-but-undelivered reply in the delivery ledger. */
  readonly onUndelivered?: UndeliveredChannelReplyReporter | undefined;
  /** Records a reply that reached its conversation in the delivery ledger. */
  readonly onDelivered?: DeliveredChannelReplyReporter | undefined;
}

interface ReplyBufferState {
  readonly pending: TrackedChannelReply;
  readonly events: ChannelRenderEvent[];
  /**
   * Ids of events already published to the surface — the delta watermark.
   * Progress updates render only the events NOT in this set, so a notification
   * carries what just happened rather than the whole accumulated log replayed
   * from the top on every tick.
   */
  readonly deliveredEventIds: Set<string>;
  lastDeliveredText?: string | undefined;
  lastDeliveredAt?: number | undefined;
}

function resolveEnvelopeAgentId(envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>): string | null {
  if (envelope.agentId) return envelope.agentId;
  const payload = envelope.payload as { readonly agentId?: unknown };
  return typeof payload.agentId === 'string' ? payload.agentId : null;
}

function isWorkflowEventPayload(payload: AnyRuntimeEvent): payload is WorkflowEvent {
  return payload.type.startsWith('WORKFLOW_');
}

function resolveEnvelopeWorkflowChainId(envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>): string | null {
  const payload = envelope.payload as { readonly chainId?: unknown };
  return typeof payload.chainId === 'string' && payload.chainId.length > 0 ? payload.chainId : null;
}

function isAgentFinalEvent(type: AnyRuntimeEvent['type']): boolean {
  return type === 'AGENT_COMPLETED' || type === 'AGENT_FAILED' || type === 'AGENT_CANCELLED';
}

export class ChannelReplyPipeline {
  private readonly channelPlugins: ChannelPluginRegistry;
  private readonly routeBindings: RouteBindingManager;
  private readonly now: () => number;
  private readonly buffers = new Map<string, ReplyBufferState>();
  /**
   * Tail of the in-flight delivery chain for each agent — the serialization
   * point that makes "read the watermark, publish, mark delivered" atomic.
   *
   * Two callers reach this concurrently by design: `handleEnvelope` fires on
   * every bus event, and the daemon's pending-reply poller calls
   * `deliverProgress(..., force)` on its own 2s tick. Both used to read the
   * same unmarked watermark while a publish was still in flight, so each one
   * selected the same events plus whatever had arrived since — the reader got
   * a ladder of notifications where each body was a strict SUPERSET of the one
   * before it. The single-call delta was already correct; the interleaving was
   * not.
   */
  private readonly deliveryChains = new Map<string, Promise<void>>();
  private readonly workflowChains = new Map<string, string>();
  private readonly unsubscribers: Array<() => void> = [];
  private undeliveredReporter: UndeliveredChannelReplyReporter | null;
  private deliveredReporter: DeliveredChannelReplyReporter | null;

  constructor(deps: ReplyPipelineDeps) {
    this.channelPlugins = deps.channelPlugins;
    this.routeBindings = deps.routeBindings;
    this.now = deps.now ?? (() => Date.now());
    this.undeliveredReporter = deps.onUndelivered ?? null;
    this.deliveredReporter = deps.onDelivered ?? null;
    this.attachRuntimeBus(deps.runtimeBus ?? null);
  }

  /** Install (or replace) the ledger reporters after construction. */
  setUndeliveredReporter(reporter: UndeliveredChannelReplyReporter | null): void {
    this.undeliveredReporter = reporter;
  }

  setDeliveredReporter(reporter: DeliveredChannelReplyReporter | null): void {
    this.deliveredReporter = reporter;
  }

  attachRuntimeBus(runtimeBus: RuntimeEventBus | null): void {
    this.disposeSubscriptions();
    if (!runtimeBus) return;
    const domains: Array<Parameters<RuntimeEventBus['onDomain']>[0]> = [
      'agents',
      'turn',
      'tools',
      'planner',
      'permissions',
      'providers',
      'compaction',
      'workflows',
    ];
    for (const domain of domains) {
      this.unsubscribers.push(runtimeBus.onDomain(domain, (envelope) => {
        void this.handleEnvelope(envelope as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>).catch((error: unknown) => {
          logger.warn('Channel reply pipeline failed to handle runtime event', {
            domain,
            eventType: envelope.type,
            error: summarizeError(error),
          });
        });
      }));
    }
  }

  dispose(): void {
    this.disposeSubscriptions();
    this.buffers.clear();
    this.workflowChains.clear();
    this.deliveryChains.clear();
  }

  /**
   * Run `task` with no other delivery for the same agent in flight.
   *
   * Serializing the whole read-decide-publish-mark body — rather than only
   * reserving the watermark before the await — is deliberate. Reserving the
   * watermark alone stops the superset ladder, but it leaves the two OTHER
   * pieces of state this method reads before the await and writes after it
   * racing: `lastDeliveredText` (the identical-body suppression) and
   * `lastDeliveredAt` (the pacing interval). Under a reserve-only fix two
   * callers still both pass the pacing check and both publish, so one message
   * still arrives as two notifications — disjoint instead of nested, which is
   * a smaller bug of the same kind. With the section serialized, the second
   * caller observes the first one's marks and correctly suppresses itself.
   *
   * Scope is per agent id, so a slow surface can only delay that agent's own
   * updates, never another agent's. Rejections are absorbed into the chain
   * tail (callers still see their own), so one failed send cannot poison the
   * next one.
   */
  private runExclusive<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.deliveryChains.get(agentId);
    const started = previous ? previous.then(task, task) : task();
    const settled = started.then(() => undefined, () => undefined);
    this.deliveryChains.set(agentId, settled);
    void settled.then(() => {
      if (this.deliveryChains.get(agentId) === settled) {
        this.deliveryChains.delete(agentId);
      }
    });
    return started;
  }

  trackPending(pending: TrackedChannelReply): void {
    this.buffers.set(pending.agentId, {
      pending,
      events: [],
      deliveredEventIds: new Set<string>(),
    });
    if (typeof pending.workflowChainId === 'string' && pending.workflowChainId.length > 0) {
      this.workflowChains.set(pending.workflowChainId, pending.agentId);
    }
  }

  untrack(agentId: string): void {
    this.buffers.delete(agentId);
    for (const [chainId, mappedAgentId] of this.workflowChains.entries()) {
      if (mappedAgentId === agentId) {
        this.workflowChains.delete(chainId);
      }
    }
  }

  has(agentId: string): boolean {
    return this.buffers.has(agentId);
  }

  getPending(agentId: string): TrackedChannelReply | null {
    return this.buffers.get(agentId)?.pending ?? null;
  }

  async deliverProgress(agentId: string, explicitText?: string, force = false): Promise<ChannelRenderResult | null> {
    return await this.runExclusive(agentId, async () => await this.deliverProgressExclusive(agentId, explicitText, force));
  }

  private async deliverProgressExclusive(
    agentId: string,
    explicitText: string | undefined,
    force: boolean,
  ): Promise<ChannelRenderResult | null> {
    const state = this.buffers.get(agentId);
    if (!state) return null;
    // Nothing is worth interrupting for yet. See MIN_PROGRESS_NOTIFICATION_AGE_MS:
    // this is what makes a conversational exchange exactly one notification.
    if (this.now() - state.pending.createdAt < MIN_PROGRESS_NOTIFICATION_AGE_MS) return null;
    const policy = await this.resolvePolicy(state.pending.surfaceKind);
    // Every surface gets the status line, ntfy included. Blanking it for ntfy
    // made the owner's primary channel the only one with no "what is happening
    // now" at all — and it was inert anyway, because the progress phase used to
    // discard explicitText entirely. buildRenderedText bounds it to one line.
    const explicit = explicitText ?? '';
    // Delta only. Rendering the whole accumulated buffer on every tick is what
    // made each notification re-send everything that came before it, so line
    // counts climbed 3 -> 10 -> 13 while the reader learned nothing new.
    //
    // Progress-phase events ONLY. The buffer is appended to by the bus while
    // this call is queued, so by the time a tick actually runs the agent may
    // already have completed and pushed its final events. Rendering the whole
    // buffer let a progress notification carry "Agent completed in 5ms" — and,
    // worse, consume the watermark for a final-phase event, which would then
    // be missing from the final body. What the agent is DOING is progress;
    // what it SAID is the final's to deliver.
    const freshEvents = selectUndeliveredEvents(state, state.events.filter((event) => event.phase !== 'final'));
    if (freshEvents.length === 0 && explicit.trim().length === 0) return null;
    const text = buildRenderedText(explicit, freshEvents, policy, 'progress');
    if (!text) return null;
    // Identical content is never republished, forced or not. `force` exists to
    // bypass the pacing interval for something worth interrupting for; it is
    // not authorization to send the same body again. Letting it skip this
    // check is what turned one workstream into 14 copies of one message.
    if (state.lastDeliveredText === text) return null;
    if (!force && (this.now() - (state.lastDeliveredAt ?? 0)) < DEFAULT_PROGRESS_INTERVAL_MS && state.lastDeliveredText !== undefined) {
      return null;
    }
    const delivered = freshEvents.slice(-policy.maxEventsPerUpdate);
    // A failed progress update must not abort the turn or unwind the delta
    // watermark: the final reply is the one that has to arrive, and replaying
    // the same events on the next tick would only repeat the same failure.
    let result: ChannelRenderResult | null = null;
    try {
      result = await this.dispatch(state, policy, 'progress', text, delivered);
    } catch (error) {
      logger.warn('Agent progress update could not be delivered to its surface', {
        surface: state.pending.surfaceKind,
        agentId,
        sessionId: state.pending.sessionId ?? null,
        bindingId: state.pending.routeId ?? null,
        reason: summarizeError(error),
      });
      this.reportUndelivered(state, 'progress', text, summarizeError(error));
    }
    markEventsDelivered(state, freshEvents);
    state.lastDeliveredText = text;
    state.lastDeliveredAt = this.now();
    return result;
  }

  async deliverFinal(
    agentId: string,
    explicitText: string,
    options: { readonly keepTracking?: boolean } = {},
  ): Promise<ChannelRenderResult | null> {
    return await this.runExclusive(agentId, async () => await this.deliverFinalExclusive(agentId, explicitText, options));
  }

  private async deliverFinalExclusive(
    agentId: string,
    explicitText: string,
    options: { readonly keepTracking?: boolean },
  ): Promise<ChannelRenderResult | null> {
    const state = this.buffers.get(agentId);
    if (!state) return null;
    const policy = await this.resolvePolicy(state.pending.surfaceKind);
    const finalEvents = state.events.filter((event) => event.phase === 'final');
    // Delta, no floor.
    //
    // Buffered events are rendered only if the reader has not already been sent
    // them. Rendering the lot made the final body a strict SUPERSET of every
    // progress update before it — so the exact-body check below could never
    // fire, and one trivial message arrived as three notifications, each
    // repeating the previous one plus a little more.
    //
    // This used to end in a floor: when everything had already been delivered,
    // a synthesised status event rendered "Completed" so that a run "never ends
    // in silence". Owner ruling: it should. Work that produced nothing to
    // report reports nothing, and a bare acknowledgement is not a message —
    // it is a notification whose entire content is that a notification was
    // possible. The guarantee that a CONVERSATION always gets an answer moved
    // to where it belongs, upstream, where there is still a model to ask
    // (agents/conversational-reply-recovery.ts).
    const candidateEvents = finalEvents.length > 0 ? finalEvents : state.events;
    const renderEvents = selectUndeliveredEvents(state, candidateEvents);
    const text = buildRenderedText(explicitText, renderEvents, policy, 'final');
    // Nothing to say, so say nothing — but close the run out.
    //
    // Two ways here: a run that finished with no output at all, and a body that
    // rendered to nothing after the completion report was stripped out of it.
    // Either way the reader gets no notification, and the pipeline still marks
    // the events delivered and untracks the agent, so this can never leave an
    // agent tracked forever or make the poller re-deliver it.
    if (!text.trim()) {
      markEventsDelivered(state, renderEvents);
      if (!options.keepTracking) this.untrack(agentId);
      return null;
    }
    // A chain that keeps tracking (ntfy workflow chains) can reach this more
    // than once. An identical final body is a duplicate notification, not a
    // second outcome — publish it once.
    if (text && state.lastDeliveredText === text) {
      if (!options.keepTracking) this.untrack(agentId);
      return null;
    }
    // A final reply is delivered ONCE, whether or not the surface accepted it.
    //
    // Letting a throwing dispatch escape used to skip the untrack below, which
    // left the agent still tracked; the pending-reply poller then treated the
    // completed agent as unhandled, re-appended its answer to the shared
    // session, and retried the same failing send. The observable symptom was
    // every Telegram answer stored twice with nothing delivered. The send is
    // still allowed to fail — it just fails once, loudly, and stops.
    let result: ChannelRenderResult | null = null;
    let deliveryError: unknown = null;
    try {
      // The body is the delta; the event list handed to the renderer is not.
      // Renderers classify an outcome from it (an `error` event is what marks a
      // notification failed), and that verdict must not flip just because the
      // error line was already delivered by a progress tick.
      result = await this.dispatch(
        state,
        policy,
        'final',
        text,
        finalEvents.length > 0 ? finalEvents : state.events.slice(-policy.maxEventsPerUpdate),
      );
    } catch (error) {
      deliveryError = error;
      logger.error('Agent reply could not be delivered to the surface it came from', {
        surface: state.pending.surfaceKind,
        agentId,
        sessionId: state.pending.sessionId ?? null,
        bindingId: state.pending.routeId ?? null,
        phase: 'final',
        reason: summarizeError(error),
      });
      this.reportUndelivered(state, 'final', text, summarizeError(error));
    }
    // Mark exactly what this body was built from, so a later leg of a chain
    // that keeps tracking renders its own news and not this one again.
    markEventsDelivered(state, renderEvents);
    state.lastDeliveredText = text;
    state.lastDeliveredAt = this.now();
    if (!options.keepTracking) {
      this.untrack(agentId);
    }
    if (deliveryError) return null;
    if (result?.delivered) {
      // Close the ledger entry this reply opened when it was queued. Without
      // this the ledger shows every surface reply stuck at "pending" forever,
      // which is only marginally more useful than showing nothing.
      this.deliveredReporter?.({
        surfaceKind: state.pending.surfaceKind,
        agentId: state.pending.agentId,
        sessionId: state.pending.sessionId,
        routeId: state.pending.routeId,
        ...(result.responseId ? { responseId: result.responseId } : {}),
      });
    }
    return result;
  }

  /**
   * Report a reply that was produced but never reached its conversation.
   *
   * Routed through the SAME delivery ledger the automation deliveries use, so
   * a "should have sent, did not" is a visible failed attempt rather than an
   * absence indistinguishable from "nothing happened".
   */
  private reportUndelivered(
    state: ReplyBufferState,
    phase: ChannelRenderPhase,
    text: string,
    reason: string,
  ): void {
    this.undeliveredReporter?.({
      surfaceKind: state.pending.surfaceKind,
      agentId: state.pending.agentId,
      sessionId: state.pending.sessionId,
      routeId: state.pending.routeId,
      phase,
      body: text,
      reason,
    });
  }

  private async handleEnvelope(
    envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
  ): Promise<void> {
    if (isWorkflowEventPayload(envelope.payload)) {
      await this.handleWorkflowEnvelope(envelope as RuntimeEventEnvelope<WorkflowEvent['type'], WorkflowEvent>);
      return;
    }
    if (
      envelope.payload.type === 'AGENT_SPAWNING'
      && typeof envelope.payload.parentAgentId === 'string'
      && envelope.payload.parentAgentId.length > 0
    ) {
      this.trackChildPendingReply(
        envelope.payload.agentId,
        envelope.payload.parentAgentId,
        envelope.payload.task,
      );
    }
    const agentId = resolveEnvelopeAgentId(envelope);
    if (!agentId) return;
    const state = this.buffers.get(agentId);
    if (!state) return;
    const events = normalizeChannelRenderEventFromRuntime(envelope);
    if (events.length === 0) return;
    state.events.push(...events);
    if (state.events.length > MAX_BUFFERED_EVENTS) {
      state.events.splice(0, state.events.length - MAX_BUFFERED_EVENTS);
    }
    const hasFinal = events.some((event) => event.phase === 'final');
    if (hasFinal) {
      // The same set for every surface, ntfy included. ntfy used to drop
      // `assistant_text` here, which meant the one notification the owner
      // actually waits for carried "Agent completed in Nms" and never the
      // reply that produced it. Length is a rendering concern, and it is
      // already handled: the ntfy policy trims the body to maxChunkChars.
      const finalKinds = new Set<ChannelRenderEvent['kind']>(['assistant_text', 'error', 'status']);
      const text = events
        .filter((event) => finalKinds.has(event.kind))
        .map((event) => event.text ?? '')
        .filter(Boolean)
        .join('\n')
        .trim();
      await this.deliverFinal(agentId, text, {
        keepTracking: state.pending.surfaceKind === 'ntfy'
          && typeof state.pending.workflowChainId === 'string'
          && isAgentFinalEvent(envelope.payload.type),
      });
      return;
    }
    await this.deliverProgress(agentId);
  }

  private async handleWorkflowEnvelope(
    envelope: RuntimeEventEnvelope<WorkflowEvent['type'], WorkflowEvent>,
  ): Promise<void> {
    if (envelope.payload.type === 'WORKFLOW_CHAIN_CREATED') {
      const matched = this.findPendingForWorkflowTask(envelope.payload.task);
      if (matched) {
        this.associateWorkflowChain(matched.pending.agentId, envelope.payload.chainId);
      }
    }
    const chainId = resolveEnvelopeWorkflowChainId(envelope);
    if (!chainId) return;
    const agentId = this.workflowChains.get(chainId);
    if (!agentId) return;
    const state = this.buffers.get(agentId);
    if (!state) {
      this.workflowChains.delete(chainId);
      return;
    }
    const events = normalizeChannelRenderEventFromRuntime(envelope);
    if (events.length === 0) return;
    state.events.push(...events);
    if (state.events.length > MAX_BUFFERED_EVENTS) {
      state.events.splice(0, state.events.length - MAX_BUFFERED_EVENTS);
    }
    const hasFinal = events.some((event) => event.phase === 'final');
    if (hasFinal) {
      const text = events
        .filter((event) => event.kind === 'error' || event.kind === 'status')
        .map((event) => event.text ?? '')
        .filter(Boolean)
        .join('\n')
        .trim();
      await this.deliverFinal(agentId, text);
      return;
    }
    await this.deliverProgress(agentId, undefined, true);
  }

  private trackChildPendingReply(agentId: string, parentAgentId: string, task: string): void {
    if (this.buffers.has(agentId)) return;
    const parentState = this.buffers.get(parentAgentId);
    if (!parentState) return;
    const rootAgentId = typeof parentState.pending.rootAgentId === 'string'
      ? parentState.pending.rootAgentId
      : parentAgentId;
    this.buffers.set(agentId, {
      pending: {
        ...parentState.pending,
        agentId,
        task,
        parentAgentId,
        rootAgentId,
      },
      events: [],
      deliveredEventIds: new Set<string>(),
    });
  }

  private findPendingForWorkflowTask(task: string): ReplyBufferState | null {
    const normalizedTask = task.trim();
    if (!normalizedTask) return null;
    let fallback: ReplyBufferState | null = null;
    for (const state of this.buffers.values()) {
      if (typeof state.pending.workflowChainId === 'string') continue;
      const agentTask = typeof state.pending.agentTask === 'string' ? state.pending.agentTask.trim() : '';
      const pendingTask = state.pending.task.trim();
      if (agentTask === normalizedTask) return state;
      if (!fallback && pendingTask === normalizedTask) {
        fallback = state;
      }
    }
    return fallback;
  }

  private associateWorkflowChain(agentId: string, chainId: string): void {
    const state = this.buffers.get(agentId);
    if (!state) return;
    this.workflowChains.set(chainId, agentId);
    this.buffers.set(agentId, {
      ...state,
      pending: {
        ...state.pending,
        workflowChainId: chainId,
      },
    });
  }

  private async resolvePolicy(surface: ChannelSurface): Promise<ChannelRenderPolicy> {
    return await this.channelPlugins.getRenderPolicy(surface) ?? DEFAULT_POLICY[surface];
  }

  private async dispatch(
    state: ReplyBufferState,
    policy: ChannelRenderPolicy,
    phase: ChannelRenderPhase,
    text: string,
    events: readonly ChannelRenderEvent[],
  ): Promise<ChannelRenderResult | null> {
    const request: ChannelRenderRequest = {
      surface: state.pending.surfaceKind,
      phase,
      agentId: state.pending.agentId,
      sessionId: state.pending.sessionId,
      routeId: state.pending.routeId,
      title: state.pending.task,
      text,
      events,
      pending: state.pending,
      metadata: {
        policy,
      },
    };
    const result = await this.channelPlugins.render(state.pending.surfaceKind, request);
    if (!result || !result.delivered) {
      // Not an exception, but the reply still did not reach anyone. A final
      // answer that silently reports "not delivered" is the exact failure this
      // module exists to make visible, so it is an error with the binding in
      // hand and a ledger entry, not a warn nobody reads.
      const reason = !result
        ? 'no-renderer-or-delivery-handler'
        : String(result.metadata.reason ?? 'renderer-reported-not-delivered');
      const describe = {
        surface: state.pending.surfaceKind,
        phase,
        agentId: state.pending.agentId,
        sessionId: state.pending.sessionId ?? null,
        bindingId: state.pending.routeId ?? null,
        reason,
      };
      if (phase === 'final') {
        logger.error('Agent reply was produced but no channel delivered it', describe);
        this.reportUndelivered(state, phase, text, reason);
      } else {
        logger.warn('ChannelReplyPipeline: channel render did not report delivery', describe);
      }
    }
    if (result?.responseId && state.pending.routeId) {
      await this.routeBindings.captureReplyTarget(
        state.pending.routeId,
        result.responseId,
        typeof result.threadId === 'string' && result.threadId.length > 0 ? result.threadId : undefined,
      );
    }
    return result;
  }

  private disposeSubscriptions(): void {
    while (this.unsubscribers.length > 0) {
      this.unsubscribers.pop()?.();
    }
  }
}
