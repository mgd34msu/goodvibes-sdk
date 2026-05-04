import type {
  OperatorMethodContract,
  OperatorMethodId,
} from '@pellux/goodvibes-contracts';
import { getOperatorContract, OPERATOR_METHOD_IDS } from '@pellux/goodvibes-contracts';
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
  readonly validateResponses?: boolean | undefined;
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
 * Derives a candidate export name from a contract method id.
 * e.g. "local_auth.status" → "LocalAuthStatusResponseSchema"
 *      "control.auth.login" → "ControlAuthLoginResponseSchema"
 * Supported id grammar: /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/
 */
function _methodIdToSchemaName(methodId: string): string {
  const pascal = methodId
    .split('.')
    .flatMap((segment) => segment.split('_'))
    .map((word) => {
      // MIN-9: contract IDs must not contain consecutive underscores or
      // leading/trailing underscores — those produce empty segments that
      // collapse silently and can cause two distinct IDs to map to the same
      // schema name.
      if (word.length === 0) {
        throw new Error(
          `Invalid contract method id "${methodId}": segments must not be empty (avoid consecutive or trailing underscores/dots).`,
        );
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join('');
  return `${pascal}ResponseSchema`;
}

/**
 * Builds a method-ID → ZodType registry driven by the authoritative contract
 * method-id list. Each method id is transformed to its expected PascalCase
 * export name; schemas whose names don't match any contract method are silently
 * dropped. This handles snake_case namespace segments (e.g. `local_auth.status`)
 * correctly, which a naive PascalCase→dot transform cannot.
 */
function _buildSchemaRegistry(
  methodIds: readonly string[],
  schemas: Record<string, unknown>,
): Partial<Record<string, ZodType>> {
  // Build a reverse map: candidateExportName → methodId
  const candidateMap = new Map<string, string>();
  for (const methodId of methodIds) {
    candidateMap.set(_methodIdToSchemaName(methodId), methodId);
  }
  const registry: Partial<Record<string, ZodType>> = {};
  for (const [key, value] of Object.entries(schemas)) {
    const methodId = candidateMap.get(key);
    if (methodId === undefined) continue;
    if (!isZodSchema(value)) continue;
    registry[methodId] = value;
  }
  return registry;
}

/** @internal Exposed for unit testing only. */
export const __internal__: {
  readonly buildSchemaRegistry: (
    methodIds: readonly string[],
    schemas: Record<string, unknown>,
  ) => Partial<Record<string, ZodType>>;
  readonly methodIdToSchemaName: (methodId: string) => string;
} = {
  buildSchemaRegistry: _buildSchemaRegistry,
  methodIdToSchemaName: _methodIdToSchemaName,
};

export function createOperatorSdk(options: OperatorSdkOptions): OperatorSdk {
  const validateResponses = options.validateResponses !== false;
  const transport = createHttpTransport(options);
  const contract = getOperatorContract();
  const schemaRegistry = validateResponses
    ? _buildSchemaRegistry(OPERATOR_METHOD_IDS, ContractZodSchemas)
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
