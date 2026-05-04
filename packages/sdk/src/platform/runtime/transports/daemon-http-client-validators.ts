import type { AutomationSurfaceKind } from '../../automation/types.js';
import type {
  SharedApprovalRecord,
  SharedSessionInputRecord,
  SharedSessionMessage,
  SharedSessionRecord,
  SharedSessionSubmission,
} from '../../control-plane/index.js';
import type { RuntimeTask } from '../store/domains/tasks.js';
import type { ProviderRuntimeSnapshot, ProviderUsageSnapshot } from '../../providers/runtime-snapshot.js';
import type { TelemetryListResponse, TelemetrySnapshot } from '../telemetry/api.js';
import type { HttpTransportTelemetryMetricsSnapshot, HttpTransportTelemetryQuery } from './http-types.js';
import { normalizeTelemetryQuery } from './http-helpers.js';

// ---------------------------------------------------------------------------
// Runtime validators — replace `as unknown as X` casts with checked coercions
// ---------------------------------------------------------------------------

type SdkTelemetryQuery = {
  readonly limit?: number;
  readonly since?: number;
  readonly until?: number;
  readonly domains?: string;
  readonly types?: string;
  readonly severity?: 'debug' | 'error' | 'info' | 'warn';
  readonly traceId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly cursor?: string;
  readonly view?: 'raw' | 'safe';
};

export function assertObjectField<T extends object>(
  container: unknown,
  field: string,
  endpoint: string,
): T {
  if (
    container === null
    || typeof container !== 'object'
    || !(field in (container as object))
    || (container as Record<string, unknown>)[field] === null
    || typeof (container as Record<string, unknown>)[field] !== 'object'
  ) {
    throw new Error(`[${endpoint}] Expected response to contain object field "${field}"`);
  }
  return (container as Record<string, unknown>)[field] as T;
}

export function assertObjectOrNullField<T extends object>(
  container: unknown,
  field: string,
  endpoint: string,
): T | null {
  if (container === null || typeof container !== 'object') {
    throw new Error(`[${endpoint}] Expected response to be an object`);
  }
  const value = (container as Record<string, unknown>)[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') {
    throw new Error(`[${endpoint}] Expected field "${field}" to be an object or null`);
  }
  return value as T;
}

export function assertArrayField<T>(
  container: unknown,
  field: string,
  endpoint: string,
): readonly T[] {
  if (container === null || typeof container !== 'object') {
    throw new Error(`[${endpoint}] Expected response to be an object`);
  }
  const value = (container as Record<string, unknown>)[field];
  if (!Array.isArray(value)) {
    throw new Error(`[${endpoint}] Expected field "${field}" to be an array`);
  }
  return value as readonly T[];
}

export function assertRuntimeTaskArray(tasks: unknown, endpoint: string): readonly RuntimeTask[] {
  if (!Array.isArray(tasks)) {
    throw new Error(`[${endpoint}] Expected "tasks" to be an array`);
  }
  for (const task of tasks) {
    if (task === null || typeof task !== 'object' || typeof (task as Record<string, unknown>).id !== 'string') {
      throw new Error(`[${endpoint}] Task entry missing required "id" field`);
    }
  }
  return tasks as readonly RuntimeTask[];
}

export function assertSharedApprovalArray(approvals: unknown, endpoint: string): readonly SharedApprovalRecord[] {
  if (!Array.isArray(approvals)) {
    throw new Error(`[${endpoint}] Expected "approvals" to be an array`);
  }
  return approvals as readonly SharedApprovalRecord[];
}

export function assertProviderRuntimeSnapshotArray(providers: unknown, endpoint: string): readonly ProviderRuntimeSnapshot[] {
  if (!Array.isArray(providers)) {
    throw new Error(`[${endpoint}] Expected "providers" to be an array`);
  }
  for (const provider of providers) {
    if (
      provider === null
      || typeof provider !== 'object'
      || typeof (provider as Record<string, unknown>).providerId !== 'string'
    ) {
      throw new Error(`[${endpoint}] Provider entry missing required "providerId" field`);
    }
  }
  return providers as readonly ProviderRuntimeSnapshot[];
}

export function assertProviderRuntimeSnapshot(value: unknown, endpoint: string): ProviderRuntimeSnapshot {
  if (
    value === null
    || typeof value !== 'object'
    || typeof (value as Record<string, unknown>).providerId !== 'string'
  ) {
    throw new Error(`[${endpoint}] Expected ProviderRuntimeSnapshot with "providerId" field`);
  }
  return value as ProviderRuntimeSnapshot;
}

export function assertProviderUsageSnapshot(value: unknown, endpoint: string): ProviderUsageSnapshot {
  if (
    value === null
    || typeof value !== 'object'
    || typeof (value as Record<string, unknown>).providerId !== 'string'
  ) {
    throw new Error(`[${endpoint}] Expected ProviderUsageSnapshot with "providerId" field`);
  }
  return value as ProviderUsageSnapshot;
}

export function assertTelemetrySnapshot(value: unknown, endpoint: string): TelemetrySnapshot {
  if (
    value === null
    || typeof value !== 'object'
    || (value as Record<string, unknown>).version !== 1
    || typeof (value as Record<string, unknown>).generatedAt !== 'number'
  ) {
    throw new Error(`[${endpoint}] Expected TelemetrySnapshot with version=1 and numeric "generatedAt"`);
  }
  return value as TelemetrySnapshot;
}

export function assertTelemetryListResponse<T>(value: unknown, endpoint: string): TelemetryListResponse<T> {
  if (
    value === null
    || typeof value !== 'object'
    || (value as Record<string, unknown>).version !== 1
    || !Array.isArray((value as Record<string, unknown>).items)
  ) {
    throw new Error(`[${endpoint}] Expected TelemetryListResponse with version=1 and "items" array`);
  }
  return value as TelemetryListResponse<T>;
}

export function assertTelemetryMetricsSnapshot(value: unknown, endpoint: string): HttpTransportTelemetryMetricsSnapshot {
  if (
    value === null
    || typeof value !== 'object'
    || (value as Record<string, unknown>).version !== 1
    || typeof (value as Record<string, unknown>).generatedAt !== 'number'
  ) {
    throw new Error(`[${endpoint}] Expected HttpTransportTelemetryMetricsSnapshot with version=1 and numeric "generatedAt"`);
  }
  return value as HttpTransportTelemetryMetricsSnapshot;
}

export function normalizeSharedSessionRecord(record: SharedSessionRecord | Record<string, unknown>): SharedSessionRecord {
  const candidate = record as SharedSessionRecord & {
    readonly surfaceKinds?: readonly string[];
    readonly participants?: ReadonlyArray<{
      readonly surfaceKind: string;
      readonly surfaceId: string;
      readonly externalId?: string;
      readonly userId?: string;
      readonly displayName?: string;
      readonly routeId?: string;
      readonly lastSeenAt: number;
    }>;
  };
  return {
    ...candidate,
    surfaceKinds: (candidate.surfaceKinds ?? []) as readonly AutomationSurfaceKind[],
    participants: (candidate.participants ?? []).map((participant) => ({
      ...participant,
      surfaceKind: participant.surfaceKind as AutomationSurfaceKind,
    })),
  } as SharedSessionRecord;
}

export function normalizeSharedSessionMessage(
  message: SharedSessionMessage | Record<string, unknown> | null | undefined,
  fallbackInput?: SharedSessionInputRecord,
): SharedSessionMessage {
  if (message && typeof message === 'object') {
    const candidate = message as SharedSessionMessage & { readonly surfaceKind?: string };
    return {
      ...candidate,
      surfaceKind: candidate.surfaceKind as AutomationSurfaceKind | undefined,
    };
  }
  if (!fallbackInput) {
    throw new Error('Shared session submission did not include a message');
  }
  return {
    id: fallbackInput.causationId ?? `msg-${fallbackInput.id}`,
    sessionId: fallbackInput.sessionId,
    role: 'user',
    body: fallbackInput.body,
    createdAt: fallbackInput.createdAt,
    surfaceKind: fallbackInput.surfaceKind,
    surfaceId: fallbackInput.surfaceId,
    routeId: fallbackInput.routeId,
    userId: fallbackInput.userId,
    displayName: fallbackInput.displayName,
    metadata: fallbackInput.metadata,
  };
}

export function normalizeSharedSessionInput(record: SharedSessionInputRecord | Record<string, unknown>): SharedSessionInputRecord {
  const candidate = record as SharedSessionInputRecord & { readonly surfaceKind?: string };
  return {
    ...candidate,
    surfaceKind: candidate.surfaceKind as AutomationSurfaceKind | undefined,
  };
}

export function normalizeSharedSessionSubmission(record: Record<string, unknown>): SharedSessionSubmission {
  const sessionValue = record.session;
  if (!sessionValue || typeof sessionValue !== 'object') {
    throw new Error('Shared session submission did not include a session');
  }
  const inputValue = record.input;
  if (!inputValue || typeof inputValue !== 'object') {
    throw new Error('Shared session submission did not include an input');
  }
  const session = normalizeSharedSessionRecord(sessionValue as Record<string, unknown>);
  const input = normalizeSharedSessionInput(inputValue as Record<string, unknown>);
  return {
    session,
    userMessage: normalizeSharedSessionMessage(
      (record.message as Record<string, unknown> | null | undefined) ?? (record.userMessage as Record<string, unknown> | null | undefined),
      input,
    ),
    routeBinding: record.routeBinding as SharedSessionSubmission['routeBinding'],
    input,
    intent: input.intent,
    mode: record.mode as SharedSessionSubmission['mode'],
    state: input.state,
    task: typeof record.task === 'string' ? record.task : undefined,
    activeAgentId: typeof record.agentId === 'string'
      ? record.agentId
      : typeof record.activeAgentId === 'string'
        ? record.activeAgentId
        : undefined,
    created: Boolean(record.created),
  };
}

export function normalizeTelemetryQueryForSdk(
  query: HttpTransportTelemetryQuery | undefined,
  defaultLimit: number,
): SdkTelemetryQuery {
  const normalized = normalizeTelemetryQuery(query, defaultLimit);
  return {
    ...(normalized.limit !== undefined ? { limit: normalized.limit } : {}),
    ...(normalized.since !== undefined ? { since: normalized.since } : {}),
    ...(normalized.until !== undefined ? { until: normalized.until } : {}),
    ...(normalized.domains?.length ? { domains: normalized.domains.join(',') } : {}),
    ...(normalized.eventTypes?.length ? { types: normalized.eventTypes.join(',') } : {}),
    ...(normalized.severity ? { severity: normalized.severity } : {}),
    ...(normalized.traceId ? { traceId: normalized.traceId } : {}),
    ...(normalized.sessionId ? { sessionId: normalized.sessionId } : {}),
    ...(normalized.turnId ? { turnId: normalized.turnId } : {}),
    ...(normalized.agentId ? { agentId: normalized.agentId } : {}),
    ...(normalized.taskId ? { taskId: normalized.taskId } : {}),
    ...(normalized.cursor ? { cursor: normalized.cursor } : {}),
    ...(normalized.view ? { view: normalized.view } : {}),
  };
}
