import { randomUUID } from 'node:crypto';
import type { SubmitSharedSessionMessageInput } from './session-types.js';
import type { SharedSessionInputIntent, SharedSessionInputRecord } from './session-intents.js';
import type { SharedSessionRecord } from './session-types.js';
import { countPendingSessionInputs, sortInputs } from './session-broker-state.js';

export interface SharedSessionInputStore {
  readonly sessions: Map<string, SharedSessionRecord>;
  readonly inputs: Map<string, SharedSessionInputRecord[]>;
}

export function touchSharedSession(store: SharedSessionInputStore, sessionId: string): void {
  const session = store.sessions.get(sessionId);
  if (!session) return;
  const now = Date.now();
  store.sessions.set(sessionId, { ...session, lastActivityAt: now, updatedAt: now });
}

export function refreshPendingInputCount(store: SharedSessionInputStore, sessionId: string): void {
  const session = store.sessions.get(sessionId);
  if (!session) return;
  const pendingInputCount = countPendingSessionInputs(store.inputs.get(sessionId) ?? []);
  store.sessions.set(sessionId, {
    ...session,
    pendingInputCount,
    updatedAt: Date.now(),
  });
}

export function recordSharedSessionInput(
  store: SharedSessionInputStore,
  input: {
    readonly sessionId: string;
    readonly intent: SharedSessionInputIntent;
    readonly message: SubmitSharedSessionMessageInput;
    readonly routeId?: string;
    readonly causationId?: string;
    readonly maxPersistedInputs: number;
  },
): SharedSessionInputRecord {
  touchSharedSession(store, input.sessionId);
  const id = `sin-${randomUUID().slice(0, 8)}`;
  const entry: SharedSessionInputRecord = {
    id,
    sessionId: input.sessionId,
    intent: input.intent,
    state: 'queued',
    correlationId: typeof input.message.metadata?.correlationId === 'string'
      ? input.message.metadata.correlationId
      : `session-input:${id}`,
    ...(input.causationId ? { causationId: input.causationId } : {}),
    body: input.message.body,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    routeId: input.routeId,
    surfaceKind: input.message.surfaceKind,
    surfaceId: input.message.surfaceId,
    externalId: input.message.externalId,
    threadId: input.message.threadId,
    userId: input.message.userId,
    displayName: input.message.displayName,
    metadata: input.message.metadata ?? {},
    routing: input.message.routing,
  };
  const bucket = store.inputs.get(input.sessionId) ?? [];
  bucket.push(entry);
  const sorted = sortInputs(bucket);
  if (sorted.length > input.maxPersistedInputs) {
    sorted.splice(0, sorted.length - input.maxPersistedInputs);
  }
  store.inputs.set(input.sessionId, sorted);
  refreshPendingInputCount(store, input.sessionId);
  return entry;
}

export function updateSharedSessionInput(
  store: SharedSessionInputStore,
  sessionId: string,
  inputId: string,
  transform: (input: SharedSessionInputRecord) => SharedSessionInputRecord,
): SharedSessionInputRecord | null {
  const bucket = store.inputs.get(sessionId);
  if (!bucket) return null;
  const index = bucket.findIndex((entry) => entry.id === inputId);
  if (index < 0) return null;
  const updated = transform(bucket[index]);
  bucket[index] = updated;
  store.inputs.set(sessionId, bucket);
  refreshPendingInputCount(store, sessionId);
  touchSharedSession(store, sessionId);
  return updated;
}

export function claimNextQueuedSessionInput(
  store: SharedSessionInputStore,
  sessionId: string,
  agentId: string,
): SharedSessionInputRecord | null {
  const bucket = store.inputs.get(sessionId) ?? [];
  const next = bucket.find((entry) => entry.state === 'queued');
  if (!next) return null;
  const result = updateSharedSessionInput(store, sessionId, next.id, (entry) => ({
    ...entry,
    state: 'spawned',
    activeAgentId: agentId,
    updatedAt: Date.now(),
  }));
  touchSharedSession(store, sessionId);
  return result;
}

export function finalizeAgentSessionInputs(
  store: SharedSessionInputStore,
  sessionId: string,
  agentId: string,
  nextState: Extract<SharedSessionInputRecord['state'], 'completed' | 'failed' | 'cancelled'>,
  error?: string,
): SharedSessionInputRecord[] {
  const bucket = store.inputs.get(sessionId);
  if (!bucket) return [];
  touchSharedSession(store, sessionId);
  let changed = false;
  const updatedInputs: SharedSessionInputRecord[] = [];
  for (let index = 0; index < bucket.length; index += 1) {
    const entry = bucket[index];
    if (entry.activeAgentId !== agentId) continue;
    if (entry.state !== 'delivered' && entry.state !== 'spawned') continue;
    bucket[index] = {
      ...entry,
      state: nextState,
      updatedAt: Date.now(),
      ...(error ? { error } : {}),
    };
    updatedInputs.push(bucket[index]!);
    changed = true;
  }
  if (changed) {
    store.inputs.set(sessionId, bucket);
    refreshPendingInputCount(store, sessionId);
  }
  return updatedInputs;
}
