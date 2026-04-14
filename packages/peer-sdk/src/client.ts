import type { PeerEndpointContract, PeerEndpointId } from '@goodvibes/contracts';
import { getPeerContract } from '@goodvibes/contracts';
import { createHttpTransport, type HttpTransport, type HttpTransportOptions } from '@goodvibes/transport-http';
import {
  createPeerRemoteClient,
  type PeerRemoteClient,
  type PeerRemoteClientInvokeOptions,
} from './client-core.js';

export interface PeerSdkOptions extends HttpTransportOptions {}

export interface PeerInvokeOptions extends PeerRemoteClientInvokeOptions {}

export type PeerSdk =
  & Omit<PeerRemoteClient, 'getEndpoint'>
  & {
    readonly transport: HttpTransport;
    getEndpoint(endpointId: PeerEndpointId): PeerEndpointContract;
  };

export function createPeerSdk(options: PeerSdkOptions): PeerSdk {
  const transport = createHttpTransport(options);
  return createPeerRemoteClient(transport, getPeerContract()) as PeerSdk;
}
