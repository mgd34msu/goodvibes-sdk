import { ConfigurationError, ContractError, createHttpStatusError } from '@goodvibes/errors';
import {
  type AuthTokenResolver,
  type HeaderResolver,
  type MaybePromise,
  mergeHeaders,
  resolveAuthToken,
  resolveHeaders,
} from './auth.js';
import {
  type BackoffPolicy,
  type ResolvedBackoffPolicy,
  computeBackoffDelay,
  normalizeBackoffPolicy,
  sleepWithSignal,
} from './backoff.js';
import {
  type HttpRetryPolicy,
  type ResolvedHttpRetryPolicy,
  DEFAULT_HTTP_RETRY_POLICY,
  getHttpRetryDelay,
  isRetryableHttpStatus,
  isRetryableNetworkError,
  normalizeHttpRetryPolicy,
  resolveHttpRetryPolicy,
} from './retry.js';
import {
  type ResolvedStreamReconnectPolicy,
  type StreamReconnectPolicy,
  DEFAULT_STREAM_RECONNECT_POLICY,
  getStreamReconnectDelay,
  normalizeStreamReconnectPolicy,
} from './reconnect.js';
import {
  createFetch,
  createHttpJsonTransport,
  createJsonInit,
  createJsonRequestInit,
  readJsonBody,
  type HttpJsonRequestOptions,
  type HttpJsonTransport,
  type HttpJsonTransportOptions,
  type JsonObject,
  type JsonValue,
  type ResolvedContractRequest,
} from './http-core.js';

export type {
  AuthTokenResolver,
  BackoffPolicy,
  HeaderResolver,
  HttpJsonRequestOptions,
  HttpRetryPolicy,
  JsonObject,
  JsonValue,
  MaybePromise,
  ResolvedBackoffPolicy,
  ResolvedContractRequest,
  ResolvedHttpRetryPolicy,
  ResolvedStreamReconnectPolicy,
  StreamReconnectPolicy,
};
export type HttpTransportOptions = HttpJsonTransportOptions;
export type HttpTransport = HttpJsonTransport;
export {
  createFetch,
  createJsonInit,
  createJsonRequestInit,
  readJsonBody,
  mergeHeaders,
  resolveAuthToken,
  resolveHeaders,
  computeBackoffDelay,
  normalizeBackoffPolicy,
  sleepWithSignal,
  DEFAULT_HTTP_RETRY_POLICY,
  getHttpRetryDelay,
  isRetryableHttpStatus,
  isRetryableNetworkError,
  normalizeHttpRetryPolicy,
  resolveHttpRetryPolicy,
  DEFAULT_STREAM_RECONNECT_POLICY,
  getStreamReconnectDelay,
  normalizeStreamReconnectPolicy,
};

type TransportFailure = {
  readonly transport: {
    readonly status: number;
    readonly url: string;
    readonly body: unknown;
    readonly method?: string;
  };
};

function isTransportError(error: unknown): error is TransportFailure {
  return Boolean(
    error
    && typeof error === 'object'
    && 'transport' in error
    && (error as TransportFailure).transport
    && typeof (error as TransportFailure).transport.status === 'number'
    && typeof (error as TransportFailure).transport.url === 'string'
  );
}

export function normalizeTransportError(error: unknown): Error {
  if (isTransportError(error)) {
    return createHttpStatusError(
      error.transport.status,
      error.transport.url,
      typeof error.transport.method === 'string' ? error.transport.method : 'GET',
      error.transport.body,
    );
  }
  if (error instanceof Error) {
    if (error.message === 'Fetch implementation is required' || error.message === 'Transport baseUrl is required') {
      return new ConfigurationError(error.message);
    }
    if (error.message.startsWith('Missing required path parameter')) {
      return new ContractError(error.message);
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function createHttpTransport(options: HttpTransportOptions): HttpTransport {
  const transport = createHttpJsonTransport(options);
  return {
    ...transport,
    async requestJson<T>(pathOrUrl: string, requestOptions: HttpJsonRequestOptions = {}): Promise<T> {
      try {
        return await transport.requestJson(pathOrUrl, requestOptions);
      } catch (error) {
        throw normalizeTransportError(error);
      }
    },
    resolveContractRequest(method: string, path: string, input: Record<string, unknown> = {}): ResolvedContractRequest {
      try {
        return transport.resolveContractRequest(method, path, input);
      } catch (error) {
        throw normalizeTransportError(error);
      }
    },
  };
}
