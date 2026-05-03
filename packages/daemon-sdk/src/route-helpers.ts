export type JsonRecord = Record<string, unknown>;
export type JsonBody = JsonRecord;

export interface RouteBodySchema<T> {
  readonly routeId: string;
  readonly parse: (body: JsonRecord) => T | Response;
}

export function createRouteBodySchema<T>(
  routeId: string,
  parse: (body: JsonRecord) => T | Response,
): RouteBodySchema<T> {
  return { routeId, parse };
}

export function createRouteBodySchemaRegistry<
  const TSchemaMap extends Record<string, RouteBodySchema<unknown>>,
>(schemas: TSchemaMap): TSchemaMap {
  return schemas;
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

export function serializableJsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(toSerializableJson(body), init);
}

export interface BoundedIntegerOptions {
  readonly fallback: number;
  readonly min?: number;
  readonly max?: number;
}

export function readBoundedInteger(raw: string | null, options: BoundedIntegerOptions): number {
  const min = options.min ?? 0;
  const max = options.max ?? 1_000;
  if (raw === null || raw.trim() === '') return clampInteger(options.fallback, min, max);
  const value = Number(raw);
  if (!Number.isFinite(value)) return clampInteger(options.fallback, min, max);
  return clampInteger(value, min, max);
}

export function readBoundedPositiveInteger(raw: string | null, fallback: number, max = 1_000): number {
  return readBoundedInteger(raw, { fallback, min: 1, max });
}

export function readBoundedBodyInteger(value: unknown, fallback: number, max: number, min = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return clampInteger(fallback, min, max);
  return clampInteger(value, min, max);
}

export function readOptionalBoundedInteger(raw: string | null, min: number, max: number): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return clampInteger(value, min, max);
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function readOptionalStringField(body: JsonRecord, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

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

export function scopeMatches(granted: string, required: string): boolean {
  if (granted === '*' || granted === required) return true;
  if (granted.endsWith(':*')) {
    return required.startsWith(granted.slice(0, -1));
  }
  return false;
}

export function hasAnyScope(grantedScopes: readonly string[] | undefined, requiredScopes: readonly string[]): boolean {
  const granted = grantedScopes ?? [];
  return requiredScopes.some((required) => granted.some((entry) => scopeMatches(entry, required)));
}

export function missingScopes(grantedScopes: readonly string[] | undefined, requiredScopes: readonly string[]): string[] {
  const granted = grantedScopes ?? [];
  return requiredScopes.filter((required) => !granted.some((entry) => scopeMatches(entry, required)));
}

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

export type ChannelConversationKind = 'direct' | 'group' | 'channel' | 'thread' | 'service';

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

export function readChannelConversationKind(value: unknown): ChannelConversationKind | null {
  return value === 'direct' || value === 'group' || value === 'channel' || value === 'thread' || value === 'service'
    ? value
    : null;
}
