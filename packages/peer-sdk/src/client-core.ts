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

export interface PeerRemoteClientInvokeOptions extends ContractInvokeOptions {}

export interface PeerRemoteClientOptions {
  readonly validateResponses?: boolean;
}

type KnownEndpointArgs<TEndpointId extends PeerTypedEndpointId> = MethodArgs<
  PeerEndpointInput<TEndpointId>,
  PeerRemoteClientInvokeOptions
>;

type KnownPathEndpointArgs<
  TEndpointId extends PeerTypedEndpointId,
  TKeys extends PropertyKey,
> = MethodArgs<
  WithoutKeys<PeerEndpointInput<TEndpointId>, TKeys>,
  PeerRemoteClientInvokeOptions
>;

export interface PeerRemoteClient {
  readonly transport: HttpTransport;
  readonly contract: PeerContractManifest;
  listOperations(): readonly PeerEndpointContract[];
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
    `Response validation failed for peer endpoint "${endpoint.id}": field "${failure.path}" expected ${failure.expected} but received ${failure.received}. Ensure the peer daemon is running the matching GoodVibes contract version.`,
    { source: 'contract' },
  );
}
