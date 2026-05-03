import type {
  OperatorMethodContract,
  OperatorMethodId,
} from '@pellux/goodvibes-contracts';
import { getOperatorContract } from '@pellux/goodvibes-contracts';
import * as ContractZodSchemas from '@pellux/goodvibes-contracts';
import {
  createHttpTransport,
  type HttpTransport,
  type HttpTransportOptions,
} from '@pellux/goodvibes-transport-http';
import {
  createOperatorRemoteClient,
  type OperatorRemoteClient,
  type OperatorRemoteClientInvokeOptions,
  type OperatorRemoteClientStreamOptions,
} from './client-core.js';
import type { ZodType } from 'zod/v4';

export interface OperatorSdkOptions extends HttpTransportOptions {
  /**
   * When `true` (default), response bodies for typed operator methods are
   * validated against their Zod contract schemas. Set to `false` to opt out.
   * This is useful when a caller wants raw response bodies for contract
   * debugging or benchmarking.
   */
  readonly validateResponses?: boolean;
}

/**
 * Public invocation options intentionally wrap the remote-client options so
 * operator-sdk can add operator-specific fields without changing the generic
 * remote client contract.
 */
export interface OperatorInvokeOptions extends OperatorRemoteClientInvokeOptions {}

/**
 * Public stream options intentionally wrap the remote-client stream options so
 * operator-sdk can add stream-specific surface fields while keeping the
 * generic client contract stable.
 */
export interface OperatorStreamOptions extends OperatorRemoteClientStreamOptions {}

export type OperatorSdk =
  & Omit<OperatorRemoteClient, 'getOperation'>
  & {
    readonly transport: HttpTransport;
    getOperation(methodId: OperatorMethodId): OperatorMethodContract;
    dispose(): void;
    asyncDispose(): Promise<void>;
  };

type ZodSchemaExports = Record<string, unknown>;

const OPERATOR_RESPONSE_SCHEMA_EXPORTS: Partial<Record<OperatorMethodId, string>> = {
  'accounts.snapshot': 'AccountsSnapshotResponseSchema',
  'control.auth.current': 'ControlAuthCurrentResponseSchema',
  'control.auth.login': 'ControlAuthLoginResponseSchema',
  'control.status': 'ControlStatusResponseSchema',
  'local_auth.status': 'LocalAuthStatusResponseSchema',
};

function isZodSchema(value: unknown): value is ZodType {
  return Boolean(value && typeof value === 'object' && 'safeParse' in value && typeof (value as { readonly safeParse?: unknown }).safeParse === 'function');
}

function buildSchemaRegistry(methodIds: readonly string[], schemas: ZodSchemaExports): Partial<Record<string, ZodType>> {
  const registry: Partial<Record<string, ZodType>> = {};
  for (const methodId of methodIds) {
    const exportName = OPERATOR_RESPONSE_SCHEMA_EXPORTS[methodId as OperatorMethodId];
    if (!exportName) continue;
    const schema = schemas[exportName];
    if (!isZodSchema(schema)) continue;
    registry[methodId] = schema;
  }
  return registry;
}

export function createOperatorSdk(options: OperatorSdkOptions): OperatorSdk {
  const validateResponses = options.validateResponses !== false;
  const transport = createHttpTransport(options);
  const contract = getOperatorContract();
  const schemaRegistry = validateResponses
    ? buildSchemaRegistry(contract.operator.methods.map((method) => method.id), ContractZodSchemas)
    : {};
  const remote = createOperatorRemoteClient(transport, contract, {
    validateResponses,
    getResponseSchema: validateResponses
      ? (methodId) => schemaRegistry[methodId]
      : undefined,
  });
  return {
    ...remote,
    getOperation(methodId: OperatorMethodId): OperatorMethodContract {
      return remote.getOperation(methodId);
    },
    dispose(): void {
      // HTTP transports do not hold sockets today, but exposing disposal on the
      // SDK object gives callers a stable lifecycle hook as transports evolve.
    },
    async asyncDispose(): Promise<void> {
      this.dispose();
    },
  };
}
