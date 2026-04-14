// Synced from packages/peer-sdk/src/client.ts
import type { PeerEndpointContract, PeerEndpointId } from '../contracts/index.js';
import { getPeerContract } from '../contracts/index.js';
import { createHttpTransport, type HttpTransport, type HttpTransportOptions } from '../transport-http/index.js';
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
