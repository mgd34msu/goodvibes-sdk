import type {
  OperatorMethodContract,
  OperatorMethodId,
} from '@pellux/goodvibes-contracts';
import { getOperatorContract } from '@pellux/goodvibes-contracts';
import {
  ControlAuthLoginResponseSchema,
  ControlAuthCurrentResponseSchema,
  AccountsSnapshotResponseSchema,
  ControlStatusResponseSchema,
} from '@pellux/goodvibes-contracts';
import {
  createHttpTransport,
  type HttpTransport,
  type HttpTransportOptions,
  type ServerSentEventHandlers,
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
   * This is useful when a caller wants raw response bodies for compatibility
   * debugging or benchmarking.
   */
  readonly validateResponses?: boolean;
}

export interface OperatorInvokeOptions extends OperatorRemoteClientInvokeOptions {}

export interface OperatorStreamOptions extends OperatorRemoteClientStreamOptions {
  readonly handlers: ServerSentEventHandlers;
}

export type OperatorSdk =
  & Omit<OperatorRemoteClient, 'getMethod'>
  & {
    readonly transport: HttpTransport;
    getMethod(methodId: OperatorMethodId): OperatorMethodContract;
  };

/** Static schema registry — loaded eagerly since Zod is a small runtime dep. */
const schemaRegistry: Partial<Record<string, ZodType>> = {
  'control.auth.login': ControlAuthLoginResponseSchema,
  'control.auth.current': ControlAuthCurrentResponseSchema,
  'accounts.snapshot': AccountsSnapshotResponseSchema,
  'control.status': ControlStatusResponseSchema,
};

function getSchemaRegistry(): Partial<Record<string, ZodType>> {
  return schemaRegistry;
}

export function createOperatorSdk(options: OperatorSdkOptions): OperatorSdk {
  const validateResponses = options.validateResponses !== false;
  const transport = createHttpTransport(options);
  const contract = getOperatorContract();
  return createOperatorRemoteClient(transport, contract, {
    getResponseSchema: validateResponses
      ? (methodId) => getSchemaRegistry()[methodId]
      : undefined,
  }) as OperatorSdk;
}
