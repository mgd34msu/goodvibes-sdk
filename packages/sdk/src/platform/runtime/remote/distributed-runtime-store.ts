import type { PersistentStore } from '../../state/persistent-store.js';
import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';
import type {
  DistributedPendingWork,
  DistributedRuntimeAuditRecord,
  DistributedRuntimeManagerState,
  DistributedRuntimePairRequest,
  DistributedRuntimeSnapshotStore,
  DistributedPeerKind,
  DistributedPeerRecord,
  DistributedRuntimeWaiter,
} from './distributed-runtime-types.js';
import {
  normalizeAudit,
  normalizePairRequest,
  normalizePeer,
  normalizeToken,
  normalizeWork,
  sanitizePairRequest,
  sanitizePeer,
  sortPairRequests,
  sortPeers,
  sortWork,
} from './distributed-runtime-utils.js';

const MAX_AUDIT = 500;
const MAX_WORK_HISTORY = 500;
const MAX_PAIR_REQUESTS = 250;
const DISTRIBUTED_PEER_KINDS = new Set<DistributedPeerKind>(['node', 'device']);
const PAIR_REQUEST_STATUSES = new Set<DistributedRuntimePairRequest['status']>([
  'pending',
  'approved',
  'verified',
  'rejected',
  'expired',
]);
const PAIR_REQUEST_ACTORS = new Set<DistributedRuntimePairRequest['requestedBy']>(['remote', 'operator']);
const PEER_STATUSES = new Set<DistributedPeerRecord['status']>(['paired', 'connected', 'idle', 'disconnected', 'revoked']);
const WORK_TYPES = new Set<DistributedPendingWork['type']>([
  'invoke',
  'status.request',
  'location.request',
  'session.message',
  'automation.run',
]);
const WORK_PRIORITIES = new Set<DistributedPendingWork['priority']>(['default', 'normal', 'high']);
const WORK_STATUSES = new Set<DistributedPendingWork['status']>(['queued', 'claimed', 'completed', 'failed', 'cancelled', 'expired']);
const AUDIT_ACTIONS = new Set<DistributedRuntimeAuditRecord['action']>([
  'pair-requested',
  'pair-approved',
  'pair-rejected',
  'pair-verified',
  'pair-expired',
  'token-rotated',
  'token-revoked',
  'peer-connected',
  'peer-disconnected',
  'work-queued',
  'work-claimed',
  'work-completed',
  'work-failed',
  'work-cancelled',
  'work-expired',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function throwInvalidDistributedRuntimeSnapshot(): never {
  throw new Error('Distributed runtime store snapshot is invalid.');
}

function validateOptionalNumber(value: unknown): void {
  if (value !== undefined && !isFiniteNumber(value)) throwInvalidDistributedRuntimeSnapshot();
}

function validateOptionalRecord(value: unknown): void {
  if (value !== undefined && !isRecord(value)) throwInvalidDistributedRuntimeSnapshot();
}

function validateOptionalString(value: unknown): void {
  if (value !== undefined && typeof value !== 'string') throwInvalidDistributedRuntimeSnapshot();
}

function validateOptionalStringArray(value: unknown): void {
  if (value !== undefined && !isStringArray(value)) throwInvalidDistributedRuntimeSnapshot();
}

function validateOptionalEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>): void {
  if (value !== undefined && (typeof value !== 'string' || !allowed.has(value as T))) throwInvalidDistributedRuntimeSnapshot();
}

function validateDistributedRuntimePairRequest(record: unknown): void {
  if (!isRecord(record)) return;
  validateOptionalEnum(record['peerKind'], DISTRIBUTED_PEER_KINDS);
  validateOptionalEnum(record['requestedBy'], PAIR_REQUEST_ACTORS);
  validateOptionalEnum(record['status'], PAIR_REQUEST_STATUSES);
  validateOptionalStringArray(record['capabilities']);
  validateOptionalStringArray(record['commands']);
  validateOptionalString(record['challengeHash']);
  validateOptionalNumber(record['createdAt']);
  validateOptionalNumber(record['updatedAt']);
  validateOptionalNumber(record['approvedAt']);
  validateOptionalNumber(record['verifiedAt']);
  validateOptionalNumber(record['rejectedAt']);
  validateOptionalNumber(record['expiresAt']);
  validateOptionalRecord(record['metadata']);
}

function validateDistributedRuntimePeer(record: unknown): void {
  if (!isRecord(record)) return;
  validateOptionalEnum(record['kind'], DISTRIBUTED_PEER_KINDS);
  validateOptionalEnum(record['status'], PEER_STATUSES);
  validateOptionalStringArray(record['capabilities']);
  validateOptionalStringArray(record['commands']);
  validateOptionalRecord(record['permissions']);
  validateOptionalNumber(record['pairedAt']);
  validateOptionalNumber(record['verifiedAt']);
  validateOptionalNumber(record['lastSeenAt']);
  validateOptionalNumber(record['lastConnectedAt']);
  validateOptionalNumber(record['lastDisconnectedAt']);
  validateOptionalRecord(record['metadata']);
}

function validateDistributedRuntimePeerTokens(peer: unknown): void {
  if (!isRecord(peer)) return;
  if (peer['tokens'] === undefined) return;
  if (!Array.isArray(peer['tokens'])) throwInvalidDistributedRuntimeSnapshot();
  for (const token of peer['tokens']) {
    if (isRecord(token)) validateOptionalStringArray(token['scopes']);
    if (!normalizeToken(token)) throwInvalidDistributedRuntimeSnapshot();
  }
}

function validateDistributedRuntimeWork(record: unknown): void {
  if (!isRecord(record)) return;
  validateOptionalEnum(record['peerKind'], DISTRIBUTED_PEER_KINDS);
  validateOptionalEnum(record['type'], WORK_TYPES);
  validateOptionalEnum(record['priority'], WORK_PRIORITIES);
  validateOptionalEnum(record['status'], WORK_STATUSES);
  validateOptionalNumber(record['createdAt']);
  validateOptionalNumber(record['updatedAt']);
  validateOptionalNumber(record['claimedAt']);
  validateOptionalNumber(record['leaseExpiresAt']);
  validateOptionalNumber(record['completedAt']);
  validateOptionalNumber(record['timeoutMs']);
  validateOptionalRecord(record['metadata']);
}

function validateDistributedRuntimeAudit(record: unknown): void {
  if (!isRecord(record)) return;
  validateOptionalEnum(record['action'], AUDIT_ACTIONS);
  validateOptionalNumber(record['createdAt']);
  validateOptionalRecord(record['metadata']);
}

function validateDistributedRuntimeSnapshot(snapshot: DistributedRuntimeSnapshotStore | null): DistributedRuntimeSnapshotStore | null {
  if (!snapshot) return null;
  if (
    !isRecord(snapshot)
    || !Array.isArray(snapshot.pairRequests)
    || !Array.isArray(snapshot.peers)
    || !Array.isArray(snapshot.work)
    || !Array.isArray(snapshot.audit)
  ) {
    throwInvalidDistributedRuntimeSnapshot();
  }
  for (const request of snapshot.pairRequests) {
    validateDistributedRuntimePairRequest(request);
    requireDistributedRuntimeRecord(normalizePairRequest(request));
  }
  for (const peer of snapshot.peers) {
    validateDistributedRuntimePeer(peer);
    validateDistributedRuntimePeerTokens(peer);
    requireDistributedRuntimeRecord(normalizePeer(peer));
  }
  for (const item of snapshot.work) {
    validateDistributedRuntimeWork(item);
    requireDistributedRuntimeRecord(normalizeWork(item));
  }
  for (const record of snapshot.audit) {
    validateDistributedRuntimeAudit(record);
    requireDistributedRuntimeRecord(normalizeAudit(record));
  }
  return snapshot;
}

function requireDistributedRuntimeRecord<T>(record: T | null): T {
  if (!record) throwInvalidDistributedRuntimeSnapshot();
  return record;
}

export function attachDistributedRuntime(
  state: DistributedRuntimeManagerState,
  input: {
    readonly sessionBridge?: DistributedRuntimeManagerState['sessionBridge'] | undefined;
    readonly approvalBridge?: DistributedRuntimeManagerState['approvalBridge'] | undefined;
    readonly automationBridge?: DistributedRuntimeManagerState['automationBridge'] | undefined;
    readonly eventPublisher?: DistributedRuntimeManagerState['eventPublisher'] | undefined;
  },
): void {
  if (input.sessionBridge) state.sessionBridge = input.sessionBridge;
  if (input.approvalBridge) state.approvalBridge = input.approvalBridge;
  if (input.automationBridge) state.automationBridge = input.automationBridge;
  if (input.eventPublisher) state.eventPublisher = input.eventPublisher;
}

export async function startDistributedRuntime(state: DistributedRuntimeManagerState): Promise<void> {
  if (state.loaded) return;
  const snapshot = validateDistributedRuntimeSnapshot(await state.store.load());
  state.pairRequests.clear();
  state.peers.clear();
  state.work.clear();
  state.audit.length = 0;
  for (const request of snapshot?.pairRequests ?? []) {
    const normalized = requireDistributedRuntimeRecord(normalizePairRequest(request));
    state.pairRequests.set(normalized.id, normalized);
  }
  for (const peer of snapshot?.peers ?? []) {
    const normalized = requireDistributedRuntimeRecord(normalizePeer(peer));
    state.peers.set(normalized.id, normalized);
  }
  for (const item of snapshot?.work ?? []) {
    const normalized = requireDistributedRuntimeRecord(normalizeWork(item));
    state.work.set(normalized.id, normalized);
  }
  for (const record of snapshot?.audit ?? []) {
    const normalized = requireDistributedRuntimeRecord(normalizeAudit(record));
    state.audit.push(normalized);
  }
  state.loaded = true;
  await pruneAndPersistDistributedRuntime(state);
}

export function listDistributedRuntimePairRequests(
  state: DistributedRuntimeManagerState,
  limit = 100,
): DistributedRuntimePairRequest[] {
  expireDistributedPairRequests(state);
  return sortPairRequests(state.pairRequests.values()).slice(0, Math.max(1, limit)).map(sanitizePairRequest);
}

export function listDistributedRuntimePeers(
  state: DistributedRuntimeManagerState,
  kind?: DistributedPeerKind,
  limit = 200,
): DistributedPeerRecord[] {
  return sortPeers(state.peers.values())
    .filter((peer) => !kind || peer.kind === kind)
    .slice(0, Math.max(1, limit))
    .map(sanitizePeer);
}

export function listDistributedRuntimeWork(
  state: DistributedRuntimeManagerState,
  limit = 200,
  peerId?: string,
): DistributedPendingWork[] {
  requeueDistributedExpiredClaims(state);
  return sortWork(state.work.values())
    .filter((item) => !peerId || item.peerId === peerId)
    .slice(0, Math.max(1, limit));
}

export function listDistributedRuntimeAudit(
  state: DistributedRuntimeManagerState,
  limit = 100,
): DistributedRuntimeAuditRecord[] {
  return state.audit.slice(0, Math.max(1, limit));
}

export function getDistributedRuntimeSnapshot(state: DistributedRuntimeManagerState): Record<string, unknown> {
  expireDistributedPairRequests(state);
  requeueDistributedExpiredClaims(state);
  const peers = listDistributedRuntimePeers(state, undefined, 500);
  const work = listDistributedRuntimeWork(state, 500);
  return {
    capturedAt: Date.now(),
    pairRequests: {
      total: state.pairRequests.size,
      pending: [...state.pairRequests.values()].filter((request) => request.status === 'pending').length,
      approved: [...state.pairRequests.values()].filter((request) => request.status === 'approved').length,
      entries: listDistributedRuntimePairRequests(state, 100),
    },
    peers: {
      total: peers.length,
      connected: peers.filter((peer) => peer.status === 'connected').length,
      nodes: peers.filter((peer) => peer.kind === 'node').length,
      devices: peers.filter((peer) => peer.kind === 'device').length,
      entries: peers,
    },
    work: {
      total: work.length,
      queued: work.filter((item) => item.status === 'queued').length,
      claimed: work.filter((item) => item.status === 'claimed').length,
      completed: work.filter((item) => item.status === 'completed').length,
      failed: work.filter((item) => item.status === 'failed').length,
      cancelled: work.filter((item) => item.status === 'cancelled').length,
      entries: work.slice(0, 100),
    },
    audit: listDistributedRuntimeAudit(state, 100),
  };
}

export function publishDistributedRuntimeEvent(state: DistributedRuntimeManagerState, event: string, payload: unknown): void {
  state.eventPublisher?.(event, payload);
}

export function recordDistributedRuntimeAudit(
  state: DistributedRuntimeManagerState,
  record: DistributedRuntimeAuditRecord,
): void {
  state.audit.unshift(record);
  if (state.audit.length > MAX_AUDIT) {
    state.audit.length = MAX_AUDIT;
  }
}

export function expireDistributedPairRequests(state: DistributedRuntimeManagerState, now = Date.now()): void {
  let changed = false;
  for (const [requestId, request] of state.pairRequests.entries()) {
    if (request.status === 'pending' || request.status === 'approved') {
      if (request.expiresAt <= now) {
        state.pairRequests.set(requestId, {
          ...request,
          status: 'expired',
          updatedAt: now,
        });
        recordDistributedRuntimeAudit(state, {
          id: `drt-audit-${requestId}-${now}`,
          action: 'pair-expired',
          actor: 'distributed-runtime',
          requestId,
          createdAt: now,
          note: request.label,
          metadata: {},
        });
        changed = true;
      }
    }
  }
  if (changed) {
    persistDistributedRuntimeAsync(state, 'expired pair cleanup');
  }
}

export function requeueDistributedExpiredClaims(state: DistributedRuntimeManagerState, now = Date.now()): void {
  let changed = false;
  for (const [workId, item] of state.work.entries()) {
    if (item.status !== 'claimed') continue;
    if (!item.leaseExpiresAt || item.leaseExpiresAt > now) continue;
    state.work.set(workId, {
      ...item,
      status: 'queued',
      claimTokenId: undefined,
      claimedAt: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
      metadata: {
        ...item.metadata,
        lastLeaseExpiryAt: now,
      },
    });
    recordDistributedRuntimeAudit(state, {
      id: `drt-audit-${workId}-${now}`,
      action: 'work-expired',
      actor: 'distributed-runtime',
      peerId: item.peerId,
      workId,
      createdAt: now,
      note: item.command,
      metadata: {},
    });
    const peer = state.peers.get(item.peerId);
    if (peer) {
      state.peers.set(peer.id, {
        ...peer,
        status: 'disconnected',
        lastSeenAt: now,
        lastDisconnectedAt: now,
      });
    }
    changed = true;
  }
  if (changed) {
    persistDistributedRuntimeAsync(state, 'expired work requeue');
  }
}

function persistDistributedRuntimeAsync(state: DistributedRuntimeManagerState, reason: string): void {
  void persistDistributedRuntime(state).catch((error: unknown) => {
    logger.warn('Distributed runtime state persistence failed', {
      reason,
      error: summarizeError(error),
    });
  });
}

export async function waitForDistributedWork(
  state: DistributedRuntimeManagerState,
  workId: string,
  timeoutMs: number,
): Promise<DistributedPendingWork | null> {
  const existing = state.work.get(workId);
  if (existing && existing.status !== 'queued' && existing.status !== 'claimed') {
    return existing;
  }
  return await new Promise<DistributedPendingWork | null>((resolve) => {
    const timer = setTimeout(() => {
      removeDistributedRuntimeWaiter(state, workId, resolve);
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    const bucket = state.waiters.get(workId) ?? [];
    bucket.push({ resolve, timer });
    state.waiters.set(workId, bucket);
  });
}

export function resolveDistributedRuntimeWaiters(state: DistributedRuntimeManagerState, work: DistributedPendingWork): void {
  const bucket = state.waiters.get(work.id);
  if (!bucket) return;
  state.waiters.delete(work.id);
  for (const waiter of bucket) {
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve(work);
  }
}

export function removeDistributedRuntimeWaiter(
  state: DistributedRuntimeManagerState,
  workId: string,
  resolve: DistributedRuntimeWaiter['resolve'],
): void {
  const bucket = state.waiters.get(workId);
  if (!bucket) return;
  const next = bucket.filter((waiter) => waiter.resolve !== resolve);
  if (next.length === 0) state.waiters.delete(workId);
  else state.waiters.set(workId, next);
}

export async function pruneAndPersistDistributedRuntime(state: DistributedRuntimeManagerState): Promise<void> {
  expireDistributedPairRequests(state);
  requeueDistributedExpiredClaims(state);
  const pairRequests = sortPairRequests(state.pairRequests.values());
  for (const request of pairRequests.slice(MAX_PAIR_REQUESTS)) {
    state.pairRequests.delete(request.id);
  }
  const work = sortWork(state.work.values());
  const keep = new Set(
    work
      .filter((item) => item.status === 'queued' || item.status === 'claimed')
      .concat(work.filter((item) => item.status !== 'queued' && item.status !== 'claimed').slice(0, MAX_WORK_HISTORY))
      .map((item) => item.id),
  );
  for (const workId of [...state.work.keys()]) {
    if (!keep.has(workId)) state.work.delete(workId);
  }
  await persistDistributedRuntime(state);
}

export async function persistDistributedRuntime(state: DistributedRuntimeManagerState): Promise<void> {
  await state.store.persist({
    pairRequests: [...state.pairRequests.values()],
    peers: [...state.peers.values()],
    work: [...state.work.values()],
    audit: [...state.audit],
  });
}
