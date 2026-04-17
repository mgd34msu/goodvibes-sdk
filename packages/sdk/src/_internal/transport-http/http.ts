// Synced from packages/transport-http/src/http.ts
import { ConfigurationError, ContractError, HttpStatusError, createHttpStatusError } from '../errors/index.js';
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
  requestJson,
  type HttpJsonRequestOptions,
  type HttpJsonTransport,
  type HttpJsonTransportOptions,
  type JsonObject,
  type JsonValue,
  type ResolvedContractRequest,
  type TransportJsonError,
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
  TransportJsonError,
};
export type HttpTransportOptions = HttpJsonTransportOptions;
export type HttpTransport = HttpJsonTransport;
export {
  createFetch,
  createJsonInit,
  createJsonRequestInit,
  readJsonBody,
  requestJson,
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
    readonly retryAfterMs?: number;
    readonly cause?: unknown;
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

function inferTransportHint(
  status: number,
  url: string,
  retryAfterMs?: number,
): string | undefined {
  if (status === 0) return `Transport could not reach ${url}. Verify the baseUrl is reachable.`;
  if (status === 401) return 'Check your authentication token or credentials.';
  if (status === 403) return 'Valid credentials but insufficient permissions for this operation.';
  if (status === 404) return 'The requested resource was not found.';
  if (status === 408) return 'The request timed out. Consider retrying.';
  if (status === 429) {
    return retryAfterMs !== undefined
      ? `Rate limit exceeded. Retry after ${retryAfterMs}ms.`
      : 'Rate limit exceeded. Back off and retry.';
  }
  if (status >= 500) return 'Remote server error. The service may be temporarily unavailable.';
  return undefined;
}

export function normalizeTransportError(error: unknown): Error {
  if (isTransportError(error)) {
    const { status, url, body, method, retryAfterMs, cause } = error.transport;
    const resolvedMethod = typeof method === 'string' ? method : 'GET';
    const hint = inferTransportHint(status, url, retryAfterMs);

    if (status === 0) {
      // Network-level failure: no HTTP response received
      const networkError = new HttpStatusError(
        error instanceof Error ? error.message : `Transport could not reach ${url}`,
        {
          status: undefined,
          url,
          method: resolvedMethod,
          body,
          category: 'network',
          source: 'transport',
          recoverable: true,
          hint,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      );
      if (cause !== undefined) {
        Object.defineProperty(networkError, 'cause', { value: cause, writable: true, configurable: true });
      }
      return Object.assign(networkError, { transport: error.transport });
    }

    const baseError = createHttpStatusError(status, url, resolvedMethod, body);
    // Only apply inferred hint if the daemon body didn't supply one already
    const effectiveHint = baseError.hint ?? hint;
    return Object.assign(
      baseError,
      {
        transport: error.transport,
        ...(effectiveHint !== undefined ? { hint: effectiveHint } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
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
