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
    [Symbol.dispose](): void;
    [Symbol.asyncDispose](): Promise<void>;
  };

function isZodSchema(value: unknown): value is ZodType {
  return Boolean(value && typeof value === 'object' && 'safeParse' in value && typeof (value as { readonly safeParse?: unknown }).safeParse === 'function');
}

/**
 * Auto-derives a method-ID → ZodType registry from the contracts namespace by
 * scanning all exported names that end with `ResponseSchema` and are valid Zod
 * schemas. New response schemas added to the contracts package are picked up
 * automatically without requiring manual updates here.
 */
function buildSchemaRegistry(schemas: Record<string, unknown>): Partial<Record<string, ZodType>> {
  const registry: Partial<Record<string, ZodType>> = {};
  for (const [key, value] of Object.entries(schemas)) {
    if (!key.endsWith('ResponseSchema')) continue;
    if (!isZodSchema(value)) continue;
    // Derive the method ID from the export name by converting PascalCase segments
    // to dot-separated lowercase method-ID form.
    // e.g. "ControlAuthLoginResponseSchema" → "control.auth.login"
    const methodId = key
      .replace(/ResponseSchema$/, '')
      .replace(/([A-Z])/g, (c, i) => (i === 0 ? '' : '.') + c.toLowerCase())
      .replace(/^\./, '');
    registry[methodId] = value;
  }
  return registry;
}

export function createOperatorSdk(options: OperatorSdkOptions): OperatorSdk {
  const validateResponses = options.validateResponses !== false;
  const transport = createHttpTransport(options);
  const contract = getOperatorContract();
  const schemaRegistry = validateResponses
    ? buildSchemaRegistry(ContractZodSchemas)
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
    [Symbol.dispose](): void {
      this.dispose();
    },
    async [Symbol.asyncDispose](): Promise<void> {
      return this.asyncDispose();
    },
  };
}
