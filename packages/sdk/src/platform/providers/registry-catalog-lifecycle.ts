import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import {
  fetchCatalog,
  isCatalogCacheStale,
  loadCatalogCache,
  notifyCatalogChanges,
  saveCatalogCache,
  type CatalogModel,
} from './model-catalog.js';
import type { FavoritesStore } from './favorites.js';
import type { BenchmarkStore } from './model-benchmarks.js';

/**
 * Parameters for catalog lifecycle operations.
 * Passed as a callback bundle so functions remain stateless
 * with respect to the ProviderRegistry class.
 */
export interface CatalogLifecycleContext {
  /** Returns the current catalog cache paths. */
  getCatalogCachePaths(): { cachePath: string; tmpPath: string };
  /** Applies a freshly-fetched model list to the registry's catalog state. */
  updateCatalogState(models: readonly CatalogModel[], fetchedAt?: number): void;
  /** Returns a snapshot of the current catalog models (for diff/notify). */
  getCatalogModels(): readonly CatalogModel[];
  readonly favoritesStore: Pick<FavoritesStore, 'load'>;
  readonly benchmarkStore: Pick<BenchmarkStore, 'getTopBenchmarkModelIds'>;
  /** Triggers an async background catalog refresh (used by initCatalog). */
  refreshCatalog(): Promise<void>;
}

/**
 * Load the catalog from disk cache on startup. If the cache is absent or
 * stale, schedules a background refresh without blocking the caller.
 *
 * Extracted from ProviderRegistry.initCatalog() to isolate catalog
 * initialization logic from provider management concerns.
 */
export function initProviderCatalog(ctx: CatalogLifecycleContext): void {
  const cached = loadCatalogCache(ctx.getCatalogCachePaths().cachePath);
  if (cached) {
    ctx.updateCatalogState(cached.models, cached.fetchedAt);
  }
  if (!cached || isCatalogCacheStale(cached)) {
    void ctx.refreshCatalog().catch((err) => {
      logger.debug('[model-catalog] Background refresh failed', { error: summarizeError(err) });
    });
  }
}

/**
 * Fetch an updated catalog from the remote source, persist it to the local
 * cache, apply it to the registry state, and emit change notifications.
 *
 * Extracted from ProviderRegistry.refreshCatalog() to isolate catalog
 * refresh logic from provider management concerns.
 */
export async function refreshProviderCatalog(ctx: CatalogLifecycleContext): Promise<void> {
  const previous = [...ctx.getCatalogModels()];
  const models = await fetchCatalog();
  if (models.length === 0) {
    logger.warn('[model-catalog] Refresh returned 0 models — keeping existing catalog');
    return;
  }
  const { cachePath, tmpPath } = ctx.getCatalogCachePaths();
  saveCatalogCache(models, cachePath, tmpPath);
  ctx.updateCatalogState(models);
  const favorites = await ctx.favoritesStore.load();
  notifyCatalogChanges(
    previous,
    [...ctx.getCatalogModels()],
    favorites,
    ctx.benchmarkStore.getTopBenchmarkModelIds(10),
  );
  logger.debug('[model-catalog] Catalog updated', { count: models.length });
}
