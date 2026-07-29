import { SDKErrorCodes } from '@pellux/goodvibes-errors';
import type { AutomationRouteBinding } from '../automation/routes.js';
import type {
  SharedSessionInputIntent,
  SharedSessionInputRecord,
  SharedSessionSurfaceReplyBinding,
} from './session-intents.js';
import type {
  CreateSharedSessionInput,
  ParticipantRouteAttachInput,
  SharedSessionMessage,
  SharedSessionParticipant,
  SharedSessionRecord,
  SharedSessionSubmission,
  SubmitSharedSessionMessageInput,
} from './session-types.js';
import type { SharedSessionMessageSender } from './session-broker-helpers.js';
import type { AppendSharedSessionMessageInput } from './session-broker-messages.js';
import {
  recordSharedSessionInput,
  updateSharedSessionInput,
  type SharedSessionInputStore,
} from './session-broker-inputs.js';
import { SURFACE_ROUTE_FRESHNESS_MS, shouldRouteInputToSurface } from './session-broker-sessions.js';
import { decideContinuationEscalation } from '../agents/conversation-continuation.js';
import type { ConversationGateConfigReader } from '../agents/conversation-gate.js';
import { logger } from '../utils/logger.js';

/** Max inputs retained per session bucket (moved here with handleIntent — see
 * session-broker.ts's MAX_PERSISTED_INPUTS for its former home). */
const MAX_PERSISTED_INPUTS = 500;

export interface HandleSharedSessionIntentDeps {
  readonly sessions: Map<string, SharedSessionRecord>;
  readonly messageSender: SharedSessionMessageSender;
  start(): Promise<void>;
  resolveBinding(input: SubmitSharedSessionMessageInput): Promise<AutomationRouteBinding | null>;
  createSession(input?: CreateSharedSessionInput): Promise<SharedSessionRecord>;
  attachParticipantAndRoute(
    session: SharedSessionRecord,
    input: ParticipantRouteAttachInput,
    binding?: AutomationRouteBinding,
  ): Promise<SharedSessionRecord>;
  appendMessage(
    sessionId: string,
    input: Omit<AppendSharedSessionMessageInput, 'sessionId'>,
  ): Promise<SharedSessionMessage>;
  sessionInputStore(): SharedSessionInputStore;
  publishInputLifecycleEvent(
    event: string,
    input: SharedSessionInputRecord,
    extra?: Record<string, unknown>,
  ): void;
  resolveActiveAgentId(session: SharedSessionRecord): string | undefined;
  persist(): Promise<void>;
  publishUpdate(event: string, payload: unknown): void;
  announceSurfaceReply(binding: SharedSessionSurfaceReplyBinding): void;
  /**
   * Put one unsolicited line on a route's channel. Optional: a host that wired
   * no delivery path (every broker-level test, an embedder with its own egress)
   * simply gets no notice, and the rollover is still logged.
   */
  sendSurfaceNotice?: ((routeId: string, text: string) => void) | undefined;
  buildContinuationTask(sessionId: string): string;
  /**
   * Reads `conversationGate.*` for the live-agent handover decision below.
   * Optional: absent means the defaults in conversation-gate.ts, which gate
   * every channel surface and exempt local ones — the safe direction, since
   * the failure mode of gating is an answer instead of a chain.
   */
  readonly conversationGateConfig?: ConversationGateConfigReader | undefined;
}

/**
 * Whether a route binding's OWN session policy permits pointing it at a fresh
 * session. `create-or-bind` says exactly that, and it is what
 * `RouteBindingManager.upsertBinding` writes for every binding that does not
 * pick something else (channels/route-manager.ts), so it covers every chat a
 * channel adapter opens. `continue-existing` and `require-existing` were chosen
 * to mean this route speaks only to the session it names, so they keep the
 * honest closed-session error rather than silently moving the conversation.
 */
function bindingMayRebind(binding: AutomationRouteBinding): boolean {
  return (binding.sessionPolicy ?? 'create-or-bind') === 'create-or-bind';
}

/**
 * Why the session a route binding names cannot carry this message — or `null`
 * when it can.
 *
 * A binding's `sessionId` is a ROUTING HINT, not a fact. It is written once and
 * then outlives everything it points at: the session gets closed, a GC sweep
 * deletes it, the node is restored from a backup taken before the session
 * existed, a surface is elected to a machine whose store never held it. Every
 * one of those leaves a binding naming something this node cannot use, and the
 * conversation on the other end has no way to know or to say so.
 *
 * Two of those deserve naming precisely, because the cluster layer decides
 * them and its answer is short. Sessions do not replicate — the store is
 * `~/.goodvibes/control-plane/sessions.json` on ONE machine, and
 * cluster/index.ts says so outright ("sessions... never pass through here").
 * Neither does `automation-routes.json`. What a surface election moves is the
 * right to READ the inbox, nothing else. So a promotion or a reconnect never
 * produces "a session owned elsewhere" — there is no node-identity field on
 * either record to express such a thing. It produces exactly one observable:
 * a binding naming a session this node's store does not have. Which is the
 * first branch below, and which used to be absorbed in silence.
 *
 * So the hint is CHECKED on every resolve, and the check is written as
 * "prove it is usable", not "rule out the failures I have seen". The last two
 * branches are belt-and-braces: the snapshot loader rejects a malformed record
 * by refusing the whole file (session-broker-state.ts), so a record here is
 * normally well-formed by construction. They exist so that an in-process
 * writer, or a status this enum grows later, cannot strand the channel just
 * because nobody predicted it.
 */
function describeUnusableBoundSession(session: SharedSessionRecord | undefined): string | null {
  if (!session) return 'the session it named is not in this node\'s store';
  if (typeof session.id !== 'string' || session.id.length === 0) return 'the record it named has no id';
  if (session.status === 'closed') return 'the session it named is closed';
  if (session.status !== 'active') return `the record it named has an unusable status (${String(session.status)})`;
  return null;
}

/**
 * Say out loud that a conversation is moving to a new session, and name any
 * still-'active' sessions this same route is listed on while doing it.
 *
 * Those stranded actives are a real and separate problem — sessions whose host
 * process is long gone and which nothing will ever close, so they sit 'active'
 * forever. Reaping them belongs to session GC, not here. But the rollover is
 * the one moment the code can prove it is stepping over them, and a log line
 * costs nothing.
 */
function logChannelSessionRollover(
  deps: HandleSharedSessionIntentDeps,
  binding: AutomationRouteBinding,
  boundSessionId: string,
  reason: string,
  input: SubmitSharedSessionMessageInput,
): void {
  const strandedActiveSessionIds: string[] = [];
  for (const entry of deps.sessions.values()) {
    if (entry.status === 'active' && entry.routeIds.includes(binding.id)) strandedActiveSessionIds.push(entry.id);
  }
  logger.warn('Channel route named an unusable session; rebinding the conversation to a new one', {
    routeId: binding.id,
    surfaceKind: input.surfaceKind,
    boundSessionId,
    reason,
    sessionPolicy: binding.sessionPolicy ?? 'create-or-bind',
    ...(strandedActiveSessionIds.length > 0 ? { strandedActiveSessionIds } : {}),
  });
}

/**
 * Tell the person on the far end that their conversation just moved.
 *
 * Without this the rollover is silent and looks like amnesia: the assistant
 * that remembered the last two days answers the next message with no idea what
 * came before, and the owner is left guessing whether it broke. One sentence
 * turns that into something comprehensible.
 *
 * Sent through the broker's surface-notice port, which the composition root
 * wires to `DaemonSurfaceDeliveryHelper.deliverSurfaceNotice` — the same path
 * every other unsolicited message to a channel goes out on. Fire-and-forget on
 * purpose: a notice that cannot be delivered is logged by that helper, and must
 * never be a reason the owner's actual message fails to be processed.
 */
function announceRolloverOnChannel(
  deps: HandleSharedSessionIntentDeps,
  binding: AutomationRouteBinding,
  reason: string,
): void {
  if (!deps.sendSurfaceNotice) return;
  try {
    deps.sendSurfaceNotice(
      binding.id,
      `Picking this up in a fresh conversation — ${reason}, so I no longer have the earlier messages in view. Nothing was deleted; the previous conversation is kept as history.`,
    );
  } catch (error) {
    logger.warn('Rollover notice could not be handed to the surface delivery path', {
      routeId: binding.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleSharedSessionIntent(
  deps: HandleSharedSessionIntentDeps,
  intent: SharedSessionInputIntent,
  input: SubmitSharedSessionMessageInput,
  allowSpawnFallback: boolean,
): Promise<SharedSessionSubmission> {
  await deps.start();

  const binding = await deps.resolveBinding(input);
  // WHERE the session came from decides what a CLOSED one means, and the two
  // sources are not interchangeable. `input.sessionId` is a caller naming one
  // specific record — it asked about THAT session, and the honest answer when
  // that session is closed is the 409 below. `binding.sessionId` is only where
  // the route last parked this conversation; the sender named nothing.
  let session = input.sessionId ? deps.sessions.get(input.sessionId) ?? undefined : undefined;
  let created = false;
  let rolledOverFrom: string | undefined;
  if (!session && binding?.sessionId) {
    // VALIDATE THE HINT, THEN HEAL IT.
    //
    // There is no client on the far side of a channel to read an error and
    // open a new chat the way the webui companion does: every channel ingress
    // catches, logs and advances its read cursor, so an error thrown here
    // discards the sender's message AND every message after it, for as long as
    // the binding keeps naming the same dead target. One closed session
    // black-holed the owner's Telegram chat exactly this way.
    //
    // `create-or-bind` is the binding SAYING it may be re-pointed, so re-point
    // it: leave whatever it named untouched, and fall into the create branch
    // below, which mints a fresh session and rebinds the route to it durably
    // (createSession patches binding.sessionId through the store).
    const bound = deps.sessions.get(binding.sessionId);
    const unusable = describeUnusableBoundSession(bound);
    if (unusable !== null && bindingMayRebind(binding)) {
      rolledOverFrom = binding.sessionId;
      logChannelSessionRollover(deps, binding, binding.sessionId, unusable, input);
      // Only worth explaining when there WAS a conversation to lose. A binding
      // whose target merely never existed on this node still gets the notice —
      // that is the restored-backup / re-elected-node case, and it is precisely
      // the one that otherwise looks like unexplained amnesia.
      announceRolloverOnChannel(deps, binding, unusable);
    } else {
      session = bound ?? undefined;
    }
  }
  if (!session) {
    const participant: SharedSessionParticipant = {
      surfaceKind: input.surfaceKind,
      surfaceId: input.surfaceId,
      externalId: input.externalId,
      userId: input.userId,
      displayName: input.displayName,
      routeId: binding?.id,
      lastSeenAt: Date.now(),
    };
    session = await deps.createSession({
      title: input.title,
      // No resurrection: the successor is a NEW record that only NAMES the one
      // it replaced, so the closed session's messages stay its own history.
      metadata: rolledOverFrom === undefined
        ? input.metadata
        : { ...(input.metadata ?? {}), rolledOverFromSessionId: rolledOverFrom },
      routeBinding: binding ?? undefined,
      participant,
    });
    created = true;
  }

  // Closed sessions are history: steer/follow-up/submit against an EXISTING
  // closed record are rejected before mutation; auto-create for a missing session is untouched.
  // A channel binding that landed on a closed record never reaches here — it
  // rolled over above, because no channel sender can act on this error.
  if (session.status === 'closed') throw Object.assign(new Error('Session is closed'), { code: SDKErrorCodes.SESSION_CLOSED, status: 409 });
  const updatedSession = await deps.attachParticipantAndRoute(session, input, binding ?? undefined);
  const userMessage = await deps.appendMessage(updatedSession.id, {
    role: 'user',
    body: input.body,
    surfaceKind: input.surfaceKind,
    surfaceId: input.surfaceId,
    routeId: binding?.id,
    userId: input.userId,
    displayName: input.displayName,
    metadata: {
      ...(input.metadata ?? {}),
      sessionIntent: intent,
    },
  });
  const queuedInput = recordSharedSessionInput(deps.sessionInputStore(), {
    sessionId: updatedSession.id,
    intent,
    message: input,
    routeId: binding?.id,
    causationId: userMessage.id,
    maxPersistedInputs: MAX_PERSISTED_INPUTS,
  });
  deps.publishInputLifecycleEvent('session-input-queued', queuedInput, {
    messageId: userMessage.id,
  });

  const activeAgentId = deps.resolveActiveAgentId(updatedSession);

  // THE LIVE-AGENT HANDOVER, and the third door into starting work.
  //
  // When a session already has a running agent, this branch hands the inbound
  // body straight to it as a `directive`. That is right for the operator typing
  // in their terminal. It was NOT right for a message arriving over a chat
  // surface: every channel adapter converges here through submitMessage, the
  // branch returns `continued-live`, and each adapter early-returns on it —
  // BEFORE the conversation gate that guards their spawn path. So a message
  // that would have been proposed if no agent were running was instead injected
  // as a directive into whatever chain was already running. On a machine with a
  // live terminal session that is every inbound message, which is precisely how
  // "a note over ntfy" turned into a write-review-fix-confirm chain nobody
  // agreed to.
  //
  // The rule is not invented here: `decideContinuationEscalation` already owns
  // it for the sibling continuation runner. Pre-authorized work (an agreed
  // proposal, a schedule, a trigger) and local surfaces hand over; a gated
  // channel surface does not, and falls through to the adapter's gated spawn
  // where the message is answered or proposed.
  const handover = decideContinuationEscalation(
    {
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.surfaceKind ? { surfaceKind: input.surfaceKind } : {}),
      body: input.body,
    },
    deps.conversationGateConfig ? { configReader: deps.conversationGateConfig } : {},
  );
  if (intent !== 'follow-up' && activeAgentId) {
    if (!handover.startsWorkChain) {
      logger.info('Inbound channel message was not handed to the running agent', {
        sessionId: updatedSession.id,
        surfaceKind: input.surfaceKind ?? 'unknown',
        agentId: activeAgentId,
        reason: handover.reason,
        detail: 'the conversation gate decides whether it is answered or proposed',
      });
    }
    // Only the handover is withheld. Every other decision in this block —
    // notably the steer rejection below — keeps its exact previous behavior.
    const sent = handover.startsWorkChain
      && deps.messageSender.send('orchestrator', activeAgentId, input.body, { kind: 'directive' });
    if (sent) {
      const delivered = updateSharedSessionInput(deps.sessionInputStore(), updatedSession.id, queuedInput.id, (entry) => ({
        ...entry,
        state: 'delivered',
        activeAgentId,
        updatedAt: Date.now(),
      })) ?? queuedInput;
      await deps.persist();
      deps.publishInputLifecycleEvent('session-input-delivered', delivered, {
        agentId: activeAgentId,
        messageId: userMessage.id,
      });
      deps.publishUpdate('session-message-forwarded', {
        sessionId: updatedSession.id,
        agentId: activeAgentId,
        messageId: userMessage.id,
        inputId: delivered.id,
        intent,
      });
      // The live-session branch: no new agent is started, so no caller has an
      // agent id to bind a reply to, and every adapter early-returns here.
      // Without this announcement the running agent answers a message that
      // arrived from Telegram/Slack/ntfy and the answer never leaves the
      // daemon — the message is received, the work is done, and the sender
      // sees silence. The binder is idempotent, so an agent that already
      // carries a pending reply keeps the one it has.
      deps.announceSurfaceReply({
        sessionId: updatedSession.id,
        agentId: activeAgentId,
        ...(binding?.id ? { routeId: binding.id } : {}),
        ...(input.surfaceKind ? { surfaceKind: input.surfaceKind } : {}),
        task: input.body,
        reason: 'continued-live',
      });
      return {
        session: deps.sessions.get(updatedSession.id)!,
        userMessage,
        routeBinding: binding ?? undefined,
        input: delivered,
        intent,
        mode: 'continued-live',
        state: delivered.state,
        activeAgentId,
        created,
      };
    }
    if (intent === 'steer' && !allowSpawnFallback) {
      const rejected = updateSharedSessionInput(deps.sessionInputStore(), updatedSession.id, queuedInput.id, (entry) => ({
        ...entry,
        state: 'rejected',
        updatedAt: Date.now(),
        error: 'No active agent accepted the steer request.',
      })) ?? queuedInput;
      await deps.persist();
      deps.publishInputLifecycleEvent('session-input-rejected', rejected, {
        messageId: userMessage.id,
      });
      return {
        session: deps.sessions.get(updatedSession.id)!,
        userMessage,
        routeBinding: binding ?? undefined,
        input: rejected,
        intent,
        mode: 'rejected',
        state: rejected.state,
        created,
      };
    }
  }

  if (intent === 'follow-up' && activeAgentId) {
    await deps.persist();
    deps.publishInputLifecycleEvent('session-follow-up-queued', queuedInput, {
      agentId: activeAgentId,
      messageId: userMessage.id,
    });
    return {
      session: deps.sessions.get(updatedSession.id)!,
      userMessage,
      routeBinding: binding ?? undefined,
      input: queuedInput,
      intent,
      mode: 'queued-follow-up',
      state: queuedInput.state,
      activeAgentId,
      created,
    };
  }

  // Surface routing: a steer/follow-up with a LIVE surface participant (other than the
  // sender) queues for that surface (sessions.inputs.list/deliver); no live surface keeps the executor path below.
  if (
    (intent === 'steer' || intent === 'follow-up') &&
    shouldRouteInputToSurface(updatedSession, Date.now(), SURFACE_ROUTE_FRESHNESS_MS, { surfaceId: input.surfaceId })
  ) {
    await deps.persist();
    deps.publishInputLifecycleEvent('session-input-queued-for-surface', queuedInput, {
      messageId: userMessage.id,
    });
    return {
      session: deps.sessions.get(updatedSession.id)!,
      userMessage,
      routeBinding: binding ?? undefined,
      input: queuedInput,
      intent,
      mode: 'queued-for-surface',
      state: queuedInput.state,
      created,
    };
  }

  await deps.persist();
  return {
    session: deps.sessions.get(updatedSession.id)!,
    userMessage,
    routeBinding: binding ?? undefined,
    input: queuedInput,
    intent,
    mode: 'spawn',
    state: queuedInput.state,
    task: deps.buildContinuationTask(updatedSession.id),
    created,
  };
}
