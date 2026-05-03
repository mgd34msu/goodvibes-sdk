import type { PeerEndpointContract, PeerEndpointId } from '@pellux/goodvibes-contracts';
import { getPeerContract } from '@pellux/goodvibes-contracts';
import { createHttpTransport, type HttpTransport, type HttpTransportOptions } from '@pellux/goodvibes-transport-http';
import {
  createPeerRemoteClient,
  type PeerRemoteClient,
  type PeerRemoteClientInvokeOptions,
} from './client-core.js';

export interface PeerSdkOptions extends HttpTransportOptions {
  /**
   * When `true` (default), response bodies are checked against the peer
   * contract's JSON Schema shape before typed calls return.
   */
  readonly validateResponses?: boolean;
}

/**
 * Public invocation options intentionally wrap the remote-client options so
 * peer-sdk can add peer-specific fields without changing the generic remote
 * client contract.
 */
export interface PeerInvokeOptions extends PeerRemoteClientInvokeOptions {}

export type PeerSdk =
  & Omit<PeerRemoteClient, 'getOperation'>
  & {
    readonly transport: HttpTransport;
    getOperation(endpointId: PeerEndpointId): PeerEndpointContract;
    dispose(): void;
    asyncDispose(): Promise<void>;
    [Symbol.dispose](): void;
    [Symbol.asyncDispose](): Promise<void>;
  };

export function createPeerSdk(options: PeerSdkOptions): PeerSdk {
  const transport = createHttpTransport(options);
  const remote = createPeerRemoteClient(transport, getPeerContract(), {
    validateResponses: options.validateResponses !== false,
  });
  return {
    ...remote,
    getOperation(endpointId: PeerEndpointId): PeerEndpointContract {
      return remote.getOperation(endpointId);
    },
    dispose(): void {
      // HTTP transports do not hold sockets today, but exposing disposal on the
      // SDK object gives callers a stable lifecycle hook as transports evolve.
    },
    async asyncDispose(): Promise<void> {
      this.dispose();
    },
    [Symbol.dispose](): void {
      this.dispose();
    },
    async [Symbol.asyncDispose](): Promise<void> {
      this.dispose();
    },
  };
}
