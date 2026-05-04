import { getOperatorContract, getPeerContract } from '@pellux/goodvibes-contracts';
import type { AutomationSurfaceKind } from '../../automation/types.js';
import type {
  ControlPlaneRecentEvent,
  SharedApprovalRecord,
  SharedSessionInputRecord,
  SharedSessionMessage,
  SharedSessionRecord,
  SharedSessionSubmission,
} from '../../control-plane/index.js';
import type { RuntimeTask } from '../store/domains/tasks.js';
import type { ProviderRuntimeSnapshot, ProviderUsageSnapshot } from '../../providers/runtime-snapshot.js';
import type { TelemetryFilter, TelemetryListResponse, TelemetryRecord, TelemetrySnapshot } from '../telemetry/api.js';
import type { ReadableSpan } from '../telemetry/types.js';
import type {
  DistributedNodeHostContract,
  DistributedPendingWork,
  DistributedPeerKind,
  DistributedPeerRecord,
  DistributedRuntimePairRequest,
} from '../remote/distributed-runtime-types.js';
import type {
  UiControlPlaneSnapshot,
  UiLocalAuthSnapshot,
  UiSessionSnapshot,
  UiTasksSnapshot,
} from '../ui-read-models.js';
import type { UiRuntimeEvents } from '../ui-events.js';
import { createClientTransport } from './client-transport.js';
import { createHttpJsonTransport, type HttpJsonTransport } from './http-json-transport.js';
import {
  appendTelemetryQuery,
  buildSessionEnsureBody,
  buildSessionMessageBody,
  buildSteerSessionMessageBody,
  buildTaskSubmitBody,
  buildTransportUrl,
  connectTelemetryStream,
  createJsonRequestInit,
  normalizeTelemetryQuery,
  readControlPlaneSnapshot,
} from './http-helpers.js';
import { createOperatorRemoteClient } from './operator-remote-client.js';
import { createPeerRemoteClient } from './peer-remote-client.js';
import {
  createEventSourceConnector,
  requestJsonRaw,
} from './shared.js';
import type { TransportPaths } from './transport-paths.js';
import type {
  HttpPeerRecordSnapshot,
  HttpPeerSnapshot,
  HttpProvidersSnapshot,
  HttpRemotePairApprovalResponse,
  HttpRemotePairRequestInput,
  HttpRemotePairResponse,
  HttpRemotePairVerificationResponse,
  HttpRemotePeerClaimInput,
  HttpRemotePeerCompleteInput,
  HttpRemotePeerHeartbeatInput,
  HttpRemotePeerInvokeInput,
  HttpRemotePeerInvokeResponse,
  HttpRemotePeerTokenResponse,
  HttpSessionEnsureInput,
  HttpSessionMessageInput,
  HttpSteerSessionMessageInput,
  HttpTaskActionResponse,
  HttpTaskRetryResponse,
  HttpTaskSubmitResponse,
  HttpTransport,
  HttpTransportOperatorClient,
  HttpTransportOptions,
  HttpTransportPeerClient,
  HttpTransportSnapshot,
  HttpTransportTelemetryMetricsSnapshot,
  HttpTransportTelemetryQuery,
} from './http-types.js';
import { createRemoteUiRuntimeEvents } from './ui-runtime-events.js';
import {
  assertObjectField,
  assertObjectOrNullField,
  assertArrayField,
  assertRuntimeTaskArray,
  assertSharedApprovalArray,
  assertProviderRuntimeSnapshotArray,
  assertProviderRuntimeSnapshot,
  assertProviderUsageSnapshot,
  assertTelemetrySnapshot,
  assertTelemetryListResponse,
  assertTelemetryMetricsSnapshot,
  normalizeSharedSessionRecord,
  normalizeSharedSessionMessage,
  normalizeSharedSessionInput,
  normalizeSharedSessionSubmission,
  normalizeTelemetryQueryForSdk,
} from './daemon-http-client-validators.js';

interface RemoteSnapshotResponse extends Record<string, unknown> {
  readonly distributed?: {
    readonly pairRequests?: readonly DistributedRuntimePairRequest[];
    readonly peers?: readonly DistributedPeerRecord[];
    readonly work?: readonly DistributedPendingWork[];
  };
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    typeof error === 'object'
      && error !== null
      && 'transport' in error
      && typeof (error as { transport?: { readonly status?: number } }).transport?.status === 'number'
      && (error as { transport?: { readonly status?: number } }).transport?.status === 404,
  );
}

async function withNullOnNotFound<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function asContractInput(input: object | undefined): Record<string, unknown> | undefined {
  return input as Record<string, unknown> | undefined;
}

function createOperatorClient(
  transport: HttpJsonTransport,
  events: UiRuntimeEvents,
): HttpTransportOperatorClient {
  const paths = transport.paths;
  const token = transport.authToken ?? null;
  const fetchImpl = transport.fetchImpl;
  const operatorApi = createOperatorRemoteClient(transport, getOperatorContract());

  return {
    sessions: {
      current: async (): Promise<UiSessionSnapshot> =>
        await requestJsonRaw(fetchImpl, buildTransportUrl(paths.controlPlaneUrl, '/api/session'), createJsonRequestInit(token)),
      list: async (limit = 100): Promise<readonly SharedSessionRecord[]> =>
        (await operatorApi.sessions.list({ limit })).sessions.map((entry) => normalizeSharedSessionRecord(entry as Record<string, unknown>)),
      get: async (sessionId): Promise<SharedSessionRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.sessions.get(sessionId));
        return response?.session ? normalizeSharedSessionRecord(response.session as Record<string, unknown>) : null;
      },
      messages: async (sessionId, limit = 100): Promise<readonly SharedSessionMessage[]> =>
        (await operatorApi.sessions.messages.list(sessionId, { limit })).messages.map((entry) =>
          normalizeSharedSessionMessage(entry as Record<string, unknown>),
        ),
      inputs: async (sessionId, limit = 100): Promise<readonly SharedSessionInputRecord[]> => {
        const response = await operatorApi.invoke<{ inputs: readonly Record<string, unknown>[] }>('sessions.inputs.list', { sessionId, limit });
        return (response.inputs ?? []).map((entry) => normalizeSharedSessionInput(entry));
      },
      ensureSession: async (input: HttpSessionEnsureInput = {}): Promise<SharedSessionRecord> =>
        normalizeSharedSessionRecord(assertObjectField<Record<string, unknown>>(
          await operatorApi.sessions.create(buildSessionEnsureBody(input)),
          'session',
          'sessions.create',
        )),
      close: async (sessionId): Promise<SharedSessionRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.sessions.close(sessionId));
        return response?.session ? normalizeSharedSessionRecord(response.session as Record<string, unknown>) : null;
      },
      reopen: async (sessionId): Promise<SharedSessionRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.sessions.reopen(sessionId));
        return response?.session ? normalizeSharedSessionRecord(response.session as Record<string, unknown>) : null;
      },
      submitMessage: async (sessionId, input): Promise<SharedSessionSubmission> =>
        normalizeSharedSessionSubmission(await operatorApi.invoke<Record<string, unknown>>(
          'sessions.messages.create',
          { sessionId, ...buildSessionMessageBody(input) },
        )),
      steerMessage: async (sessionId, input): Promise<SharedSessionSubmission> =>
        normalizeSharedSessionSubmission(await operatorApi.invoke<Record<string, unknown>>(
          'sessions.steer',
          { sessionId, ...buildSteerSessionMessageBody(input) },
        )),
      followUpMessage: async (sessionId, input): Promise<SharedSessionSubmission> =>
        normalizeSharedSessionSubmission(await operatorApi.invoke<Record<string, unknown>>(
          'sessions.followUp',
          { sessionId, ...buildSessionMessageBody(input) },
        )),
      cancelInput: async (sessionId, inputId): Promise<SharedSessionInputRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.sessions.inputs.cancel(sessionId, inputId));
        return response?.input ? normalizeSharedSessionInput(response.input as Record<string, unknown>) : null;
      },
    },
    tasks: {
      snapshot: async (): Promise<UiTasksSnapshot> => {
        const { tasks } = await operatorApi.tasks.list();
        return { tasks: assertRuntimeTaskArray(tasks, 'tasks.list') };
      },
      list: async (limit = 100): Promise<readonly RuntimeTask[]> =>
        assertRuntimeTaskArray((await operatorApi.tasks.list({ limit })).tasks, 'tasks.list'),
      get: async (taskId): Promise<RuntimeTask | null> => {
        const response = await withNullOnNotFound(() => operatorApi.tasks.get(taskId));
        if (response?.task == null) return null;
        return assertRuntimeTaskArray([response.task], 'tasks.get')[0] ?? null;
      },
      running: async (): Promise<readonly RuntimeTask[]> =>
        assertRuntimeTaskArray((await operatorApi.tasks.list()).tasks, 'tasks.list').filter((task) => task.status === 'running'),
      submit: async (input): Promise<HttpTaskSubmitResponse> =>
        await operatorApi.invoke<HttpTaskSubmitResponse>('tasks.create', buildTaskSubmitBody(input)),
      cancel: async (taskId): Promise<HttpTaskActionResponse> =>
        await operatorApi.invoke<HttpTaskActionResponse>('tasks.cancel', { taskId }),
      retry: async (taskId): Promise<HttpTaskRetryResponse> =>
        await operatorApi.invoke<HttpTaskRetryResponse>('tasks.retry', { taskId }),
    },
    approvals: {
      list: async (limit = 100): Promise<readonly SharedApprovalRecord[]> =>
        assertSharedApprovalArray((await operatorApi.approvals.list({ limit })).approvals, 'approvals.list'),
      get: async (approvalId): Promise<SharedApprovalRecord | null> => {
        const approvals = await operatorApi.approvals.list({ limit: 200 });
        return (assertSharedApprovalArray(approvals.approvals, 'approvals.list').find((entry) => entry.id === approvalId) ?? null);
      },
      claim: async (approvalId, actor, actorSurface = 'transport', note): Promise<SharedApprovalRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.invoke<{ approval?: SharedApprovalRecord | null }>(
          'approvals.claim',
          { approvalId, actor, actorSurface, ...(note ? { note } : {}) },
        ));
        return response?.approval ?? null;
      },
      approve: async (approvalId, actor, actorSurface = 'transport', note): Promise<SharedApprovalRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.invoke<{ approval?: SharedApprovalRecord | null }>(
          'approvals.approve',
          { approvalId, actor, actorSurface, ...(note ? { note } : {}) },
        ));
        return response?.approval ?? null;
      },
      deny: async (approvalId, actor, actorSurface = 'transport', note): Promise<SharedApprovalRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.invoke<{ approval?: SharedApprovalRecord | null }>(
          'approvals.deny',
          { approvalId, actor, actorSurface, ...(note ? { note } : {}) },
        ));
        return response?.approval ?? null;
      },
      cancel: async (approvalId, actor, actorSurface = 'transport', note): Promise<SharedApprovalRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.invoke<{ approval?: SharedApprovalRecord | null }>(
          'approvals.cancel',
          { approvalId, actor, actorSurface, ...(note ? { note } : {}) },
        ));
        return response?.approval ?? null;
      },
    },
    providers: {
      listIds: async (): Promise<readonly string[]> =>
        assertProviderRuntimeSnapshotArray((await operatorApi.providers.list()).providers, 'providers.list')
          .map((provider) => provider.providerId),
      runtimeSnapshots: async (): Promise<readonly ProviderRuntimeSnapshot[]> =>
        assertProviderRuntimeSnapshotArray((await operatorApi.providers.list()).providers, 'providers.list'),
      runtimeSnapshot: async (providerId): Promise<ProviderRuntimeSnapshot | null> => {
        const response = await withNullOnNotFound(() => operatorApi.providers.get(providerId));
        if (response == null) return null;
        return assertProviderRuntimeSnapshot(response, 'providers.get');
      },
      usageSnapshot: async (providerId): Promise<ProviderUsageSnapshot | null> => {
        const response = await withNullOnNotFound(() => operatorApi.providers.usage(providerId));
        if (response == null) return null;
        return assertProviderUsageSnapshot(response, 'providers.usage');
      },
      accountSnapshot: async (): Promise<Record<string, unknown>> =>
        await operatorApi.accounts.snapshot() as Record<string, unknown>,
      localAuthSnapshot: async (): Promise<UiLocalAuthSnapshot> =>
        await operatorApi.localAuth.status() as UiLocalAuthSnapshot,
      snapshot: async (): Promise<HttpProvidersSnapshot> => {
        const [providerResponse, accountSnapshot, localAuthSnapshot] = await Promise.all([
          operatorApi.providers.list(),
          operatorApi.accounts.snapshot(),
          operatorApi.localAuth.status(),
        ]);
        const runtimeSnapshots = assertProviderRuntimeSnapshotArray(providerResponse.providers, 'providers.list');
        return {
          providerIds: runtimeSnapshots.map((provider: ProviderRuntimeSnapshot) => provider.providerId),
          runtimeSnapshots,
          accountSnapshot,
          localAuthSnapshot: localAuthSnapshot as UiLocalAuthSnapshot,
        };
      },
    },
    controlPlane: {
      snapshot: async (): Promise<UiControlPlaneSnapshot> => await readControlPlaneSnapshot(fetchImpl, paths, token),
      currentAuth: async (): Promise<import('./http-types.js').HttpTransportControlPlaneAuthSnapshot> =>
        await operatorApi.control.auth.current(),
      recentEvents: async (limit = 6): Promise<readonly ControlPlaneRecentEvent[]> =>
        (await operatorApi.invoke<{ messages: readonly ControlPlaneRecentEvent[] }>('control.messages.list', { limit })).messages ?? [],
    },
    telemetry: {
      snapshot: async (query: HttpTransportTelemetryQuery = 20): Promise<TelemetrySnapshot> =>
        assertTelemetrySnapshot(await operatorApi.telemetry.snapshot(normalizeTelemetryQueryForSdk(query, 20)), 'telemetry.snapshot'),
      events: async (query: HttpTransportTelemetryQuery = 100): Promise<TelemetryListResponse<TelemetryRecord>> =>
        assertTelemetryListResponse<TelemetryRecord>(await operatorApi.telemetry.events(normalizeTelemetryQueryForSdk(query, 100)), 'telemetry.events'),
      errors: async (query: HttpTransportTelemetryQuery = 100): Promise<TelemetryListResponse<TelemetryRecord>> =>
        assertTelemetryListResponse<TelemetryRecord>(await operatorApi.telemetry.errors(normalizeTelemetryQueryForSdk(query, 100)), 'telemetry.errors'),
      traces: async (query: HttpTransportTelemetryQuery = 100): Promise<TelemetryListResponse<ReadableSpan>> =>
        assertTelemetryListResponse<ReadableSpan>(await operatorApi.telemetry.traces(normalizeTelemetryQueryForSdk(query, 100)), 'telemetry.traces'),
      metrics: async (query: HttpTransportTelemetryQuery = 100): Promise<HttpTransportTelemetryMetricsSnapshot> =>
        assertTelemetryMetricsSnapshot(await operatorApi.telemetry.metrics(normalizeTelemetryQueryForSdk(query, 100)), 'telemetry.metrics'),
      otlpTraces: async (query: HttpTransportTelemetryQuery = 100) =>
        await operatorApi.telemetry.otlp.traces(normalizeTelemetryQueryForSdk(query, 100)) as Record<string, unknown>,
      otlpLogs: async (query: HttpTransportTelemetryQuery = 100) =>
        await operatorApi.telemetry.otlp.logs(normalizeTelemetryQueryForSdk(query, 100)) as Record<string, unknown>,
      otlpMetrics: async (query: HttpTransportTelemetryQuery = 100) =>
        await operatorApi.telemetry.otlp.metrics(normalizeTelemetryQueryForSdk(query, 100)) as Record<string, unknown>,
      stream: async (handlers, query: HttpTransportTelemetryQuery = 100) => {
        const normalized = normalizeTelemetryQuery(query, 100);
        const url = new URL(paths.telemetryStreamUrl);
        appendTelemetryQuery(url, normalized);
        return await connectTelemetryStream(fetchImpl, url.toString(), token, handlers);
      },
    },
    events,
    shellPaths: paths,
  };
}

function createPeerClient(
  transport: HttpJsonTransport,
): HttpTransportPeerClient {
  const operatorApi = createOperatorRemoteClient(transport, getOperatorContract());
  const peerApi = createPeerRemoteClient(transport, getPeerContract());

  function createPeerTokenClient(tokenValue: string) {
    return createPeerRemoteClient(createHttpJsonTransport({
      baseUrl: transport.baseUrl,
      authToken: tokenValue,
      fetchImpl: transport.fetchImpl,
    }), getPeerContract());
  }

  async function readRemoteSnapshot(): Promise<RemoteSnapshotResponse> {
    return await operatorApi.invoke<RemoteSnapshotResponse>('remote.snapshot');
  }

  async function readNodeHostContractValue(): Promise<DistributedNodeHostContract> {
    return (await operatorApi.invoke<{ contract: DistributedNodeHostContract }>('remote.node_host.contract')).contract;
  }

  async function readPeers(limit = 500): Promise<readonly DistributedPeerRecord[]> {
    return (await operatorApi.invoke<{ peers: readonly DistributedPeerRecord[] }>('remote.peers.list', { limit })).peers ?? [];
  }

  return {
    pairing: {
      listRequests: async (limit = 100): Promise<readonly DistributedRuntimePairRequest[]> =>
        (await operatorApi.invoke<{ requests: readonly DistributedRuntimePairRequest[] }>('remote.pair.requests.list', { limit })).requests ?? [],
      request: async (input): Promise<HttpRemotePairResponse> =>
        await peerApi.invoke<HttpRemotePairResponse>('pair.request', asContractInput(input)),
      approve: async (requestId, actor, note): Promise<HttpRemotePairApprovalResponse | null> =>
        await withNullOnNotFound(() => operatorApi.invoke<HttpRemotePairApprovalResponse>(
          'remote.pair.requests.approve',
          { requestId, actor, ...(note ? { note } : {}) },
        )),
      reject: async (requestId, actor, note): Promise<DistributedRuntimePairRequest | null> => {
        const response = await withNullOnNotFound(() => operatorApi.invoke<{ request?: DistributedRuntimePairRequest | null }>(
          'remote.pair.requests.reject',
          { requestId, actor, ...(note ? { note } : {}) },
        ));
        return response?.request ?? null;
      },
      verify: async (requestId, challenge, remoteAddress): Promise<HttpRemotePairVerificationResponse | null> =>
        await withNullOnNotFound(() => peerApi.invoke<HttpRemotePairVerificationResponse>(
          'pair.verify',
          { requestId, challenge, ...(remoteAddress ? { remoteAddress } : {}) },
        )),
    },
    peers: {
      list: async (kind?: DistributedPeerKind, limit = 200): Promise<readonly DistributedPeerRecord[]> =>
        (await operatorApi.invoke<{ peers: readonly DistributedPeerRecord[] }>('remote.peers.list', {
          ...(kind ? { kind } : {}),
          limit,
        })).peers ?? [],
      get: async (peerId): Promise<DistributedPeerRecord | null> => {
        const response = await operatorApi.invoke<{ peers: readonly DistributedPeerRecord[] }>('remote.peers.list', { limit: 500 });
        return (response.peers ?? []).find((peer) => peer.id === peerId) ?? null;
      },
      getSnapshot: async (peerId): Promise<HttpPeerRecordSnapshot | null> => {
        const [snapshot, contract, peers] = await Promise.all([
          readRemoteSnapshot(),
          readNodeHostContractValue(),
          readPeers(),
        ]);
        const pairRequests = (snapshot.distributed?.pairRequests ?? []).filter((entry) => entry.peerId === peerId || entry.requestedId === peerId);
        const work = (snapshot.distributed?.work ?? []).filter((entry) => entry.peerId === peerId);
        const peer = peers.find((entry) => entry.id === peerId) ?? null;
        if (!peer && pairRequests.length === 0 && work.length === 0) {
          return null;
        }
        return {
          peerId,
          peer,
          pairRequests,
          work,
          nodeHostContract: contract,
        };
      },
      heartbeat: async (tokenValue, input = {}): Promise<{ peer: DistributedPeerRecord }> =>
        await createPeerTokenClient(tokenValue).invoke<{ peer: DistributedPeerRecord }>('peer.heartbeat', asContractInput(input)),
      rotateToken: async (peerId, actor, label, scopes): Promise<HttpRemotePeerTokenResponse | null> =>
        await withNullOnNotFound(() => operatorApi.invoke<HttpRemotePeerTokenResponse>(
          'remote.peers.token.rotate',
          {
            peerId,
            actor,
            ...(label ? { label } : {}),
            ...(scopes ? { scopes } : {}),
          },
        )),
      revokeToken: async (peerId, actor, tokenId, note): Promise<DistributedPeerRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.invoke<{ peer?: DistributedPeerRecord | null }>(
          'remote.peers.token.revoke',
          {
            peerId,
            actor,
            ...(tokenId ? { tokenId } : {}),
            ...(note ? { note } : {}),
          },
        ));
        return response?.peer ?? null;
      },
      disconnect: async (peerId, actor, note, requeueClaimedWork = true): Promise<DistributedPeerRecord | null> => {
        const response = await withNullOnNotFound(() => operatorApi.invoke<{ peer?: DistributedPeerRecord | null }>(
          'remote.peers.disconnect',
          {
            peerId,
            actor,
            ...(note ? { note } : {}),
            requeueClaimedWork,
          },
        ));
        return response?.peer ?? null;
      },
    },
    work: {
      list: async (limit = 200, peerId?: string): Promise<readonly DistributedPendingWork[]> =>
        (await operatorApi.invoke<{ work: readonly DistributedPendingWork[] }>('remote.work.list', {
          ...(peerId ? { peerId } : {}),
          limit,
        })).work ?? [],
      invoke: async (input): Promise<HttpRemotePeerInvokeResponse> =>
        await operatorApi.invoke<HttpRemotePeerInvokeResponse>('remote.peers.invoke', asContractInput(input)),
      claim: async (tokenValue, input = {}): Promise<readonly DistributedPendingWork[]> =>
        (await createPeerTokenClient(tokenValue).invoke<{ work: readonly DistributedPendingWork[] }>('work.pull', asContractInput(input))).work ?? [],
      complete: async (tokenValue, workId, input = {}): Promise<DistributedPendingWork | null> => {
        const response = await withNullOnNotFound(() => createPeerTokenClient(tokenValue).invoke<{ work?: DistributedPendingWork | null }>(
          'work.complete',
          { workId, ...(input as object) },
        ));
        return response?.work ?? null;
      },
      cancel: async (workId, actor, note): Promise<DistributedPendingWork | null> => {
        const response = await withNullOnNotFound(() => operatorApi.invoke<{ work?: DistributedPendingWork | null }>(
          'remote.work.cancel',
          {
            workId,
            actor,
            ...(note ? { reason: note } : {}),
          },
        ));
        return response?.work ?? null;
      },
    },
    getSnapshot: async (): Promise<HttpPeerSnapshot> => {
      const [remoteSnapshot, contract, peers] = await Promise.all([
        readRemoteSnapshot(),
        readNodeHostContractValue(),
        readPeers(),
      ]);
      return {
        capturedAt: Date.now(),
        nodeHostContract: contract,
        remoteSnapshot,
        pairRequests: remoteSnapshot.distributed?.pairRequests ?? [],
        peers,
        work: remoteSnapshot.distributed?.work ?? [],
      };
    },
    getNodeHostContract: async (): Promise<DistributedNodeHostContract> => await readNodeHostContractValue(),
  };
}

export function createHttpTransport(options: HttpTransportOptions): HttpTransport {
  const httpClient = createHttpJsonTransport({
    baseUrl: options.baseUrl,
    authToken: options.authToken,
    fetchImpl: options.fetchImpl,
  });
  const fetchImpl = httpClient.fetchImpl;
  const paths = httpClient.paths;
  const events = createRemoteUiRuntimeEvents(createEventSourceConnector(httpClient.baseUrl, options.authToken, fetchImpl));
  const operator = createOperatorClient(httpClient, events);
  const peer = createPeerClient(httpClient);
  const transport = createClientTransport('http', operator, peer);

  return Object.freeze({
    ...transport,
    async snapshot(): Promise<HttpTransportSnapshot> {
      const [currentSession, tasks, approvals, sessions, controlPlane, providers, remoteSnapshot, nodeHostContract, peerSnapshot] = await Promise.all([
        operator.sessions.current(),
        operator.tasks.snapshot(),
        operator.approvals.list(),
        operator.sessions.list(),
        operator.controlPlane.snapshot(),
        operator.providers.snapshot(),
        requestJsonRaw<Record<string, unknown>>(fetchImpl, paths.remoteUrl, createJsonRequestInit(options.authToken)),
        peer.getNodeHostContract(),
        peer.getSnapshot(),
      ]);
      return {
        kind: 'http',
        operator: {
          currentSession,
          tasks,
          approvals,
          sessions,
          controlPlane,
          providers,
          shellPaths: paths,
        },
        peer: {
          ...peerSnapshot,
          nodeHostContract,
          remoteSnapshot,
        },
      };
    },
  });
}
