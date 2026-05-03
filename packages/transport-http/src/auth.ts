export type MaybePromise<T> = T | Promise<T>;

export type AuthTokenResolver = () => MaybePromise<string | null | undefined>;

/**
 * Any supported public auth-token input form.
 * Normalised to `AuthTokenResolver` at SDK/transport boundaries via `normalizeAuthToken`.
 */
export type AuthTokenInput =
  | string
  | { readonly token: string }
  | AuthTokenResolver
  | (() => string | null | undefined | Promise<string | null | undefined>)
  | undefined;

export type HeaderResolver = () => MaybePromise<HeadersInit | undefined>;

function appendHeaders(target: Headers, headers: HeadersInit | undefined): void {
  if (!headers) return;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      target.set(key, value);
    });
    return;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      target.set(key, value);
    }
    return;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      target.set(key, value);
    }
  }
}

function appendHeaderRecord(target: Record<string, string>, headers: HeadersInit | undefined): void {
  if (!headers) return;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      target[key.toLowerCase()] = value;
    });
    return;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      target[key.toLowerCase()] = value;
    }
    return;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) target[key.toLowerCase()] = value;
  }
}

/**
 * Merge header inputs into a `Headers` instance.
 *
 * Use this when a streaming/browser API expects mutable `Headers`, such as
 * EventSource-style setup or abort-aware fetch helpers. For ordinary JSON HTTP
 * requests, prefer `mergeHeaderRecord` so callers receive a plain object that is
 * cheap to serialize, inspect, and pass through middleware.
 */
export function mergeHeaders(...sources: Array<HeadersInit | undefined>): Headers {
  const headers = new Headers();
  for (const source of sources) {
    appendHeaders(headers, source);
  }
  return headers;
}

/**
 * Merge header inputs into a lower-case plain record.
 *
 * Preferred for normal HTTP transport requests because the result is a stable
 * `Record<string, string>` for middleware, trace injection, and JSON request
 * construction. Use `mergeHeaders` only when a consumer specifically needs a
 * platform `Headers` object.
 */
export function mergeHeaderRecord(...sources: Array<HeadersInit | undefined>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const source of sources) appendHeaderRecord(headers, source);
  return headers;
}

/**
 * Accepts any supported auth token form and returns a canonical async resolver.
 *
 * - `string`           → resolver that always returns the string
 * - `{ token: string }` → resolver that always returns `input.token`
 * - sync function      → resolver that awaits `input()` (errors propagate)
 * - async function     → passes through as-is
 * - `undefined`        → resolver that returns `undefined`
 */
export function normalizeAuthToken(input: AuthTokenInput): AuthTokenResolver {
  if (input === undefined) {
    return async () => undefined;
  }
  if (typeof input === 'string') {
    return async () => input;
  }
  if (typeof input === 'function') {
    return async () => (await (input as () => string | null | undefined | Promise<string | null | undefined>)()) ?? undefined;
  }
  // { token: string } wrapper object
  return async () => input.token;
}

/**
 * Resolve the token for an outbound transport request.
 *
 * This helper is intentionally transport-facing: it does not read process
 * environment variables, config files, or global SDK state. Higher layers are
 * responsible for choosing a token source and passing it here explicitly.
 */
export async function resolveAuthToken(
  authToken: string | null | undefined,
  getAuthToken?: AuthTokenResolver,
): Promise<string | null> {
  if (getAuthToken) {
    const resolved = await getAuthToken();
    return resolved ?? null;
  }
  return authToken ?? null;
}

export async function resolveHeaders(
  headers: HeadersInit | undefined,
  getHeaders?: HeaderResolver,
): Promise<Headers> {
  const resolved = getHeaders ? await getHeaders() : undefined;
  return mergeHeaders(headers, resolved);
}
