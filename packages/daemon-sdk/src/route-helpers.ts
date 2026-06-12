/** A plain JSON object (record of string keys to unknown values). */
export type JsonRecord = Record<string, unknown>;
/** Alias for `JsonRecord` used for request/response body shapes. */
export type JsonBody = JsonRecord;

/** A named parse schema for a daemon route request body. */
export interface RouteBodySchema<T> {
  /** Identifies which route this schema belongs to (for error messages). */
  readonly routeId: string;
  /** Parse a raw JSON body into `T`, or return an error `Response` on validation failure. */
  readonly parse: (body: JsonRecord) => T | Response;
}

/**
 * Create a typed `RouteBodySchema` from a route id and a parse function.
 *
 * @param routeId - Route identifier for error context.
 * @param parse - Function that validates and transforms a `JsonRecord` to `T`, or returns an error `Response`.
 * @returns A `RouteBodySchema<T>` ready to use in route handlers.
 */
export function createRouteBodySchema<T>(
  routeId: string,
  parse: (body: JsonRecord) => T | Response,
): RouteBodySchema<T> {
  return { routeId, parse };
}

/**
 * Create a typed registry of route body schemas, inferring the full map type.
 *
 * @param schemas - Map of route ids to `RouteBodySchema` instances.
 * @returns The same map with its literal type preserved.
 */
export function createRouteBodySchemaRegistry<
  const TSchemaMap extends Record<string, RouteBodySchema<unknown>>,
>(schemas: TSchemaMap): TSchemaMap {
  return schemas;
}

/** Type guard that returns `true` when `value` is a non-null, non-array plain object. */
export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively convert a value to a JSON-safe representation, replacing circular
 * references with `{ $ref: '<json-path>' }` entries.
 *
 * @param value - The value to serialize.
 * @returns A JSON-safe copy of `value`.
 */
export function toSerializableJson(value: unknown, stack = new Map<object, string>(), path = '$'): unknown {
  if (!value || typeof value !== 'object') return value;
  const prior = stack.get(value as object);
  if (prior) {
    return { $ref: prior };
  }
  const next = new Map(stack);
  next.set(value as object, path);
  if (Array.isArray(value)) {
    return value.map((entry, index) => toSerializableJson(entry, next, `${path}[${index}]`));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      toSerializableJson(entry, next, `${path}.${key}`),
    ]),
  );
}

/**
 * Create a JSON `Response` from any value, safely handling circular references.
 *
 * @param body - The value to serialize as the response body.
 * @param init - Optional `ResponseInit` (status, headers, etc.).
 * @returns A `Response` with `Content-Type: application/json`.
 */
export function serializableJsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(toSerializableJson(body), init);
}

/** Options for bounded integer parsing from query parameters or request bodies. */
export interface BoundedIntegerOptions {
  /** Default value to use when the input is absent or invalid. */
  readonly fallback: number;
  /** Inclusive lower bound. Defaults to `0`. */
  readonly min?: number | undefined;
  /** Inclusive upper bound. Defaults to `1000`. */
  readonly max?: number | undefined;
}

/**
 * Parse an integer from a raw query-parameter string, clamping to `[min, max]` and
 * falling back to `options.fallback` when the value is absent or non-finite.
 *
 * @param raw - The raw string value (or `null` if the parameter was absent).
 * @param options - Bounds and fallback configuration.
 * @returns A clamped integer within `[min, max]`.
 */
export function readBoundedInteger(raw: string | null, options: BoundedIntegerOptions): number {
  const min = options.min ?? 0;
  const max = options.max ?? 1_000;
  if (raw === null || raw.trim() === '') return clampInteger(options.fallback, min, max);
  const value = Number(raw);
  // Non-finite values (NaN from malformed strings like '?limit=abc') fall back
  // to a safe default instead of rejecting the whole request.
  if (!Number.isFinite(value)) return clampInteger(options.fallback, min, max);
  return clampInteger(value, min, max);
}

/**
 * Parse a positive integer (min=1) from a query-parameter string.
 *
 * @param raw - The raw string value (or `null`).
 * @param fallback - Default when absent or invalid.
 * @param max - Upper bound; defaults to `1000`.
 * @returns A clamped integer in `[1, max]`.
 */
export function readBoundedPositiveInteger(raw: string | null, fallback: number, max = 1_000): number {
  return readBoundedInteger(raw, { fallback, min: 1, max });
}

/**
 * Parse a bounded integer from a parsed JSON body value.
 *
 * @param value - The raw body value (should be `number`).
 * @param fallback - Default when absent or non-finite.
 * @param max - Inclusive upper bound.
 * @param min - Inclusive lower bound; defaults to `1`.
 * @returns A clamped integer in `[min, max]`.
 */
export function readBoundedBodyInteger(value: unknown, fallback: number, max: number, min = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return clampInteger(fallback, min, max);
  return clampInteger(value, min, max);
}

/**
 * Parse an optional bounded integer from a query-parameter string.
 * Returns `undefined` when the parameter is absent or non-finite.
 *
 * @param raw - The raw string value (or `null`).
 * @param min - Inclusive lower bound.
 * @param max - Inclusive upper bound.
 * @returns A clamped integer or `undefined`.
 */
export function readOptionalBoundedInteger(raw: string | null, min: number, max: number): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return clampInteger(value, min, max);
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Read a non-empty trimmed string from a JSON body field, returning `undefined` if absent or blank.
 *
 * @param body - The parsed request body.
 * @param key - The field key to read.
 * @returns The trimmed string, or `undefined`.
 */
export function readOptionalStringField(body: JsonRecord, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Read an array of non-empty trimmed strings from a JSON body field.
 * Entries that are not strings or are blank are skipped. Returns `undefined` when
 * the field is absent, not an array, or all entries were invalid.
 *
 * @param body - The parsed request body.
 * @param key - The field key to read.
 * @param max - Maximum number of entries to include; defaults to `128`.
 * @returns A non-empty string array, or `undefined`.
 */
export function readStringArrayField(body: JsonRecord, key: string, max = 128): string[] | undefined {
  const value = body[key];
  if (!Array.isArray(value)) return undefined;
  const output: string[] = [];
  for (let index = 0; index < value.length && index < max; index++) {
    const entry = value[index];
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed) output.push(trimmed);
  }
  return output.length > 0 ? output : undefined;
}

/**
 * Test whether a single granted scope string covers the required scope.
 * Supports exact match, wildcard `'*'`, and prefix wildcard (e.g. `'sessions:*'`).
 *
 * @param granted - A scope string held by the caller.
 * @param required - The scope the operation requires.
 * @returns `true` if `granted` covers `required`.
 */
export function scopeMatches(granted: string, required: string): boolean {
  if (granted === '*' || granted === required) return true;
  if (granted.endsWith(':*')) {
    return required.startsWith(granted.slice(0, -1));
  }
  return false;
}

/**
 * Return `true` if the caller holds at least one of the required scopes.
 *
 * @param grantedScopes - Scopes held by the caller (or `undefined` for no scopes).
 * @param requiredScopes - Scopes to check against.
 */
export function hasAnyScope(grantedScopes: readonly string[] | undefined, requiredScopes: readonly string[]): boolean {
  const granted = grantedScopes ?? [];
  return requiredScopes.some((required) => granted.some((entry) => scopeMatches(entry, required)));
}

/**
 * Return the subset of `requiredScopes` not covered by `grantedScopes`.
 *
 * @param grantedScopes - Scopes held by the caller (or `undefined` for no scopes).
 * @param requiredScopes - The full set of required scopes.
 * @returns An array of scope strings that are missing; empty if all are satisfied.
 */
export function missingScopes(grantedScopes: readonly string[] | undefined, requiredScopes: readonly string[]): string[] {
  const granted = grantedScopes ?? [];
  return requiredScopes.filter((required) => !granted.some((entry) => scopeMatches(entry, required)));
}

/** The set of lifecycle action strings accepted by channel lifecycle endpoints. */
export type ChannelLifecycleAction =
  | 'inspect'
  | 'setup'
  | 'retest'
  | 'connect'
  | 'disconnect'
  | 'start'
  | 'stop'
  | 'login'
  | 'logout'
  | 'wait_login';

/** The conversation kind values accepted by channel conversation endpoints. */
export type ChannelConversationKind = 'direct' | 'group' | 'channel' | 'thread' | 'service';

/**
 * Validate and narrow an unknown value to `ChannelLifecycleAction`.
 *
 * @param value - The raw input (typically from a URL path segment or body field).
 * @returns The typed action string, or `null` if the value is not a valid action.
 */
export function readChannelLifecycleAction(value: unknown): ChannelLifecycleAction | null {
  return value === 'inspect'
    || value === 'setup'
    || value === 'retest'
    || value === 'connect'
    || value === 'disconnect'
    || value === 'start'
    || value === 'stop'
    || value === 'login'
    || value === 'logout'
    || value === 'wait_login'
    ? value
    : null;
}

/**
 * Validate and narrow an unknown value to `ChannelConversationKind`.
 *
 * @param value - The raw input (typically from a URL path segment or body field).
 * @returns The typed kind string, or `null` if the value is not a valid kind.
 */
export function readChannelConversationKind(value: unknown): ChannelConversationKind | null {
  return value === 'direct' || value === 'group' || value === 'channel' || value === 'thread' || value === 'service'
    ? value
    : null;
}
