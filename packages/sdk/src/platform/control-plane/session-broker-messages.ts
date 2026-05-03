import { randomUUID } from 'node:crypto';
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
  readonly surfaceKind?: SharedSessionMessage['surfaceKind'];
  readonly surfaceId?: string;
  readonly routeId?: string;
  readonly agentId?: string;
  readonly userId?: string;
  readonly displayName?: string;
  readonly metadata?: Record<string, unknown>;
}

export function listSharedSessionMessages(
  store: SharedSessionMessageStore,
  sessionId: string,
  limit = 100,
): SharedSessionMessage[] {
  const bucket = store.messages.get(sessionId) ?? [];
  return bucket.slice(-Math.max(1, limit));
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
