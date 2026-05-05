import { ConfigurationError, ContractError, GoodVibesSdkError, HttpStatusError, createHttpStatusError } from '@pellux/goodvibes-errors';
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
  generateIdempotencyKey,
  inferTransportHint,
  readJsonBody,
  requestJsonRaw,
  type HttpJsonRequestOptions,
  type HttpJsonTransport,
  type HttpJsonTransportOptions,
  type JsonObject,
  type JsonValue,
  type ResolvedContractRequest,
  type TransportContext,
  type TransportMiddleware,
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
  TransportContext,
  TransportJsonError,
  TransportMiddleware,
};
export type HttpTransportOptions = HttpJsonTransportOptions;
export type HttpTransport = HttpJsonTransport;
export {
  createFetch,
  createJsonInit,
  createJsonRequestInit,
  generateIdempotencyKey,
  readJsonBody,
  requestJsonRaw,
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
    readonly method?: string | undefined;
    readonly retryAfterMs?: number | undefined;
    readonly cause?: unknown | undefined;
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
  // Fast path: already a structured SDK error — return directly, no re-wrapping needed.
  // Covers HttpStatusError (subclass) and GoodVibesSdkError (e.g. SSE stream errors) alike.
  if (error instanceof GoodVibesSdkError) {
    return error;
  }
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
    // Defensive string-match path for non-SDK errors that slip through.
    // With structured throws in http-core.ts, these paths are rarely exercised.
    if (error.message === 'Fetch implementation is required' || error.message === 'Transport baseUrl is required') {
      return new ConfigurationError(error.message);
    }
    if (error.message.startsWith('Missing required path parameter')) {
      return new ContractError(error.message);
    }
  }
  return error instanceof Error
    ? error
    : new GoodVibesSdkError(`Transport operation failed with a non-Error value: ${String(error)}`, {
        category: 'network',
        source: 'transport',
        recoverable: true,
      });
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
