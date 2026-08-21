import { randomUUID } from 'node:crypto';
import type { SubmitSharedSessionMessageInput } from './session-types.js';
import type { SharedSessionInputIntent, SharedSessionInputRecord, SharedSessionSurfaceReplyBinding } from './session-intents.js';
import type { SharedSessionRecord } from './session-types.js';
import { countPendingSessionInputs, sortInputs } from './session-broker-state.js';
import { bindSharedSessionAgent } from './session-broker-sessions.js';

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
    readonly routeId?: string | undefined;
    readonly causationId?: string | undefined;
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
  const updated = transform(bucket[index]!);
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

/**
 * Collection read for a live surface: filter a session's inputs by state and/or a
 * `since` cursor (createdAt, exclusive), oldest-first, capped to `limit`. With
 * `state: 'queued'` + the last-seen cursor this yields exactly the PENDING inputs
 * a surface has not collected yet (see SharedSessionBroker.getInputsSince).
 */
export function filterSessionInputsSince(
  bucket: readonly SharedSessionInputRecord[],
  options: { readonly state?: SharedSessionInputRecord['state'] | undefined; readonly since?: number | undefined; readonly limit?: number | undefined },
): SharedSessionInputRecord[] {
  const filtered = bucket.filter((entry) => {
    if (options.state !== undefined && entry.state !== options.state) return false;
    if (options.since !== undefined && entry.createdAt <= options.since) return false;
    return true;
  });
  return filtered.slice(-Math.max(1, options.limit ?? 100));
}

/**
 * Surface delivery marking: advance a queued/delivered input as a live surface
 * collects it (`consumed:false` → 'delivered') or finishes acting on it
 * (`consumed:true` → 'completed'). Only queued/delivered inputs advance; anything
 * else is returned unchanged. Returns null when the input is unknown.
 */
export function markSurfaceInputDelivered(
  store: SharedSessionInputStore,
  sessionId: string,
  inputId: string,
  consumed: boolean,
): SharedSessionInputRecord | null {
  return updateSharedSessionInput(store, sessionId, inputId, (entry) => {
    if (consumed) {
      if (entry.state !== 'queued' && entry.state !== 'delivered') return entry;
      return { ...entry, state: 'completed', updatedAt: Date.now() };
    }
    if (entry.state !== 'queued') return entry;
    return { ...entry, state: 'delivered', updatedAt: Date.now() };
  });
}

/**
 * Apply a live surface's report about a queued input: it collected the input
 * (`consumed:false`), or finished acting on it (`consumed:true`), and, when it
 * names one, the agent that is answering it.
 *
 * The agent pairing is the half that routes an answer home. The daemon's own
 * spawn takes `bindAgent`, which claims whatever input is NEXT in the queue for
 * the agent it just started; a surface has already named the exact input, so
 * this stamps that one, makes the agent the session's active agent, and
 * announces the reply binding. The announcement is the whole point: without it
 * a message that arrived over a channel and was dispatched to a surface was
 * answered into nothing. Idempotent, a repeated report re-announces, and the
 * binder is required to be idempotent for exactly that reason.
 */
export function applySurfaceInputDelivery(
  store: SharedSessionInputStore,
  sessionId: string,
  inputId: string,
  options: { readonly consumed?: boolean | undefined; readonly agentId?: string | undefined },
  hooks: {
    readonly publish: (event: string, payload: unknown) => void;
    readonly publishInput: (event: string, input: SharedSessionInputRecord, extra: Record<string, unknown>) => void;
    readonly announce: (binding: SharedSessionSurfaceReplyBinding) => void;
  },
): SharedSessionInputRecord | null {
  const consumed = options.consumed === true;
  const updated = markSurfaceInputDelivered(store, sessionId, inputId, consumed);
  if (!updated) return null;
  const agentId = options.agentId?.trim();
  let record = updated;
  if (agentId) {
    const session = store.sessions.get(sessionId);
    if (session) {
      const rebound = bindSharedSessionAgent(session, agentId);
      store.sessions.set(sessionId, rebound);
      hooks.publish('session-agent-bound', rebound);
    }
    record = updateSharedSessionInput(store, sessionId, inputId, (entry) => ({
      ...entry, activeAgentId: agentId, updatedAt: Date.now(),
    })) ?? updated;
    hooks.announce({
      sessionId,
      agentId,
      ...(record.routeId ? { routeId: record.routeId } : {}),
      ...(record.surfaceKind ? { surfaceKind: record.surfaceKind } : {}),
      task: record.body,
      reason: 'continuation-runner',
    });
  }
  refreshPendingInputCount(store, sessionId);
  hooks.publishInput(consumed ? 'session-input-completed' : 'session-input-delivered', record, agentId ? { agentId } : {});
  return record;
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
    const entry = bucket[index]!;
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
