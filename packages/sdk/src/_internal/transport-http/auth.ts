// Synced from packages/transport-http/src/auth.ts
// Extracted from legacy source: src/runtime/transports/http-auth.ts
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

export function mergeHeaders(...sources: Array<HeadersInit | undefined>): Headers {
  const headers = new Headers();
  for (const source of sources) {
    appendHeaders(headers, source);
  }
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
    return async () => await (input as () => string | null | undefined | Promise<string | null | undefined>)() ?? undefined;
  }
  // { token: string } wrapper object
  return async () => input.token;
}

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
