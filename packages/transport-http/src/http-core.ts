import { ConfigurationError, ContractError, HttpStatusError, createHttpStatusError } from '@pellux/goodvibes-errors';
import { sleepWithSignal } from './backoff.js';
import { mergeHeaders, normalizeAuthToken, resolveAuthToken, resolveHeaders, type AuthTokenResolver, type HeaderResolver } from './auth.js';
import {
  getHttpRetryDelay,
  isRetryableHttpStatus,
  isRetryableNetworkError,
  resolveHttpRetryPolicy,
  type HttpRetryPolicy,
} from './retry.js';
import { buildUrl, createTransportPaths, type TransportPaths } from './paths.js';
import { invokeTransportObserver, type TransportObserver } from '@pellux/goodvibes-transport-core';

export type { HttpRetryPolicy } from './retry.js';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type JsonObject = { readonly [key: string]: JsonValue };

export interface HttpJsonTransportOptions {
  readonly baseUrl: string;
  readonly authToken?: string | null;
  readonly getAuthToken?: AuthTokenResolver;
  readonly fetch?: typeof fetch;
  readonly fetchImpl?: typeof fetch;
  readonly headers?: HeadersInit;
  readonly getHeaders?: HeaderResolver;
  readonly retry?: HttpRetryPolicy;
  readonly observer?: TransportObserver;
}

export interface HttpJsonRequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly headers?: HeadersInit;
  readonly signal?: AbortSignal;
  readonly retry?: false | HttpRetryPolicy;
}

export interface ResolvedContractRequest {
  readonly url: string;
  readonly method: string;
  readonly body?: Record<string, unknown>;
}

export interface TransportJsonError {
  readonly status: number;
  readonly body: unknown;
  readonly url: string;
  readonly method: string;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export interface HttpJsonTransport {
  readonly baseUrl: string;
  readonly authToken?: string | null;
  readonly fetchImpl: typeof fetch;
  readonly paths: TransportPaths;
  buildUrl(path: string): string;
  getAuthToken(): Promise<string | null>;
  requestJson<T>(pathOrUrl: string, options?: HttpJsonRequestOptions): Promise<T>;
  resolveContractRequest(method: string, path: string, input?: Record<string, unknown>): ResolvedContractRequest;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function applyHeaderSource(
  target: Record<string, string>,
  source: HeadersInit | undefined,
): void {
  if (!source) return;
  if (source instanceof Headers) {
    source.forEach((value, key) => {
      target[key] = value;
    });
    return;
  }
  if (Array.isArray(source)) {
    for (const [key, value] of source) {
      target[key] = value;
    }
    return;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      target[key] = value;
    }
  }
}

function mergeHeaderRecord(...sources: Array<HeadersInit | undefined>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const source of sources) {
    applyHeaderSource(merged, source);
  }
  return merged;
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

export function createTransportError(
  status: number,
  url: string,
  method: string,
  body: unknown,
  retryAfterMs?: number,
): HttpStatusError & { readonly transport: TransportJsonError } {
  const inferred = inferTransportHint(status, url, retryAfterMs);
  const baseError = createHttpStatusError(status, url, method, body, inferred);
  const transportPayload: TransportJsonError = {
    status,
    body,
    url,
    method,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
  return Object.assign(baseError, {
    transport: transportPayload,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

export function createNetworkTransportError(
  error: unknown,
  url: string,
  method: string,
): HttpStatusError & { readonly transport: TransportJsonError } {
  const message = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : `Transport request failed before receiving a response for ${url}`;
  const hint = `Transport could not reach ${url}. Verify the baseUrl is reachable.`;
  const networkError = new HttpStatusError(message, {
    category: 'network',
    source: 'transport',
    recoverable: true,
    url,
    method,
    body: { error: message },
    hint,
  });
  if (error !== undefined) {
    Object.defineProperty(networkError, 'cause', { value: error, writable: true, configurable: true });
  }
  const transportPayload: TransportJsonError = {
    status: 0,
    body: { error: message },
    url,
    method,
    cause: error,
  };
  return Object.assign(networkError, { transport: transportPayload });
}

function toStringValue(value: unknown, key: string): string {
  if (value === undefined || value === null) {
    throw new ContractError(`Missing required path parameter "${key}". Ensure the input object includes a non-null value for this field before invoking the route.`);
  }
  return String(value);
}

function addQueryValue(url: URL, key: string, value: unknown): void {
  if (value === undefined) return;
  if (value === null) {
    url.searchParams.append(key, 'null');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      addQueryValue(url, key, item);
    }
    return;
  }
  if (typeof value === 'object') {
    url.searchParams.append(key, JSON.stringify(value));
    return;
  }
  url.searchParams.append(key, String(value));
}

function splitContractInput(path: string, input: Record<string, unknown> = {}): {
  readonly interpolatedPath: string;
  readonly remaining: Record<string, unknown>;
} {
  const remaining = { ...input };
  const interpolatedPath = path.replace(/\{([^}]+)\}/g, (_match, key) => {
    const value = toStringValue(remaining[key], key);
    delete remaining[key];
    return encodeURIComponent(value);
  });
  return { interpolatedPath, remaining };
}

export function createJsonRequestInit(
  token: string | null | undefined,
  body?: unknown,
  method = 'GET',
  headers: HeadersInit = {},
  signal?: AbortSignal,
  defaultHeaders: HeadersInit = {},
): RequestInit {
  return {
    method,
    credentials: 'include',
    signal,
    headers: mergeHeaderRecord(
      defaultHeaders,
      token ? { Authorization: `Bearer ${token}` } : undefined,
      body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      headers,
    ),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

export const createJsonInit = createJsonRequestInit;

export function createFetch(fetchImpl?: typeof fetch, fallbackFetch?: typeof fetch): typeof fetch {
  const resolved = fetchImpl ?? fallbackFetch ?? globalThis.fetch;
  if (typeof resolved !== 'function') {
    throw new ConfigurationError('Fetch implementation is required. Pass a fetch option (e.g. options.fetch) or ensure globalThis.fetch is available in your runtime.');
  }
  return resolved.bind(globalThis);
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (!retryAfter) return undefined;
  // Numeric seconds
  const seconds = Number(retryAfter);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  // HTTP-date
  const date = new Date(retryAfter);
  if (!Number.isNaN(date.getTime())) {
    const ms = date.getTime() - Date.now();
    return ms > 0 ? ms : 0;
  }
  return undefined;
}

export async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw createNetworkTransportError(error, url, init.method ?? 'GET');
  }
  const body = await readJsonBody(response);
  if (!response.ok) {
    const retryAfterMs = parseRetryAfterMs(response.headers);
    throw createTransportError(response.status, url, init.method ?? 'GET', body, retryAfterMs);
  }
  return body as T;
}

export function createHttpJsonTransport(options: HttpJsonTransportOptions): HttpJsonTransport {
  const baseUrl = options.baseUrl.trim();
  const fetchImpl = createFetch(options.fetchImpl, options.fetch);
  const authToken = options.authToken ?? null;
  // Normalize at the boundary: downstream always works with a single resolver.
  const getAuthToken = options.getAuthToken ?? normalizeAuthToken(options.authToken ?? undefined);
  const defaultHeaders = options.headers;
  const retryPolicy = options.retry;
  const paths = createTransportPaths(baseUrl);
  const observer = options.observer;

  const requestJsonForTransport = async <T>(pathOrUrl: string, requestOptions: HttpJsonRequestOptions = {}): Promise<T> => {
    const url = pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')
      ? pathOrUrl
      : buildUrl(baseUrl, pathOrUrl);
    const method = requestOptions.method ?? (requestOptions.body === undefined ? 'GET' : 'POST');
    const resolvedRetry = resolveHttpRetryPolicy(retryPolicy, requestOptions.retry);
    let attempt = 0;

    while (true) {
      attempt += 1;
      const token = (await getAuthToken()) ?? null;
      const headers = await resolveHeaders(defaultHeaders, options.getHeaders);
      // Notify observer before dispatching the request.
      invokeTransportObserver(() => observer?.onTransportActivity?.({ direction: 'send', url, kind: 'http' }));
      const sendAt = Date.now();
      try {
        const result = await requestJson<T>(
          fetchImpl,
          url,
          createJsonRequestInit(
            token,
            requestOptions.body,
            method,
            mergeHeaders(headers, requestOptions.headers),
            requestOptions.signal,
          ),
        );
        // Notify observer after a successful response.
        invokeTransportObserver(() => observer?.onTransportActivity?.({
          direction: 'recv',
          url,
          kind: 'http',
          durationMs: Date.now() - sendAt,
        }));
        return result;
      } catch (error) {
        // Notify observer of the transport error before deciding to retry or rethrow.
        invokeTransportObserver(() => observer?.onError?.(error instanceof Error ? error : new Error(String(error))));
        const status = typeof error === 'object' && error !== null && 'transport' in error
          ? (error as { readonly transport?: { readonly status?: unknown } }).transport?.status
          : undefined;
        const shouldRetry = attempt < resolvedRetry.maxAttempts && (
          (typeof status === 'number' && status > 0 && isRetryableHttpStatus(method, status, resolvedRetry))
          || (typeof status === 'number' && status === 0 && isRetryableNetworkError(method, resolvedRetry))
        );
        if (!shouldRetry) {
          throw error;
        }
        await sleepWithSignal(getHttpRetryDelay(attempt + 1, resolvedRetry), requestOptions.signal);
      }
    }
  };

  const resolveContractRequest = (method: string, path: string, input: Record<string, unknown> = {}): ResolvedContractRequest => {
    const { interpolatedPath, remaining } = splitContractInput(path, input);
    const upperMethod = method.toUpperCase();
    const url = new URL(buildUrl(baseUrl, interpolatedPath));
    if (upperMethod === 'GET' || upperMethod === 'HEAD') {
      for (const [key, value] of Object.entries(remaining)) {
        addQueryValue(url, key, value);
      }
      return {
        url: url.toString(),
        method: upperMethod,
      };
    }
    const body = isPlainObject(remaining) && Object.keys(remaining).length > 0 ? remaining : undefined;
    return {
      url: url.toString(),
      method: upperMethod,
      ...(body ? { body } : {}),
    };
  };

  return {
    baseUrl: paths.baseUrl,
    authToken,
    fetchImpl,
    paths,
    buildUrl(path: string): string {
      return buildUrl(baseUrl, path);
    },
    async getAuthToken(): Promise<string | null> {
      return (await getAuthToken()) ?? null;
    },
    requestJson: requestJsonForTransport,
    resolveContractRequest,
  };
}
