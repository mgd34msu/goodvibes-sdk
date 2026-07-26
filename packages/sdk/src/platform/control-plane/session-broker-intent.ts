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
  buildContinuationTask(sessionId: string): string;
}

export async function handleSharedSessionIntent(
  deps: HandleSharedSessionIntentDeps,
  intent: SharedSessionInputIntent,
  input: SubmitSharedSessionMessageInput,
  allowSpawnFallback: boolean,
): Promise<SharedSessionSubmission> {
  await deps.start();

  const binding = await deps.resolveBinding(input);
  let session = input.sessionId ? deps.sessions.get(input.sessionId) ?? undefined : undefined;
  let created = false;
  if (!session && binding?.sessionId) {
    session = deps.sessions.get(binding.sessionId) ?? undefined;
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
      metadata: input.metadata,
      routeBinding: binding ?? undefined,
      participant,
    });
    created = true;
  }

  // Closed sessions are history: steer/follow-up/submit against an EXISTING
  // closed record are rejected before mutation; auto-create for a missing session is untouched.
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
  if (intent !== 'follow-up' && activeAgentId) {
    const sent = deps.messageSender.send('orchestrator', activeAgentId, input.body, { kind: 'directive' });
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
