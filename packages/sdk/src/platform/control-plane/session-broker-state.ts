import {
  SHARED_SESSION_INPUT_INTENTS,
  SHARED_SESSION_INPUT_STATES,
  type SharedSessionInputRecord,
} from './session-intents.js';
import type { SharedSessionStoreSnapshot } from './session-broker-helpers.js';
import type { SharedSessionMessage, SharedSessionParticipant, SharedSessionRecord } from './session-types.js';

const SESSION_KINDS = new Set<SharedSessionRecord['kind']>(['tui', 'companion-task', 'companion-chat']);
const SESSION_STATUSES = new Set<SharedSessionRecord['status']>(['active', 'closed']);
const MESSAGE_ROLES = new Set<SharedSessionMessage['role']>(['user', 'assistant', 'system']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function throwInvalidSessionSnapshot(): never {
  throw new Error('Shared session store snapshot is invalid.');
}

function validateOptionalString(value: unknown): void {
  if (value !== undefined && typeof value !== 'string') throwInvalidSessionSnapshot();
}

function validateOptionalNumber(value: unknown): void {
  if (value !== undefined && !isFiniteNumber(value)) throwInvalidSessionSnapshot();
}

function validateSessionParticipant(value: unknown): void {
  if (
    !isRecord(value)
    || typeof value['surfaceKind'] !== 'string'
    || typeof value['surfaceId'] !== 'string'
    || !isFiniteNumber(value['lastSeenAt'])
  ) {
    throwInvalidSessionSnapshot();
  }
  validateOptionalString(value['externalId']);
  validateOptionalString(value['userId']);
  validateOptionalString(value['displayName']);
  validateOptionalString(value['routeId']);
}

function validateSessionRecord(value: unknown): void {
  if (
    !isRecord(value)
    || typeof value['id'] !== 'string'
    || typeof value['kind'] !== 'string'
    || !SESSION_KINDS.has(value['kind'] as SharedSessionRecord['kind'])
    || typeof value['title'] !== 'string'
    || typeof value['status'] !== 'string'
    || !SESSION_STATUSES.has(value['status'] as SharedSessionRecord['status'])
    || !isFiniteNumber(value['createdAt'])
    || !isFiniteNumber(value['updatedAt'])
    || !isFiniteNumber(value['lastActivityAt'])
    || !isFiniteNumber(value['messageCount'])
    || !isFiniteNumber(value['pendingInputCount'])
    || !isStringArray(value['routeIds'])
    || !isStringArray(value['surfaceKinds'])
    || !Array.isArray(value['participants'])
    || !isRecord(value['metadata'])
  ) {
    throwInvalidSessionSnapshot();
  }
  validateOptionalNumber(value['lastMessageAt']);
  validateOptionalNumber(value['closedAt']);
  validateOptionalString(value['activeAgentId']);
  validateOptionalString(value['lastAgentId']);
  validateOptionalString(value['lastError']);
  for (const participant of value['participants']) validateSessionParticipant(participant);
}

function validateSessionMessage(value: unknown): void {
  if (
    !isRecord(value)
    || typeof value['id'] !== 'string'
    || typeof value['sessionId'] !== 'string'
    || typeof value['role'] !== 'string'
    || !MESSAGE_ROLES.has(value['role'] as SharedSessionMessage['role'])
    || typeof value['body'] !== 'string'
    || !isFiniteNumber(value['createdAt'])
    || !isRecord(value['metadata'])
  ) {
    throwInvalidSessionSnapshot();
  }
  validateOptionalString(value['surfaceKind']);
  validateOptionalString(value['surfaceId']);
  validateOptionalString(value['routeId']);
  validateOptionalString(value['agentId']);
  validateOptionalString(value['userId']);
  validateOptionalString(value['displayName']);
}

function validateSessionInput(value: unknown): void {
  if (
    !isRecord(value)
    || typeof value['id'] !== 'string'
    || typeof value['sessionId'] !== 'string'
    || typeof value['intent'] !== 'string'
    || !SHARED_SESSION_INPUT_INTENTS.includes(value['intent'] as SharedSessionInputRecord['intent'])
    || typeof value['state'] !== 'string'
    || !SHARED_SESSION_INPUT_STATES.includes(value['state'] as SharedSessionInputRecord['state'])
    || typeof value['correlationId'] !== 'string'
    || typeof value['body'] !== 'string'
    || !isFiniteNumber(value['createdAt'])
    || !isFiniteNumber(value['updatedAt'])
    || !isRecord(value['metadata'])
  ) {
    throwInvalidSessionSnapshot();
  }
  validateOptionalString(value['causationId']);
  validateOptionalString(value['routeId']);
  validateOptionalString(value['surfaceKind']);
  validateOptionalString(value['surfaceId']);
  validateOptionalString(value['externalId']);
  validateOptionalString(value['threadId']);
  validateOptionalString(value['userId']);
  validateOptionalString(value['displayName']);
  validateOptionalString(value['activeAgentId']);
  validateOptionalString(value['error']);
  if (value['routing'] !== undefined && !isRecord(value['routing'])) throwInvalidSessionSnapshot();
}

export function sortSessions(records: Iterable<SharedSessionRecord>): SharedSessionRecord[] {
  return [...records].sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
}

export function sortMessages(records: Iterable<SharedSessionMessage>): SharedSessionMessage[] {
  return [...records].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function sortInputs(records: Iterable<SharedSessionInputRecord>): SharedSessionInputRecord[] {
  return [...records].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function loadSessionBrokerState(snapshot: SharedSessionStoreSnapshot | null | undefined): {
  readonly sessions: Map<string, SharedSessionRecord>;
  readonly messages: Map<string, SharedSessionMessage[]>;
  readonly inputs: Map<string, SharedSessionInputRecord[]>;
} {
  if (snapshot) {
    if (!isRecord(snapshot) || !Array.isArray(snapshot.sessions) || !Array.isArray(snapshot.messages) || !Array.isArray(snapshot.inputs)) {
      throwInvalidSessionSnapshot();
    }
    for (const session of snapshot.sessions) validateSessionRecord(session);
    for (const message of snapshot.messages) validateSessionMessage(message);
    for (const input of snapshot.inputs) validateSessionInput(input);
  }
  const sessions = new Map<string, SharedSessionRecord>();
  const messages = new Map<string, SharedSessionMessage[]>();
  const inputs = new Map<string, SharedSessionInputRecord[]>();
  for (const session of snapshot?.sessions ?? []) {
    sessions.set(session.id, session);
  }
  for (const message of snapshot?.messages ?? []) {
    const bucket = messages.get(message.sessionId) ?? [];
    bucket.push(message);
    messages.set(message.sessionId, bucket);
  }
  for (const input of snapshot?.inputs ?? []) {
    const bucket = inputs.get(input.sessionId) ?? [];
    bucket.push(input);
    inputs.set(input.sessionId, bucket);
  }
  for (const [sessionId, bucket] of messages.entries()) {
    messages.set(sessionId, sortMessages(bucket));
  }
  for (const [sessionId, bucket] of inputs.entries()) {
    inputs.set(sessionId, sortInputs(bucket));
  }
  return { sessions, messages, inputs };
}

export function createSessionBrokerSnapshot(
  state: {
    readonly sessions: ReadonlyMap<string, SharedSessionRecord>;
    readonly messages: ReadonlyMap<string, readonly SharedSessionMessage[]>;
    readonly inputs: ReadonlyMap<string, readonly SharedSessionInputRecord[]>;
  },
  maxPersistedMessages: number,
): SharedSessionStoreSnapshot {
  const messages = [...state.messages.values()].flatMap((bucket) => bucket);
  const inputs = [...state.inputs.values()].flatMap((bucket) => bucket);
  return {
    sessions: sortSessions(state.sessions.values()),
    messages: sortMessages(messages).slice(-maxPersistedMessages),
    inputs: sortInputs(inputs),
  };
}

export function upsertSessionParticipant(
  participants: readonly SharedSessionParticipant[],
  participant: SharedSessionParticipant,
): SharedSessionParticipant[] {
  const participantId = buildSessionParticipantId(participant);
  return [
    ...participants.filter((existing) => buildSessionParticipantId(existing) !== participantId),
    participant,
  ];
}

export function countPendingSessionInputs(records: readonly SharedSessionInputRecord[]): number {
  return records.filter((entry) =>
    entry.state === 'queued' || entry.state === 'delivered' || entry.state === 'spawned'
  ).length;
}

function buildSessionParticipantId(participant: SharedSessionParticipant): string {
  return `${participant.surfaceKind}:${participant.surfaceId}:${participant.externalId ?? ''}:${participant.userId ?? ''}`;
}
