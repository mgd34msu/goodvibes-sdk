import { ContractError } from '@pellux/goodvibes-errors';
import type { PeerContractManifest, PeerEndpointContract } from '@pellux/goodvibes-contracts';
import type {
  PeerEndpointInput,
  PeerEndpointOutput,
  PeerTypedEndpointId,
} from '@pellux/goodvibes-contracts';
import type { HttpTransport } from '@pellux/goodvibes-transport-http';
import {
  firstJsonSchemaFailure,
  invokeContractRoute,
  mergeClientInput,
  requireContractRoute,
  type ContractInvokeOptions,
  type ContractRouteDefinition,
  type ContractRouteLike,
  splitClientArgs,
  type MethodArgs,
  type WithoutKeys,
} from '@pellux/goodvibes-transport-http';

/** Per-call options forwarded to the transport's `invokeContractRoute`. */
export interface PeerRemoteClientInvokeOptions extends ContractInvokeOptions {}

/** Internal options for `createPeerRemoteClient`. */
export interface PeerRemoteClientOptions {
  /**
   * When `true` (default), response bodies are checked against the peer
   * contract's JSON Schema shape.
   *
   * @defaultValue true
   */
  readonly validateResponses?: boolean | undefined;
}

/**
 * Argument tuple for a fully-typed `invoke()` call on a given peer endpoint id.
 * Used internally by the named-endpoint facades (e.g. `sdk.peer.pairing.request`).
 */
export type KnownEndpointArgs<TEndpointId extends PeerTypedEndpointId> = MethodArgs<
  PeerEndpointInput<TEndpointId>,
  PeerRemoteClientInvokeOptions
>;

/**
 * Like `KnownEndpointArgs` but with some input keys omitted (used for
 * path-parameter endpoints whose prefix keys are positional function arguments).
 */
export type KnownPathEndpointArgs<
  TEndpointId extends PeerTypedEndpointId,
  TKeys extends PropertyKey,
> = MethodArgs<
  WithoutKeys<PeerEndpointInput<TEndpointId>, TKeys>,
  PeerRemoteClientInvokeOptions
>;

/**
 * Low-level peer remote client. Returned by `createPeerRemoteClient`.
 * Prefer `PeerSdk` (from `createPeerSdk`) which adds typed endpoint facades.
 */
export interface PeerRemoteClient {
  /** The underlying HTTP transport used to issue all requests. */
  readonly transport: HttpTransport;
  /** The peer contract manifest describing all available endpoints. */
  readonly contract: PeerContractManifest;
  /** Return all endpoint descriptors in the peer contract. */
  listOperations(): readonly PeerEndpointContract[];
  /**
   * Look up a contract endpoint descriptor by its string id.
   * @throws `GoodVibesSdkError` when the endpoint id is not in the contract.
   */
  getOperation(endpointId: string): PeerEndpointContract;
  invoke<TEndpointId extends PeerTypedEndpointId>(
    endpointId: TEndpointId,
    ...args: KnownEndpointArgs<TEndpointId>
  ): Promise<PeerEndpointOutput<TEndpointId>>;
  invoke<T = unknown>(
    endpointId: string,
    input?: Record<string, unknown>,
    options?: PeerRemoteClientInvokeOptions,
  ): Promise<T>;
  readonly pairing: {
    request(...args: KnownEndpointArgs<'pair.request'>): Promise<PeerEndpointOutput<'pair.request'>>;
    verify(...args: KnownEndpointArgs<'pair.verify'>): Promise<PeerEndpointOutput<'pair.verify'>>;
  };
  readonly peer: {
    heartbeat(...args: KnownEndpointArgs<'peer.heartbeat'>): Promise<PeerEndpointOutput<'peer.heartbeat'>>;
  };
  readonly work: {
    pull(...args: KnownEndpointArgs<'work.pull'>): Promise<PeerEndpointOutput<'work.pull'>>;
    complete(workId: string, ...args: KnownPathEndpointArgs<'work.complete', 'workId'>): Promise<PeerEndpointOutput<'work.complete'>>;
  };
  readonly operator: {
    snapshot(...args: KnownEndpointArgs<'operator.snapshot'>): Promise<PeerEndpointOutput<'operator.snapshot'>>;
  };
}

function requireEndpoint(
  contract: PeerContractManifest,
  endpointId: string,
): PeerEndpointContract & ContractRouteDefinition & ContractRouteLike {
  return requireContractRoute(contract.endpoints, endpointId, 'peer endpoint');
}

/**
 * Construct a low-level peer remote client from a transport and contract manifest.
 *
 * Typically called by `createPeerSdk`; use that factory unless you need to
 * supply a custom contract manifest or a non-standard transport.
 *
 * @param transport - The HTTP transport to use for all requests.
 * @param contract - The peer contract manifest.
 * @param clientOptions - Optional response validation settings.
 * @returns A `PeerRemoteClient` with typed invoke methods.
 */
export function createPeerRemoteClient(
  transport: HttpTransport,
  contract: PeerContractManifest,
  clientOptions: PeerRemoteClientOptions = {},
): PeerRemoteClient {
  function invokeTyped<TEndpointId extends PeerTypedEndpointId>(
    endpointId: TEndpointId,
    ...args: KnownEndpointArgs<TEndpointId>
  ): Promise<PeerEndpointOutput<TEndpointId>>;
  function invokeTyped<T = unknown>(
    endpointId: string,
    input?: Record<string, unknown>,
    options?: PeerRemoteClientInvokeOptions,
  ): Promise<T>;
  function invokeTyped<T = unknown>(
    endpointId: string,
    input?: Record<string, unknown>,
    options: PeerRemoteClientInvokeOptions = {},
  ): Promise<T> {
    const endpoint = requireEndpoint(contract, endpointId);
    return invokeContractRoute<T>(transport, endpoint, input, options).then((body) => {
      if (clientOptions.validateResponses !== false) validateJsonSchemaResponse(endpoint, body);
      return body;
    });
  }

  const client: PeerRemoteClient = {
    transport,
    contract,
    listOperations(): readonly PeerEndpointContract[] {
      return contract.endpoints;
    },
    getOperation(endpointId: string): PeerEndpointContract {
      return requireEndpoint(contract, endpointId);
    },
    invoke: invokeTyped,
    pairing: {
      request: (...args) => invokeTyped('pair.request', ...args),
      verify: (...args) => invokeTyped('pair.verify', ...args),
    },
    peer: {
      heartbeat: (...args) => invokeTyped('peer.heartbeat', ...args),
    },
    work: {
      pull: (...args) => invokeTyped('work.pull', ...args),
      complete: (workId, ...args) => {
        const [input, options] = splitClientArgs<WithoutKeys<PeerEndpointInput<'work.complete'>, 'workId'>, PeerRemoteClientInvokeOptions>(args);
        return invokeTyped('work.complete', mergeClientInput({ workId }, input), options);
      },
    },
    operator: {
      snapshot: (...args) => invokeTyped('operator.snapshot', ...args),
    },
  };

  return client;
}

function validateJsonSchemaResponse(endpoint: PeerEndpointContract, body: unknown): void {
  const schema = endpoint.outputSchema;
  if (!schema || typeof schema !== 'object') return;
  const failure = firstJsonSchemaFailure(schema as Record<string, unknown>, body);
  if (!failure) return;
  throw new ContractError(
    `Response validation failed for peer endpoint "${endpoint.id}": field "${failure.path}" expected ${failure.expected} but received ${failure.received}. Ensure the peer endpoint and client are using the same GoodVibes contract package version.`,
    { source: 'contract' },
  );
}
