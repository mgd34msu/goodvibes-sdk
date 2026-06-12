import type { PeerEndpointContract, PeerEndpointId } from '@pellux/goodvibes-contracts';
import { getPeerContract } from '@pellux/goodvibes-contracts';
import { createHttpTransport, type HttpTransport, type HttpTransportOptions } from '@pellux/goodvibes-transport-http';
import {
  createPeerRemoteClient,
  type PeerRemoteClient,
  type PeerRemoteClientInvokeOptions,
} from './client-core.js';

/**
 * Peer-SDK-specific behaviour flags (not transport configuration).
 */
export interface PeerSdkBehaviorOptions {
  /**
   * When `true` (default), response bodies are checked against the peer
   * contract's JSON Schema shape before typed calls return.
   *
   * @defaultValue true
   */
  readonly validateResponses?: boolean | undefined;
}

/**
 * Options for `createPeerSdk`. Combines HTTP transport options with
 * peer-SDK behaviour flags.
 */
export type PeerSdkOptions = HttpTransportOptions & PeerSdkBehaviorOptions;

/**
 * Per-call options for `sdk.peer.invoke()`.
 *
 * Extends the underlying transport invoke options — see `ContractInvokeOptions`
 * for available fields (e.g. `signal`, `responseSchema`).
 */
export interface PeerInvokeOptions extends PeerRemoteClientInvokeOptions {}

/**
 * The peer-level SDK instance for peer-to-peer and collaboration APIs.
 *
 * Exposes pairing, heartbeat, work-pull/complete, and operator-snapshot
 * endpoints as typed namespaced methods, plus the underlying HTTP transport
 * and lifecycle disposal hooks.
 *
 * Obtain via `createGoodVibesSdk({ ... }).peer` or `createPeerSdk()`.
 *
 * @example
 * import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';
 *
 * const sdk = createGoodVibesSdk({ baseUrl: 'https://daemon.example.com', authToken: token });
 * const pairState = await sdk.peer.pairing.request({ peerKind: 'agent' });
 */
export type PeerSdk =
  & Omit<PeerRemoteClient, 'getOperation'>
  & {
    /** The underlying HTTP transport; use to attach middleware or issue raw requests. */
    readonly transport: HttpTransport;
    /**
     * Look up a contract endpoint descriptor by its string id.
     * @param endpointId - The peer contract endpoint id (e.g. `'pair.request'`).
     * @throws `GoodVibesSdkError` when the endpoint id is not in the contract.
     */
    getOperation(endpointId: PeerEndpointId): PeerEndpointContract;
    /** Release any resources held by this SDK instance. Safe to call more than once. */
    dispose(): void;
    /** Async variant of `dispose()`. */
    asyncDispose(): Promise<void>;
    [Symbol.dispose](): void;
    [Symbol.asyncDispose](): Promise<void>;
  };

/**
 * Create a standalone peer SDK client.
 *
 * In most cases use `createGoodVibesSdk()` instead, which wires up operator,
 * auth, and realtime events alongside the peer client. Use this factory
 * directly only when you need a lean peer-only client.
 *
 * @param options - Transport and validation options.
 * @returns A `PeerSdk` instance ready to make requests to the peer API.
 */
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
      return this.asyncDispose();
    },
  };
}
