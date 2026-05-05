import { describe, expect, test } from 'bun:test';
import { firstJsonSchemaFailure } from '../packages/transport-http/src/index.js';
import { REMOTE_SNAPSHOT_SCHEMA } from '../packages/sdk/src/platform/control-plane/operator-contract-schemas-remote.js';
import { IntegrationHelperService } from '../packages/sdk/src/platform/runtime/integration/helpers.js';

describe('IntegrationHelperService remote snapshot', () => {
  test('serializes distributed runtime state with the public remote.snapshot contract shape', () => {
    const helpers = new IntegrationHelperService({
      runtimeStore: {
        getState: () => ({
          daemon: {
            transportState: 'running',
            isRunning: true,
            reconnectAttempts: 0,
            runningJobCount: 0,
            lastError: undefined,
          },
          acp: {
            managerTransportState: 'idle',
            activeConnectionIds: [],
            totalSpawned: 0,
            totalFailed: 0,
            connections: new Map(),
          },
        }),
      },
      remoteRunnerRegistry: {
        listContracts: () => [],
        listPools: () => [],
        listArtifacts: () => [],
      },
      remoteSupervisor: {
        getSnapshot: () => ({
          sessions: [],
          degradedConnections: 0,
          capturedAt: 1,
        }),
      },
      distributedRuntime: {
        getSnapshot: () => ({
          pairRequests: { total: 0, pending: 0, approved: 0, entries: [] },
          peers: { total: 0, connected: 0, nodes: 0, devices: 0, entries: [] },
          work: { total: 0, queued: 0, claimed: 0, completed: 0, failed: 0, cancelled: 0, entries: [] },
          audit: [],
        }),
        listPairRequests: () => [],
        listPeers: () => [],
        listWork: () => [],
        listAudit: () => [],
      },
    } as never);

    const snapshot = helpers.getRemoteSnapshot();
    const distributed = snapshot.distributed as Record<string, unknown>;

    expect(Array.isArray(distributed.pairRequests)).toBe(true);
    expect(Array.isArray(distributed.peers)).toBe(true);
    expect(Array.isArray(distributed.work)).toBe(true);
    expect(Array.isArray(distributed.audit)).toBe(true);
    expect(firstJsonSchemaFailure(REMOTE_SNAPSHOT_SCHEMA, snapshot)).toBeUndefined();
  });
});
