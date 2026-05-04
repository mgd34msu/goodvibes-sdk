import type { AutomationRunTelemetry } from '../../automation/runs.js';
import type { PersistentStore } from '../../state/persistent-store.js';

export type DistributedPeerKind = 'node' | 'device';
export type DistributedPairRequestStatus = 'pending' | 'approved' | 'verified' | 'rejected' | 'expired';
export type DistributedPeerStatus = 'paired' | 'connected' | 'idle' | 'disconnected' | 'revoked';
export type DistributedWorkPriority = 'default' | 'normal' | 'high';
export type DistributedWorkStatus = 'queued' | 'claimed' | 'completed' | 'failed' | 'cancelled' | 'expired';
export type DistributedWorkType = 'invoke' | 'status.request' | 'location.request' | 'session.message' | 'automation.run';

export interface DistributedSessionBridge {
  appendSystemMessage(sessionId: string, body: string, metadata?: Record<string, unknown>): Promise<unknown>;
}

export interface DistributedApprovalBridge {
  recordRemoteUpdate(
    approvalId: string,
    input: {
      readonly actor: string;
      readonly actorSurface?: string | undefined;
      readonly note?: string | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    },
  ): Promise<unknown>;
}

export interface DistributedAutomationBridge {
  recordExternalRunResult(
    runId: string,
    input: {
      readonly status: 'completed' | 'failed' | 'cancelled';
      readonly result?: unknown | undefined;
      readonly error?: string | undefined;
      readonly telemetry?: AutomationRunTelemetry | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    },
  ): Promise<unknown>;
}

export interface DistributedRuntimePairRequest {
  readonly id: string;
  readonly peerKind: DistributedPeerKind;
  readonly requestedId: string;
  readonly label: string;
  readonly platform?: string | undefined;
  readonly deviceFamily?: string | undefined;
  readonly version?: string | undefined;
  readonly clientMode?: string | undefined;
  readonly capabilities: readonly string[];
  readonly commands: readonly string[];
  readonly requestedBy: 'remote' | 'operator';
  readonly status: DistributedPairRequestStatus;
  readonly challengePreview: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly approvedAt?: number | undefined;
  readonly verifiedAt?: number | undefined;
  readonly rejectedAt?: number | undefined;
  readonly expiresAt: number;
  readonly peerId?: string | undefined;
  readonly remoteAddress?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface DistributedPeerTokenRecord {
  readonly id: string;
  readonly label: string;
  readonly scopes: readonly string[];
  readonly issuedAt: number;
  readonly lastUsedAt?: number | undefined;
  readonly rotatedAt?: number | undefined;
  readonly revokedAt?: number | undefined;
  readonly fingerprint: string;
}

export interface DistributedPeerRecord {
  readonly id: string;
  readonly kind: DistributedPeerKind;
  readonly label: string;
  readonly requestedId: string;
  readonly platform?: string | undefined;
  readonly deviceFamily?: string | undefined;
  readonly version?: string | undefined;
  readonly clientMode?: string | undefined;
  readonly capabilities: readonly string[];
  readonly commands: readonly string[];
  readonly permissions?: Record<string, boolean> | undefined;
  readonly status: DistributedPeerStatus;
  readonly pairedAt: number;
  readonly verifiedAt?: number | undefined;
  readonly lastSeenAt?: number | undefined;
  readonly lastConnectedAt?: number | undefined;
  readonly lastDisconnectedAt?: number | undefined;
  readonly lastRemoteAddress?: string | undefined;
  readonly activeTokenId?: string | undefined;
  readonly tokens: readonly DistributedPeerTokenRecord[];
  readonly metadata: Record<string, unknown>;
}

export interface DistributedPendingWork {
  readonly id: string;
  readonly peerId: string;
  readonly peerKind: DistributedPeerKind;
  readonly type: DistributedWorkType;
  readonly command: string;
  readonly priority: DistributedWorkPriority;
  readonly status: DistributedWorkStatus;
  readonly payload?: unknown | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly queuedBy: string;
  readonly claimedAt?: number | undefined;
  readonly claimTokenId?: string | undefined;
  readonly leaseExpiresAt?: number | undefined;
  readonly completedAt?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly automationRunId?: string | undefined;
  readonly automationJobId?: string | undefined;
  readonly approvalId?: string | undefined;
  readonly result?: unknown | undefined;
  readonly error?: string | undefined;
  readonly telemetry?: AutomationRunTelemetry | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface DistributedRuntimeAuditRecord {
  readonly id: string;
  readonly action:
    | 'pair-requested'
    | 'pair-approved'
    | 'pair-rejected'
    | 'pair-verified'
    | 'pair-expired'
    | 'token-rotated'
    | 'token-revoked'
    | 'peer-connected'
    | 'peer-disconnected'
    | 'work-queued'
    | 'work-claimed'
    | 'work-completed'
    | 'work-failed'
    | 'work-cancelled'
    | 'work-expired';
  readonly actor: string;
  readonly peerId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly workId?: string | undefined;
  readonly createdAt: number;
  readonly note?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface DistributedRuntimeSnapshotStore extends Record<string, unknown> {
  readonly pairRequests: readonly DistributedRuntimePairRequest[];
  readonly peers: readonly DistributedPeerRecord[];
  readonly work: readonly DistributedPendingWork[];
  readonly audit: readonly DistributedRuntimeAuditRecord[];
}

export interface DistributedRuntimeWaiter {
  readonly resolve: (work: DistributedPendingWork | null) => void;
  readonly timer?: ReturnType<typeof setTimeout> | undefined;
}

export interface DistributedPeerAuth {
  readonly peer: DistributedPeerRecord;
  readonly token: DistributedPeerTokenRecord;
}

export interface DistributedNodeHostContract {
  readonly schemaVersion: 1;
  readonly transport: 'http-json';
  readonly basePath: '/api/remote';
  readonly peerKinds: readonly DistributedPeerKind[];
  readonly workTypes: readonly DistributedWorkType[];
  readonly scopes: readonly string[];
  readonly recommendedHeartbeatMs: number;
  readonly recommendedWorkPullMs: number;
  readonly endpoints: readonly {
    readonly id: string;
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly auth: 'none' | 'bearer-peer-token' | 'bearer-operator-token';
    readonly description: string;
    readonly requiredScope?: string | undefined;
  }[];
  readonly workCompletionStatuses: readonly DistributedWorkStatus[];
  readonly metadata: Record<string, unknown>;
}

interface StoredPeerTokenRecord extends DistributedPeerTokenRecord {
  readonly secretHash: string;
}

interface StoredPeerRecord extends Omit<DistributedPeerRecord, 'tokens'> {
  readonly tokens: readonly StoredPeerTokenRecord[];
}

interface StoredPairRequest extends DistributedRuntimePairRequest {
  readonly challengeHash: string;
}

export interface DistributedRuntimeManagerState {
  readonly store: PersistentStore<DistributedRuntimeSnapshotStore>;
  readonly pairRequests: Map<string, StoredPairRequest>;
  readonly peers: Map<string, StoredPeerRecord>;
  readonly work: Map<string, DistributedPendingWork>;
  readonly audit: DistributedRuntimeAuditRecord[];
  readonly waiters: Map<string, DistributedRuntimeWaiter[]>;
  sessionBridge: DistributedSessionBridge | null;
  approvalBridge: DistributedApprovalBridge | null;
  automationBridge: DistributedAutomationBridge | null;
  eventPublisher: ((event: string, payload: unknown) => void) | null;
  loaded: boolean;
}

export type {
  StoredPairRequest,
  StoredPeerTokenRecord,
  StoredPeerRecord,
};
