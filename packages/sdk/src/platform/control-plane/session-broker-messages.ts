import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type {
  SharedSessionMessage,
  SharedSessionMessageRole,
  SharedSessionRecord,
} from './session-types.js';

export interface SharedSessionMessageStore {
  readonly sessions: Map<string, SharedSessionRecord>;
  readonly messages: Map<string, SharedSessionMessage[]>;
}

export interface AppendSharedSessionMessageInput {
  readonly sessionId: string;
  readonly role: SharedSessionMessageRole;
  readonly body: string;
  readonly surfaceKind?: SharedSessionMessage['surfaceKind'] | undefined;
  readonly surfaceId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly userId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export function listSharedSessionMessages(
  store: SharedSessionMessageStore,
  sessionId: string,
  limit = 100,
): SharedSessionMessage[] {
  const bucket = store.messages.get(sessionId) ?? [];
  return bucket.slice(-Math.max(1, limit));
}

/**
 * The stored completion message for `agentId` in this session, if one exists.
 *
 * An agent finishes ONCE, but more than one path reports that it finished: the
 * runtime event bus writes the terminal AGENT_COMPLETED / AGENT_FAILED /
 * AGENT_CANCELLED payload, and the daemon's pending-surface-reply poller writes
 * the same agent's rendered answer when it observes the finished record. Both
 * call the broker's completeAgent, so a conversation stored every assistant
 * reply twice, and because the next turn's prompt is built from that
 * transcript, the model was shown every one of its own answers twice.
 *
 * Matching is by agent id plus the presence of a terminal `status` in the
 * message metadata, which only the completion path writes. Reading it back off
 * the stored bucket rather than an in-memory set means a restart mid-flight
 * cannot lose the fact that the agent already reported.
 */
export function findAgentCompletionMessage(
  store: SharedSessionMessageStore,
  sessionId: string,
  agentId: string,
): SharedSessionMessage | undefined {
  const bucket = store.messages.get(sessionId);
  if (!bucket) return undefined;
  for (let index = bucket.length - 1; index >= 0; index -= 1) {
    const message = bucket[index]!;
    if (message.agentId !== agentId) continue;
    if (typeof message.metadata?.status === 'string') return message;
  }
  return undefined;
}

/**
 * Whether this agent's completion still needs storing, or whether another
 * reporter already stored it. Logs the skip so a missing second row is
 * explained rather than mysterious.
 */
export function shouldStoreAgentCompletion(
  store: SharedSessionMessageStore,
  sessionId: string,
  agentId: string,
): boolean {
  const existing = findAgentCompletionMessage(store, sessionId, agentId);
  if (!existing) return true;
  logger.debug('[SharedSessionBroker] agent already reported; not storing its completion twice', {
    sessionId,
    agentId,
    storedMessageId: existing.id,
  });
  return false;
}

export function appendSharedSessionMessage(
  store: SharedSessionMessageStore,
  input: AppendSharedSessionMessageInput,
  maxPersistedMessages: number,
): SharedSessionMessage {
  const message: SharedSessionMessage = {
    id: `smsg-${randomUUID().slice(0, 8)}`,
    sessionId: input.sessionId,
    role: input.role,
    body: input.body,
    createdAt: Date.now(),
    surfaceKind: input.surfaceKind,
    surfaceId: input.surfaceId,
    routeId: input.routeId,
    agentId: input.agentId,
    userId: input.userId,
    displayName: input.displayName,
    metadata: input.metadata ?? {},
  };
  const bucket = store.messages.get(input.sessionId) ?? [];
  bucket.push(message);
  while (bucket.length > maxPersistedMessages) {
    bucket.shift();
  }
  store.messages.set(input.sessionId, bucket);
  const session = store.sessions.get(input.sessionId);
  if (session) {
    store.sessions.set(input.sessionId, {
      ...session,
      messageCount: bucket.length,
      lastMessageAt: message.createdAt,
      updatedAt: message.createdAt,
      lastActivityAt: message.createdAt,
    });
  }
  return message;
}

export function buildSharedSessionContinuationTask(input: {
  readonly session: SharedSessionRecord | null;
  readonly messages: readonly SharedSessionMessage[];
  readonly fallbackSessionId: string;
}): string {
  const transcript = input.messages
    .map((message) => {
      const speaker = message.role === 'assistant'
        ? 'Assistant'
        : message.role === 'system'
          ? 'System'
          : `${message.displayName ?? message.userId ?? 'User'}`;
      return `${speaker}: ${message.body}`;
    })
    .join('\n\n');
  return [
    `Continue the shared control-plane session "${input.session?.title ?? input.fallbackSessionId}".`,
    'Preserve continuity with the recent transcript and answer the newest user message directly.',
    transcript ? `Recent transcript:\n${transcript}` : '',
  ].filter(Boolean).join('\n\n');
}
