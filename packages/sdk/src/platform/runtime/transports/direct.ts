import type { SharedApprovalRecord, SharedSessionRecord } from '../../control-plane/index.js';
import {
  createDirectTransportServices,
  type DirectTransportServices,
} from '../foundation-services.js';
import { createOperatorClient, type OperatorClient, type OperatorControlPlaneSnapshot, type OperatorProvidersSnapshot } from '../operator-client.js';
import { createPeerClient, type PeerClient, type PeerClientSnapshot } from '../peer-client.js';
import type { RuntimeServices } from '../services.js';
import type { UiSessionSnapshot, UiTasksSnapshot } from '../ui-read-models.js';
import type { ShellPathService } from '../shell-paths.js';
import { createDirectClientTransport } from './direct-client.js';
import type { DirectClientTransport } from './direct-client.js';
export { createDirectClientTransport } from './direct-client.js';
export type { DirectClientTransport } from './direct-client.js';

export interface DirectTransportSnapshot {
  readonly kind: 'direct';
  readonly operator: {
    readonly currentSession: UiSessionSnapshot;
    readonly tasks: UiTasksSnapshot;
    readonly approvals: readonly SharedApprovalRecord[];
    readonly sessions: readonly SharedSessionRecord[];
    readonly controlPlane: OperatorControlPlaneSnapshot;
    readonly providers: OperatorProvidersSnapshot;
    readonly shellPaths: ShellPathService;
  };
  readonly peer: PeerClientSnapshot;
}

export interface DirectTransport {
  readonly kind: 'direct';
  readonly operator: OperatorClient;
  readonly peer: PeerClient;
  getOperatorClient(): OperatorClient;
  getPeerClient(): PeerClient;
  snapshot(): Promise<DirectTransportSnapshot>;
}

export function createDirectTransportFromServices(services: DirectTransportServices): DirectTransport {
  const operator = createOperatorClient(services.operator);
  const peer = createPeerClient(services.peer);
  const transport = createDirectClientTransport(operator, peer);

  return Object.freeze({
    ...transport,
    async snapshot(): Promise<DirectTransportSnapshot> {
      const [providers] = await Promise.all([
        operator.providers.snapshot(),
      ]);
      return {
        kind: 'direct',
        operator: {
          currentSession: operator.sessions.current(),
          tasks: operator.tasks.snapshot(),
          approvals: operator.approvals.list(),
          sessions: operator.sessions.list(),
          controlPlane: operator.controlPlane.snapshot(),
          providers,
          shellPaths: operator.shellPaths,
        },
        peer: peer.getSnapshot(),
      };
    },
  });
}

export function createRuntimeDirectTransport(runtimeServices: RuntimeServices): DirectTransport {
  return createDirectTransportFromServices(createDirectTransportServices(runtimeServices));
}

export function createDirectTransport(runtimeServices: RuntimeServices): DirectTransport {
  return createRuntimeDirectTransport(runtimeServices);
}
