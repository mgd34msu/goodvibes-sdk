import { PersistentStore } from '../../state/persistent-store.js';
import type {
  DistributedApprovalBridge,
  DistributedAutomationBridge,
  DistributedNodeHostContract,
  DistributedPendingWork,
  DistributedPeerAuth,
  DistributedPeerKind,
  DistributedPeerRecord,
  DistributedPeerTokenRecord,
  DistributedRuntimeAuditRecord,
  DistributedRuntimeManagerState,
  DistributedRuntimePairRequest,
  DistributedRuntimeSnapshotStore,
  DistributedSessionBridge,
  DistributedWorkPriority,
  DistributedWorkType,
  StoredPairRequest,
  StoredPeerRecord,
  DistributedRuntimeWaiter,
} from './distributed-runtime-types.js';
import { getDistributedNodeHostContract } from './distributed-runtime-contract.js';
import {
  attachDistributedRuntime,
  getDistributedRuntimeSnapshot,
  listDistributedRuntimeAudit,
  listDistributedRuntimePairRequests,
  listDistributedRuntimePeers,
  listDistributedRuntimeWork,
  startDistributedRuntime,
} from './distributed-runtime-store.js';
import {
  approveDistributedPairRequest,
  authenticateDistributedPeerToken,
  disconnectDistributedPeer,
  rejectDistributedPairRequest,
  requestDistributedPairing,
  revokeDistributedPeerToken,
  rotateDistributedPeerToken,
  verifyDistributedPairRequest,
  heartbeatDistributedPeer,
} from './distributed-runtime-pairing.js';
import {
  cancelDistributedWork,
  claimDistributedWork,
  completeDistributedWork,
  enqueueDistributedWork,
  invokeDistributedPeer,
} from './distributed-runtime-work.js';

export class DistributedRuntimeManager implements DistributedRuntimeManagerState {
  readonly store: PersistentStore<DistributedRuntimeSnapshotStore>;
  readonly pairRequests = new Map<string, StoredPairRequest>();
  readonly peers = new Map<string, StoredPeerRecord>();
  readonly work = new Map<string, DistributedPendingWork>();
  readonly audit: DistributedRuntimeAuditRecord[] = [];
  readonly waiters = new Map<string, DistributedRuntimeWaiter[]>();
  sessionBridge: DistributedSessionBridge | null = null;
  approvalBridge: DistributedApprovalBridge | null = null;
  automationBridge: DistributedAutomationBridge | null = null;
  eventPublisher: ((event: string, payload: unknown) => void) | null = null;
  loaded = false;

  constructor(storeOrPath: PersistentStore<DistributedRuntimeSnapshotStore> | string) {
    this.store = typeof storeOrPath === 'string'
      ? new PersistentStore<DistributedRuntimeSnapshotStore>(storeOrPath)
      : storeOrPath;
  }

  attachRuntime(input: {
    readonly sessionBridge?: DistributedSessionBridge | null | undefined;
    readonly approvalBridge?: DistributedApprovalBridge | null | undefined;
    readonly automationBridge?: DistributedAutomationBridge | null | undefined;
    readonly eventPublisher?: ((event: string, payload: unknown) => void) | null | undefined;
  }): void {
    attachDistributedRuntime(this, input);
  }

  async start(): Promise<void> {
    await startDistributedRuntime(this);
  }

  listPairRequests(limit = 100): DistributedRuntimePairRequest[] {
    return listDistributedRuntimePairRequests(this, limit);
  }

  listPeers(kind?: DistributedPeerKind, limit = 200): DistributedPeerRecord[] {
    return listDistributedRuntimePeers(this, kind, limit);
  }

  listWork(limit = 200, peerId?: string): DistributedPendingWork[] {
    return listDistributedRuntimeWork(this, limit, peerId);
  }

  listAudit(limit = 100): DistributedRuntimeAuditRecord[] {
    return listDistributedRuntimeAudit(this, limit);
  }

  getSnapshot(): Record<string, unknown> {
    return getDistributedRuntimeSnapshot(this);
  }

  getNodeHostContract(): DistributedNodeHostContract {
    return getDistributedNodeHostContract();
  }

  async requestPairing(input: {
    readonly peerKind: DistributedPeerKind;
    readonly requestedId?: string | undefined;
    readonly label: string;
    readonly platform?: string | undefined;
    readonly deviceFamily?: string | undefined;
    readonly version?: string | undefined;
    readonly clientMode?: string | undefined;
    readonly capabilities?: readonly string[] | undefined;
    readonly commands?: readonly string[] | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
    readonly requestedBy?: 'remote' | 'operator' | undefined;
    readonly remoteAddress?: string | undefined;
    readonly ttlMs?: number | undefined;
  }): Promise<{ request: DistributedRuntimePairRequest; challenge: string }> {
    return requestDistributedPairing(this, input);
  }

  async approvePairRequest(
    requestId: string,
    input: {
      readonly actor?: string | undefined;
      readonly note?: string | undefined;
      readonly label?: string | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    } = {},
  ): Promise<{ request: DistributedRuntimePairRequest; peer: DistributedPeerRecord } | null> {
    return approveDistributedPairRequest(this, requestId, input);
  }

  async rejectPairRequest(
    requestId: string,
    input: {
      readonly actor?: string | undefined;
      readonly note?: string | undefined;
    } = {},
  ): Promise<DistributedRuntimePairRequest | null> {
    return rejectDistributedPairRequest(this, requestId, input);
  }

  async verifyPairRequest(
    requestId: string,
    challenge: string,
    input: {
      readonly remoteAddress?: string | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    } = {},
  ): Promise<{ peer: DistributedPeerRecord; token: DistributedPeerTokenRecord & { value: string } } | null> {
    return verifyDistributedPairRequest(this, requestId, challenge, input);
  }

  async rotatePeerToken(
    peerId: string,
    input: {
      readonly actor?: string | undefined;
      readonly label?: string | undefined;
      readonly scopes?: readonly string[] | undefined;
    } = {},
  ): Promise<{ peer: DistributedPeerRecord; token: DistributedPeerTokenRecord & { value: string } } | null> {
    return rotateDistributedPeerToken(this, peerId, input);
  }

  async revokePeerToken(
    peerId: string,
    input: {
      readonly actor?: string | undefined;
      readonly tokenId?: string | undefined;
      readonly note?: string | undefined;
    } = {},
  ): Promise<DistributedPeerRecord | null> {
    return revokeDistributedPeerToken(this, peerId, input);
  }

  async disconnectPeer(
    peerId: string,
    input: {
      readonly actor?: string | undefined;
      readonly note?: string | undefined;
      readonly requeueClaimedWork?: boolean | undefined;
    } = {},
  ): Promise<DistributedPeerRecord | null> {
    return disconnectDistributedPeer(this, peerId, input);
  }

  async enqueueWork(input: {
    readonly peerId: string;
    readonly type?: DistributedWorkType | undefined;
    readonly command: string;
    readonly payload?: unknown | undefined;
    readonly priority?: DistributedWorkPriority | undefined;
    readonly actor?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly sessionId?: string | undefined;
    readonly routeId?: string | undefined;
    readonly automationRunId?: string | undefined;
    readonly automationJobId?: string | undefined;
    readonly approvalId?: string | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }): Promise<DistributedPendingWork> {
    return enqueueDistributedWork(this, input);
  }

  async invokePeer(input: {
    readonly peerId: string;
    readonly command: string;
    readonly payload?: unknown | undefined;
    readonly priority?: DistributedWorkPriority | undefined;
    readonly actor?: string | undefined;
    readonly waitMs?: number | undefined;
    readonly timeoutMs?: number | undefined;
    readonly sessionId?: string | undefined;
    readonly routeId?: string | undefined;
    readonly automationRunId?: string | undefined;
    readonly automationJobId?: string | undefined;
    readonly approvalId?: string | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }): Promise<{ work: DistributedPendingWork; completed: boolean }> {
    return invokeDistributedPeer(this, input);
  }

  async authenticatePeerToken(tokenValue: string, remoteAddress?: string): Promise<DistributedPeerAuth | null> {
    return authenticateDistributedPeerToken(this, tokenValue, remoteAddress);
  }

  async heartbeatPeer(
    auth: DistributedPeerAuth,
    input: {
      readonly remoteAddress?: string | undefined;
      readonly capabilities?: readonly string[] | undefined;
      readonly commands?: readonly string[] | undefined;
      readonly version?: string | undefined;
      readonly clientMode?: string | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    } = {},
  ): Promise<DistributedPeerRecord> {
    return heartbeatDistributedPeer(this, auth, input);
  }

  async claimWork(
    auth: DistributedPeerAuth,
    input: {
      readonly maxItems?: number | undefined;
      readonly leaseMs?: number | undefined;
    } = {},
  ): Promise<DistributedPendingWork[]> {
    return claimDistributedWork(this, auth, input);
  }

  async completeWork(
    auth: DistributedPeerAuth,
    workId: string,
    input: {
      readonly status?: 'completed' | 'failed' | 'cancelled' | undefined;
      readonly result?: unknown | undefined;
      readonly error?: string | undefined;
      readonly telemetry?: DistributedPendingWork['telemetry'] | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    } = {},
  ): Promise<DistributedPendingWork | null> {
    return completeDistributedWork(this, auth, workId, input);
  }

  async cancelWork(
    workId: string,
    input: {
      readonly actor?: string | undefined;
      readonly reason?: string | undefined;
    } = {},
  ): Promise<DistributedPendingWork | null> {
    return cancelDistributedWork(this, workId, input);
  }
}
