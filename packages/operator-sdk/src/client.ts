import type {
  OperatorMethodContract,
  OperatorMethodId,
} from '@pellux/goodvibes-contracts';
import { getOperatorContract } from '@pellux/goodvibes-contracts';
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

export interface OperatorSdkOptions extends HttpTransportOptions {}

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

export function createOperatorSdk(options: OperatorSdkOptions): OperatorSdk {
  const transport = createHttpTransport(options);
  return createOperatorRemoteClient(transport, getOperatorContract()) as OperatorSdk;
}
