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

function hasSessionRecordPayload(value: Record<string, unknown>): boolean {
  return [
    'kind',
    'title',
    'status',
    'createdAt',
    'updatedAt',
    'lastActivityAt',
    'messageCount',
    'pendingInputCount',
    'lastMessageAt',
    'closedAt',
    'activeAgentId',
    'lastAgentId',
    'lastError',
    'routeIds',
    'surfaceKinds',
    'participants',
    'metadata',
  ].some((key) => value[key] !== undefined);
}

function normalizeSessionParticipant(value: unknown): SharedSessionParticipant {
  if (
    !isRecord(value)
    || typeof value['surfaceKind'] !== 'string'
    || typeof value['surfaceId'] !== 'string'
  ) {
    throwInvalidSessionSnapshot();
  }
  const lastSeenAt = isFiniteNumber(value['lastSeenAt']) ? value['lastSeenAt'] : Date.now();
  const externalId = typeof value['externalId'] === 'string' ? value['externalId'] : undefined;
  const userId = typeof value['userId'] === 'string' ? value['userId'] : undefined;
  const displayName = typeof value['displayName'] === 'string' ? value['displayName'] : undefined;
  const routeId = typeof value['routeId'] === 'string' ? value['routeId'] : undefined;
  return {
    surfaceKind: value['surfaceKind'] as SharedSessionParticipant['surfaceKind'],
    surfaceId: value['surfaceId'],
    ...(externalId ? { externalId } : {}),
    ...(userId ? { userId } : {}),
    ...(displayName ? { displayName } : {}),
    ...(routeId ? { routeId } : {}),
    lastSeenAt,
  };
}

function normalizeSessionRecord(
  value: unknown,
  messages: readonly SharedSessionMessage[],
  inputs: readonly SharedSessionInputRecord[],
): SharedSessionRecord {
  if (
    !isRecord(value)
    || typeof value['id'] !== 'string'
    || !hasSessionRecordPayload(value)
  ) {
    throwInvalidSessionSnapshot();
  }
  if (value['kind'] !== undefined && (typeof value['kind'] !== 'string' || !SESSION_KINDS.has(value['kind'] as SharedSessionRecord['kind']))) {
    throwInvalidSessionSnapshot();
  }
  if (value['status'] !== undefined && (typeof value['status'] !== 'string' || !SESSION_STATUSES.has(value['status'] as SharedSessionRecord['status']))) {
    throwInvalidSessionSnapshot();
  }
  validateOptionalNumber(value['createdAt']);
  validateOptionalNumber(value['updatedAt']);
  validateOptionalNumber(value['lastActivityAt']);
  validateOptionalNumber(value['messageCount']);
  validateOptionalNumber(value['pendingInputCount']);
  validateOptionalNumber(value['lastMessageAt']);
  validateOptionalNumber(value['closedAt']);
  validateOptionalString(value['activeAgentId']);
  validateOptionalString(value['lastAgentId']);
  validateOptionalString(value['lastError']);
  if (value['routeIds'] !== undefined && !isStringArray(value['routeIds'])) throwInvalidSessionSnapshot();
  if (value['surfaceKinds'] !== undefined && !isStringArray(value['surfaceKinds'])) throwInvalidSessionSnapshot();
  if (value['participants'] !== undefined && !Array.isArray(value['participants'])) throwInvalidSessionSnapshot();
  if (value['metadata'] !== undefined && !isRecord(value['metadata'])) throwInvalidSessionSnapshot();

  const now = Date.now();
  const id = value['id'];
  const participants = (value['participants'] ?? []).map(normalizeSessionParticipant);
  const routeIds = isStringArray(value['routeIds']) ? [...new Set(value['routeIds'])] : [];
  const surfaceKinds = isStringArray(value['surfaceKinds'])
    ? [...new Set(value['surfaceKinds'])] as SharedSessionRecord['surfaceKinds']
    : [...new Set(participants.map((participant) => participant.surfaceKind))];
  const latestMessageAt = messages.reduce<number | undefined>(
    (latest, message) => latest === undefined || message.createdAt > latest ? message.createdAt : latest,
    undefined,
  );
  const latestInputAt = inputs.reduce<number | undefined>(
    (latest, input) => latest === undefined || input.updatedAt > latest ? input.updatedAt : latest,
    undefined,
  );
  const createdAt = isFiniteNumber(value['createdAt'])
    ? value['createdAt']
    : isFiniteNumber(value['updatedAt'])
      ? value['updatedAt']
      : now;
  const updatedAt = isFiniteNumber(value['updatedAt']) ? value['updatedAt'] : createdAt;
  const lastMessageAt = isFiniteNumber(value['lastMessageAt']) ? value['lastMessageAt'] : latestMessageAt;
  const lastActivityAt = isFiniteNumber(value['lastActivityAt'])
    ? value['lastActivityAt']
    : Math.max(updatedAt, lastMessageAt ?? 0, latestInputAt ?? 0);
  const activeAgentId = typeof value['activeAgentId'] === 'string' ? value['activeAgentId'] : undefined;
  const lastAgentId = typeof value['lastAgentId'] === 'string' ? value['lastAgentId'] : undefined;
  const lastError = typeof value['lastError'] === 'string' ? value['lastError'] : undefined;
  const closedAt = isFiniteNumber(value['closedAt']) ? value['closedAt'] : undefined;
  return {
    id,
    kind: typeof value['kind'] === 'string' && SESSION_KINDS.has(value['kind'] as SharedSessionRecord['kind'])
      ? value['kind'] as SharedSessionRecord['kind']
      : 'tui',
    title: typeof value['title'] === 'string' && value['title'].trim().length > 0 ? value['title'] : `Session ${id}`,
    status: typeof value['status'] === 'string' && SESSION_STATUSES.has(value['status'] as SharedSessionRecord['status'])
      ? value['status'] as SharedSessionRecord['status']
      : 'active',
    createdAt,
    updatedAt,
    ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
    ...(closedAt !== undefined ? { closedAt } : {}),
    lastActivityAt,
    messageCount: Math.max(isFiniteNumber(value['messageCount']) ? value['messageCount'] : 0, messages.length),
    pendingInputCount: Math.max(isFiniteNumber(value['pendingInputCount']) ? value['pendingInputCount'] : 0, countPendingSessionInputs(inputs)),
    routeIds,
    surfaceKinds,
    participants,
    ...(activeAgentId ? { activeAgentId } : {}),
    ...(lastAgentId ? { lastAgentId } : {}),
    ...(lastError ? { lastError } : {}),
    metadata: isRecord(value['metadata']) ? value['metadata'] : {},
  };
}

function normalizeSessionMessage(value: unknown): SharedSessionMessage {
  if (
    !isRecord(value)
    || typeof value['id'] !== 'string'
    || typeof value['sessionId'] !== 'string'
    || typeof value['role'] !== 'string'
    || !MESSAGE_ROLES.has(value['role'] as SharedSessionMessage['role'])
    || typeof value['body'] !== 'string'
    || !isFiniteNumber(value['createdAt'])
  ) {
    throwInvalidSessionSnapshot();
  }
  if (value['metadata'] !== undefined && !isRecord(value['metadata'])) throwInvalidSessionSnapshot();
  validateOptionalString(value['surfaceKind']);
  validateOptionalString(value['surfaceId']);
  validateOptionalString(value['routeId']);
  validateOptionalString(value['agentId']);
  validateOptionalString(value['userId']);
  validateOptionalString(value['displayName']);
  const surfaceKind = typeof value['surfaceKind'] === 'string' ? value['surfaceKind'] as SharedSessionMessage['surfaceKind'] : undefined;
  const surfaceId = typeof value['surfaceId'] === 'string' ? value['surfaceId'] : undefined;
  const routeId = typeof value['routeId'] === 'string' ? value['routeId'] : undefined;
  const agentId = typeof value['agentId'] === 'string' ? value['agentId'] : undefined;
  const userId = typeof value['userId'] === 'string' ? value['userId'] : undefined;
  const displayName = typeof value['displayName'] === 'string' ? value['displayName'] : undefined;
  return {
    id: value['id'],
    sessionId: value['sessionId'],
    role: value['role'] as SharedSessionMessage['role'],
    body: value['body'],
    createdAt: value['createdAt'],
    ...(surfaceKind ? { surfaceKind } : {}),
    ...(surfaceId ? { surfaceId } : {}),
    ...(routeId ? { routeId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(userId ? { userId } : {}),
    ...(displayName ? { displayName } : {}),
    metadata: isRecord(value['metadata']) ? value['metadata'] : {},
  };
}

function normalizeSessionInput(value: unknown): SharedSessionInputRecord {
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
  ) {
    throwInvalidSessionSnapshot();
  }
  if (value['metadata'] !== undefined && !isRecord(value['metadata'])) throwInvalidSessionSnapshot();
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
  const causationId = typeof value['causationId'] === 'string' ? value['causationId'] : undefined;
  const routeId = typeof value['routeId'] === 'string' ? value['routeId'] : undefined;
  const surfaceKind = typeof value['surfaceKind'] === 'string' ? value['surfaceKind'] as SharedSessionInputRecord['surfaceKind'] : undefined;
  const surfaceId = typeof value['surfaceId'] === 'string' ? value['surfaceId'] : undefined;
  const externalId = typeof value['externalId'] === 'string' ? value['externalId'] : undefined;
  const threadId = typeof value['threadId'] === 'string' ? value['threadId'] : undefined;
  const userId = typeof value['userId'] === 'string' ? value['userId'] : undefined;
  const displayName = typeof value['displayName'] === 'string' ? value['displayName'] : undefined;
  const activeAgentId = typeof value['activeAgentId'] === 'string' ? value['activeAgentId'] : undefined;
  const error = typeof value['error'] === 'string' ? value['error'] : undefined;
  return {
    id: value['id'],
    sessionId: value['sessionId'],
    intent: value['intent'] as SharedSessionInputRecord['intent'],
    state: value['state'] as SharedSessionInputRecord['state'],
    correlationId: value['correlationId'],
    ...(causationId ? { causationId } : {}),
    body: value['body'],
    createdAt: value['createdAt'],
    updatedAt: value['updatedAt'],
    ...(routeId ? { routeId } : {}),
    ...(surfaceKind ? { surfaceKind } : {}),
    ...(surfaceId ? { surfaceId } : {}),
    ...(externalId ? { externalId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(userId ? { userId } : {}),
    ...(displayName ? { displayName } : {}),
    ...(activeAgentId ? { activeAgentId } : {}),
    metadata: isRecord(value['metadata']) ? value['metadata'] : {},
    ...(isRecord(value['routing']) ? { routing: value['routing'] as SharedSessionInputRecord['routing'] } : {}),
    ...(error ? { error } : {}),
  };
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
  }
  const sessions = new Map<string, SharedSessionRecord>();
  const messages = new Map<string, SharedSessionMessage[]>();
  const inputs = new Map<string, SharedSessionInputRecord[]>();
  for (const message of snapshot?.messages ?? []) {
    const normalized = normalizeSessionMessage(message);
    const bucket = messages.get(normalized.sessionId) ?? [];
    bucket.push(normalized);
    messages.set(normalized.sessionId, bucket);
  }
  for (const input of snapshot?.inputs ?? []) {
    const normalized = normalizeSessionInput(input);
    const bucket = inputs.get(normalized.sessionId) ?? [];
    bucket.push(normalized);
    inputs.set(normalized.sessionId, bucket);
  }
  for (const [sessionId, bucket] of messages.entries()) {
    messages.set(sessionId, sortMessages(bucket));
  }
  for (const [sessionId, bucket] of inputs.entries()) {
    inputs.set(sessionId, sortInputs(bucket));
  }
  for (const session of snapshot?.sessions ?? []) {
    if (!isRecord(session) || typeof session.id !== 'string') {
      throwInvalidSessionSnapshot();
    }
    sessions.set(session.id, normalizeSessionRecord(
      session,
      messages.get(session.id) ?? [],
      inputs.get(session.id) ?? [],
    ));
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
