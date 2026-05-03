import { ConfigurationError, ContractError, GoodVibesSdkError, HttpStatusError, createHttpStatusError } from '@pellux/goodvibes-errors';
import { sleepWithSignal } from './backoff.js';
import { mergeHeaderRecord, normalizeAuthToken, resolveHeaders, type AuthTokenResolver, type HeaderResolver } from './auth.js';
import {
  applyPerMethodPolicy,
  getHttpRetryDelay,
  isRetryableHttpStatus,
  isRetryableNetworkError,
  resolveHttpRetryPolicy,
  type HttpRetryPolicy,
  type PerMethodRetryPolicy,
} from './retry.js';
import { buildUrl, createTransportPaths, type TransportPaths } from './paths.js';
import {
  composeMiddleware,
  createUuidV4,
  injectTraceparentAsync,
  invokeTransportObserver,
  transportErrorFromUnknown,
  type TransportContext,
  type TransportMiddleware,
  type TransportObserver,
} from '@pellux/goodvibes-transport-core';

export type { HttpRetryPolicy, PerMethodRetryPolicy } from './retry.js';
export type { TransportContext, TransportMiddleware } from '@pellux/goodvibes-transport-core';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Generate a UUID v4 idempotency key.
 * Uses `crypto.randomUUID()` when available (Bun, browsers, Workers, Node 14.17+).
 * Falls back to a manual RFC 4122 v4 implementation otherwise.
 */
export function generateIdempotencyKey(): string {
  return createUuidV4();
}

/** Methods that are safe to send idempotency keys for (all non-GET requests). */
const IDEMPOTENCY_KEY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
  /** Middleware chain applied to every HTTP request/response cycle. */
  readonly middleware?: readonly TransportMiddleware[];
}

export interface HttpJsonRequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly headers?: HeadersInit;
  readonly signal?: AbortSignal;
  readonly retry?: false | HttpRetryPolicy;
  /**
   * Contract method / endpoint ID used to look up per-method retry policy overrides.
   * Populated automatically by `invokeContractRoute`; callers outside the contract
   * layer may also set this to opt into `perMethodPolicy` overrides.
   */
  readonly methodId?: string;
  /**
   * When `true`, this call is considered idempotent even if the HTTP verb is a
   * mutating method (POST/PUT/PATCH/DELETE). Enables retry-on-5xx for the call.
   * Populated automatically from `contract.idempotent`; takes lower precedence
   * than an explicit `perMethodPolicy` override.
   */
  readonly idempotent?: boolean;
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
  /** Append a middleware to the transport's middleware chain. */
  use(middleware: TransportMiddleware): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function inferTransportHint(
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
    cause: error,
  });
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
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      addQueryValue(url, key, item);
    }
    return;
  }
  if (typeof value === 'object') {
    // Contract query parameters are primitive or repeated primitive values.
    // Object values are preserved as JSON strings so callers do not silently
    // lose structured filters when a route explicitly accepts them.
    url.searchParams.append(key, JSON.stringify(value));
    return;
  }
  url.searchParams.append(key, String(value));
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

function splitContractInput(path: string, input: Record<string, unknown> = {}): {
  readonly interpolatedPath: string;
  readonly remaining: Record<string, unknown>;
} {
  const remaining = { ...input };
  const interpolatedPath = path.replace(/\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g, (_match, key: string) => {
    const value = toStringValue(remaining[key], key);
    delete remaining[key];
    return encodeURIComponent(value);
  });
  if (/[{}]/.test(interpolatedPath)) {
    throw new ContractError(`Malformed contract path "${path}". Path parameters must use "{name}" with identifier-like names.`);
  }
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
  } catch (error) {
    void error;
    return text;
  }
}

/**
 * Low-level one-shot JSON request helper.
 *
 * This deliberately bypasses transport auth, middleware, retry policy,
 * idempotency keys, and observers. Prefer
 * `createHttpTransport(...).requestJson()` for normal application code.
 */
export async function requestJsonRaw<T>(
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
  // Persistent middleware chain — mutated via use().
  const middlewareChain: TransportMiddleware[] = [...(options.middleware ?? [])];

  const requestJsonForTransport = async <T>(pathOrUrl: string, requestOptions: HttpJsonRequestOptions = {}): Promise<T> => {
    const url = pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')
      ? pathOrUrl
      : buildUrl(baseUrl, pathOrUrl);
    const method = requestOptions.method ?? (requestOptions.body === undefined ? 'GET' : 'POST');
    const methodId = requestOptions.methodId;
    // Resolve idempotent flag from request options (set by contract-client from contract.idempotent).
    const contractIdempotent = requestOptions.idempotent === true;
    // Apply per-method retry policy override if a methodId is provided.
    const baseRetry = resolveHttpRetryPolicy(retryPolicy, requestOptions.retry);
    const resolvedRetry = methodId ? applyPerMethodPolicy(baseRetry, methodId) : baseRetry;

    // Determine idempotency: non-GET mutations without an explicit idempotent flag do NOT retry.
    // This is enforced below by gating the retry check on method type.
    const isMutatingMethod = IDEMPOTENCY_KEY_METHODS.has(method.toUpperCase());
    const idempotencyKey = isMutatingMethod ? generateIdempotencyKey() : undefined;

    let attempt = 0;

    while (true) {
      attempt += 1;
      const token = (await getAuthToken()) ?? null;
      const resolvedHeaders = await resolveHeaders(defaultHeaders, options.getHeaders);
      // Build merged headers record: default + per-request, then inject cross-cutting headers.
      const mergedHeaders = mergeHeaderRecord(
        resolvedHeaders ?? {},
        requestOptions.headers ?? {},
      );
      if (token) {
        mergedHeaders['Authorization'] = `Bearer ${token}`;
      }
      if (requestOptions.body !== undefined) {
        mergedHeaders['Content-Type'] = 'application/json';
      }

      // Inject W3C traceparent if OTel is active. This path is async so pure
      // ESM OpenTelemetry providers can be loaded before the request is sent.
      await injectTraceparentAsync(mergedHeaders);

      // Inject idempotency key for mutating methods.
      if (idempotencyKey && !hasHeader(mergedHeaders, 'Idempotency-Key')) {
        mergedHeaders['Idempotency-Key'] = idempotencyKey;
      }

      // Notify observer before dispatching the request.
      invokeTransportObserver(() => observer?.onTransportActivity?.({ direction: 'send', url, kind: 'http' }));
      const sendAt = Date.now();

      // Build the middleware context for this attempt.
      const ctx: TransportContext = {
        method,
        url,
        headers: mergedHeaders,
        body: requestOptions.body,
        options: requestOptions as { readonly signal?: AbortSignal; readonly retry?: unknown; [key: string]: unknown },
        signal: requestOptions.signal,
      };

      // Build the inner fetch that middleware wraps (and also used directly without middleware).
      const innerFetch = async (c: TransportContext): Promise<Response> => {
        const init: RequestInit = {
          method: c.method,
          credentials: 'include',
          signal: c.signal,
          headers: c.headers,
          ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
        };
        let response: Response;
        try {
          response = await fetchImpl(c.url, init);
        } catch (error) {
          throw createNetworkTransportError(error, c.url, c.method);
        }
        const body = await readJsonBody(response);
        if (!response.ok) {
          const retryAfterMs = parseRetryAfterMs(response.headers);
          throw createTransportError(response.status, c.url, c.method, body, retryAfterMs);
        }
        // Return synthetic Response carrying parsed body so callers can .json() it.
        return new Response(JSON.stringify(body), { status: response.status });
      };

      try {
        if (middlewareChain.length > 0) {
          // Middleware path — compose chain around innerFetch.
          const composed = composeMiddleware(middlewareChain, innerFetch);
          await composed(ctx);
          if (ctx.error) throw ctx.error;
          if (!ctx.response) {
            throw new GoodVibesSdkError('HTTP middleware chain completed without producing a response.', {
              category: 'protocol',
              source: 'transport',
              recoverable: false,
              url,
              method,
            });
          }
          const result = await ctx.response.json() as T;
          invokeTransportObserver(() => observer?.onTransportActivity?.({
            direction: 'recv',
            url,
            kind: 'http',
            durationMs: ctx.durationMs,
          }));
          return result;
        }

        // No-middleware fast path — directly invoke innerFetch with ctx.
        const rawResponse = await innerFetch(ctx);
        const result = await rawResponse.json() as T;
        // Notify observer after a successful response.
        invokeTransportObserver(() => observer?.onTransportActivity?.({
          direction: 'recv',
          url,
          kind: 'http',
          durationMs: Date.now() - sendAt,
        }));
        return result;
      } catch (error) {
        // Wrap middleware errors as SDKError{kind:'unknown'} with middleware identity in cause.
        // ALL errors originating from the middleware chain are wrapped — including HttpStatusError.
        const wrappedError = (() => {
          if (ctx.middlewareError) {
            // Error came from within the middleware chain — wrap regardless of error type.
            const msg = transportErrorFromUnknown(error, 'transport middleware error').message;
            const middlewareName = ctx.activeMiddlewareName ?? 'unknown';
            const wrapped = new GoodVibesSdkError(`Transport middleware error: ${msg}`, {
              category: 'unknown',
              source: 'transport',
              recoverable: false,
              cause: { middleware: middlewareName, originalError: error },
            });
            return wrapped;
          }
          if (error instanceof GoodVibesSdkError) return error;
          return error;
        })();
        // Notify observer of the transport error before deciding to retry or rethrow.
        invokeTransportObserver(() => observer?.onError?.(transportErrorFromUnknown(wrappedError, 'HTTP transport error')));
        const status = typeof wrappedError === 'object' && wrappedError !== null && 'transport' in wrappedError
          ? (wrappedError as { readonly transport?: { readonly status?: unknown } }).transport?.status
          : undefined;
        // Mutating methods (POST/PUT/PATCH/DELETE) without idempotent contract mark:
        // do NOT retry on 5xx to avoid duplicate side effects.
        // Precedence: explicit perMethodPolicy > contract.idempotent flag > HTTP-verb default.
        const hasPerMethodOverride = methodId !== undefined && baseRetry.perMethodPolicy[methodId] !== undefined;
        const canRetry = !isMutatingMethod || hasPerMethodOverride || contractIdempotent;
        const shouldRetry = canRetry && attempt < resolvedRetry.maxAttempts && (
          (typeof status === 'number' && status > 0 && isRetryableHttpStatus(method, status, resolvedRetry))
          || (typeof status === 'number' && status === 0 && isRetryableNetworkError(method, resolvedRetry))
        );
        if (!shouldRetry) {
          throw wrappedError;
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
    use(middleware: TransportMiddleware): void {
      middlewareChain.push(middleware);
    },
  };
}
