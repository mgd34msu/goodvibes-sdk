/**
 * Generic on-disk TTL cache helpers shared by model-limits, model-catalog-cache,
 * and model-benchmarks.
 *
 * Each cache file has the same envelope shape:
 *   { version: 1, fetchedAt: number, ttlMs: number, <payload> }
 *
 * Only the envelope fields and the single payload key/kind differ between caches;
 * those differences are captured by the arguments to validateTtlCacheEnvelope.
 */

/** 24-hour TTL in milliseconds. */
export const TTL_24H_MS = 86_400_000;

/** Base envelope fields shared by all on-disk TTL caches. */
export interface TtlCacheEnvelope {
  version: 1;
  fetchedAt: number;
  ttlMs: number;
}

/**
 * Returns true when the cache has exceeded its declared TTL.
 */
export function isTtlCacheStale(cache: Pick<TtlCacheEnvelope, 'fetchedAt' | 'ttlMs'>): boolean {
  return Date.now() - cache.fetchedAt > cache.ttlMs;
}

/**
 * Validate the shared TTL cache envelope and one payload field.
 *
 * @param value       Raw parsed JSON value.
 * @param payloadKey  Name of the payload field (e.g. `'models'`, `'entries'`).
 * @param payloadKind Whether the payload should be an `'object'` or `'array'`.
 * @returns `{ cache: T }` on success, or `{ cache: null, reason }` on failure.
 */
export function validateTtlCacheEnvelope<T>(
  value: unknown,
  payloadKey: string,
  payloadKind: 'object' | 'array',
): { cache: T | null; reason?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { cache: null, reason: 'root value is not an object' };
  }
  const parsed = value as Record<string, unknown>;
  if (parsed['version'] !== 1) return { cache: null, reason: 'unsupported cache version' };
  if (typeof parsed['fetchedAt'] !== 'number' || !Number.isFinite(parsed['fetchedAt'] as number)) {
    return { cache: null, reason: 'fetchedAt must be a finite number' };
  }
  if (typeof parsed['ttlMs'] !== 'number' || !Number.isFinite(parsed['ttlMs'] as number)) {
    return { cache: null, reason: 'ttlMs must be a finite number' };
  }
  const payload = parsed[payloadKey];
  if (payloadKind === 'object') {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { cache: null, reason: `${payloadKey} must be an object` };
    }
  } else {
    if (!Array.isArray(payload)) {
      return { cache: null, reason: `${payloadKey} must be an array` };
    }
  }
  return { cache: parsed as T };
}
