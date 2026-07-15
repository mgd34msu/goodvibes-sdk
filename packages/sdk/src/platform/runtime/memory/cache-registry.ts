/**
 * cache-registry.ts — the single owner of every in-memory cache / pool the
 * daemon retains, so the MemoryGovernor can see and shrink them under pressure.
 *
 * The daemon OOM'd because retained-context growth was invisible: no component
 * could enumerate "what is holding memory" or ask a cache to shrink. The fix
 * mirrors the append-only retention registry (append-only-registry.ts): every
 * cache the daemon keeps registers here with an id, a live entry count, an
 * optional byte estimate, and a `trim(level)` the governor can drive. A
 * fail-closed membership check (assertMemoryCacheRegistered) throws on an
 * unregistered id, so a new cache cannot ship invisible to the governor — the
 * same discipline as the append-only-store and feature-gate-id checks.
 *
 * Even bounded caches (ring buffers, capped catalogs) register: visibility is
 * the point. `trim('floor')` shrinks to a small working floor; `trim('flush')`
 * empties everything reclaimable.
 */
import { logger } from '../../utils/logger.js';

/** How hard the governor is asking a cache to shrink. */
export type CacheTrimLevel =
  /** Shrink to a small working floor — keep only what an active request needs. */
  | 'floor'
  /** Drop everything reclaimable — the daemon is under real pressure. */
  | 'flush';

/** A cache/pool the governor can observe and shrink. */
export interface RegisteredCache {
  /** Human-readable name for ops output. */
  readonly name: string;
  /** Live number of retained entries. */
  entryCount(): number;
  /** Optional retained-byte estimate (heap accounting is approximate). */
  estimateBytes?(): number;
  /** Shrink the cache to the requested level. Must be safe to call repeatedly. */
  trim(level: CacheTrimLevel): void;
}

/**
 * Every cache class the daemon retains AND can genuinely observe + shrink.
 * Extend this when adding one — the membership check fails loudly on an id not
 * listed here, and a registration whose trim is a no-op is a defect (it makes
 * the governor's shed tiers theater): every entry here must come with a real
 * entryCount and a trim that actually reclaims.
 */
export type MemoryCacheId =
  | 'knowledge-store'
  | 'session-union'
  | 'event-replay-ring';

/** The canonical membership set. Adding a cache means adding its id here. */
export const KNOWN_MEMORY_CACHES: readonly MemoryCacheId[] = [
  'knowledge-store',
  'session-union',
  'event-replay-ring',
];

const KNOWN_MEMORY_CACHE_SET: ReadonlySet<string> = new Set(KNOWN_MEMORY_CACHES);

/** True when `id` is a registered cache class. */
export function isMemoryCacheRegistered(id: string): boolean {
  return KNOWN_MEMORY_CACHE_SET.has(id);
}

/**
 * Fail-closed membership check: throw when `id` is not a known cache class.
 * Mirrors assertAppendOnlyStoreRegistered — an unregistered cache would be
 * invisible to the governor and could grow unowned, so it fails loudly.
 */
export function assertMemoryCacheRegistered(id: string, context: string): void {
  if (KNOWN_MEMORY_CACHE_SET.has(id)) return;
  throw new Error(
    `unknown memory cache id "${id}" (${context}); every cache/pool the daemon retains must be `
    + 'registered in KNOWN_MEMORY_CACHES with an entry count and a trim() the MemoryGovernor can drive.',
  );
}

/** A point-in-time footprint of one registered cache. */
export interface CacheFootprint {
  readonly id: MemoryCacheId;
  readonly name: string;
  readonly entries: number;
  readonly estimatedBytes?: number | undefined;
}

/**
 * The live registry of caches the governor drives. The daemon composition
 * registers one entry per known cache at construction; the membership check
 * refuses any id outside {@link KNOWN_MEMORY_CACHES}.
 */
export class CacheRegistry {
  private readonly caches = new Map<MemoryCacheId, RegisteredCache>();

  /**
   * Register a cache. Fails closed on an unknown id. Returns a deregister fn.
   * Re-registering the same id replaces the prior instance (a re-rooted store).
   */
  register(id: MemoryCacheId, cache: RegisteredCache): () => void {
    assertMemoryCacheRegistered(id, 'CacheRegistry.register');
    this.caches.set(id, cache);
    return () => {
      if (this.caches.get(id) === cache) this.caches.delete(id);
    };
  }

  /** Ids currently registered. */
  registeredIds(): MemoryCacheId[] {
    return [...this.caches.keys()];
  }

  /** Whether an id currently has a live registration. */
  has(id: MemoryCacheId): boolean {
    return this.caches.has(id);
  }

  /** Snapshot every registered cache's footprint (never throws — a bad cache is logged and skipped). */
  footprints(): CacheFootprint[] {
    const out: CacheFootprint[] = [];
    for (const [id, cache] of this.caches) {
      try {
        const entries = cache.entryCount();
        const estimatedBytes = cache.estimateBytes?.();
        out.push({ id, name: cache.name, entries, ...(estimatedBytes !== undefined ? { estimatedBytes } : {}) });
      } catch (error) {
        logger.warn('[memory] cache footprint read failed', { cache: id, error: String(error) });
      }
    }
    return out;
  }

  /** Total retained entries across all registered caches. */
  totalEntries(): number {
    let total = 0;
    for (const cache of this.caches.values()) {
      try {
        total += cache.entryCount();
      } catch {
        /* skip a misbehaving cache */
      }
    }
    return total;
  }

  /** Drive `trim(level)` on every registered cache. A throwing cache never blocks the rest. */
  trimAll(level: CacheTrimLevel): void {
    for (const [id, cache] of this.caches) {
      try {
        cache.trim(level);
      } catch (error) {
        logger.warn('[memory] cache trim failed', { cache: id, level, error: String(error) });
      }
    }
  }
}
