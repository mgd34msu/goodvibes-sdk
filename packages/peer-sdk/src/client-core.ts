import { ContractError } from '@pellux/goodvibes-errors';
import type { PeerContractManifest, PeerEndpointContract } from '@pellux/goodvibes-contracts';
import type {
  PeerEndpointInput,
  PeerEndpointOutput,
  PeerTypedEndpointId,
} from '@pellux/goodvibes-contracts';
import type { HttpTransport } from '@pellux/goodvibes-transport-http';
import {
  buildContractInput,
  invokeContractRoute,
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
  listEndpoints(): readonly PeerEndpointContract[];
  getEndpoint(endpointId: string): PeerEndpointContract;
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
    listEndpoints(): readonly PeerEndpointContract[] {
      return contract.endpoints;
    },
    getEndpoint(endpointId: string): PeerEndpointContract {
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
        const [input, options] = splitClientArgs(args as readonly [WithoutKeys<PeerEndpointInput<'work.complete'>, 'workId'>?, PeerRemoteClientInvokeOptions?]);
        return invokeTyped('work.complete', buildContractInput('workId', workId, input as Record<string, unknown> | undefined), options);
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
  const failure = firstJsonSchemaFailure(schema as Record<string, unknown>, body, '$');
  if (!failure) return;
  throw new ContractError(
    `Response validation failed for peer endpoint "${endpoint.id}": field "${failure.path}" expected ${failure.expected} but received ${failure.received}. Ensure the peer daemon is running a compatible GoodVibes version.`,
    { source: 'contract' },
  );
}

interface JsonSchemaFailure {
  readonly path: string;
  readonly expected: string;
  readonly received: string;
}

function firstJsonSchemaFailure(schema: Record<string, unknown>, value: unknown, path: string): JsonSchemaFailure | undefined {
  if (typeof schema.$ref === 'string') return undefined;
  const allOf = readSchemaList(schema.allOf);
  for (const child of allOf) {
    const failure = firstJsonSchemaFailure(child, value, path);
    if (failure) return failure;
  }
  const anyOf = readSchemaList(schema.anyOf);
  if (anyOf.length > 0) {
    const failures = anyOf.map((child) => firstJsonSchemaFailure(child, value, path));
    if (failures.every(Boolean)) return failures[0] ?? { path, expected: 'one matching schema', received: typeOfJsonValue(value) };
  }
  const oneOf = readSchemaList(schema.oneOf);
  if (oneOf.length > 0) {
    const matches = oneOf.filter((child) => !firstJsonSchemaFailure(child, value, path)).length;
    if (matches !== 1) return { path, expected: 'exactly one matching schema', received: `${matches} matches` };
  }
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.some((candidate) => Object.is(candidate, value))) {
    return { path, expected: `one of ${enumValues.map(String).join(', ')}`, received: typeOfJsonValue(value) };
  }
  if ('const' in schema && !Object.is(schema.const, value)) {
    return { path, expected: JSON.stringify(schema.const), received: typeOfJsonValue(value) };
  }
  const types = readSchemaTypes(schema.type);
  if (types.length > 0 && !types.some((type) => valueMatchesJsonType(value, type))) {
    return { path, expected: types.join(' | '), received: typeOfJsonValue(value) };
  }
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const itemSchema = schema.items;
    if (itemSchema && typeof itemSchema === 'object' && !Array.isArray(itemSchema)) {
      for (let index = 0; index < value.length; index++) {
        const failure = firstJsonSchemaFailure(itemSchema as Record<string, unknown>, value[index], `${path}[${index}]`);
        if (failure) return failure;
      }
    }
    return undefined;
  }
  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [];
    for (const key of required) {
      if (!(key in objectValue)) return { path: `${path}.${key}`, expected: 'required field', received: 'missing' };
    }
    const properties = schema.properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [key, propertySchema] of Object.entries(properties as Record<string, unknown>)) {
        if (!(key in objectValue)) continue;
        if (!propertySchema || typeof propertySchema !== 'object' || Array.isArray(propertySchema)) continue;
        const failure = firstJsonSchemaFailure(propertySchema as Record<string, unknown>, objectValue[key], `${path}.${key}`);
        if (failure) return failure;
      }
    }
  }
  return undefined;
}

function readSchemaList(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)));
}

function readSchemaTypes(type: unknown): string[] {
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

function valueMatchesJsonType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return true;
}

function typeOfJsonValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
