/**
 * RegistryCatalogue — manages catalog state, synthetic models, and the model registry cache.
 * Extracted from ProviderRegistry to reduce god-object size.
 * Pure delegation target: ProviderRegistry holds an instance and forwards catalog-shaped calls here.
 */
import {
  buildSyntheticCanonicalModels,
  fetchCatalog,
  getCatalogCachePath,
  getCatalogModelDefinitionsFrom,
  getCatalogTmpPath,
  getCostFromPricingCatalog,
  getSyntheticBackendModelIds,
  getSyntheticModelDefinitions,
  getSyntheticModelInfo,
  isCatalogCacheStale,
  loadCatalogCache,
  notifyCatalogChanges,
  saveCatalogCache,
  type CatalogModel,
  type MinimalModelDefinition,
  type PricingCatalog,
} from './model-catalog.js';
import { buildModelRegistry } from './registry-models.js';
import type { ModelDefinition } from './registry-types.js';
import type { CanonicalModel } from './synthetic.js';
import type { BenchmarkStore } from './model-benchmarks.js';
import type { FavoritesStore } from './favorites.js';
import type { ModelLimitsService } from './model-limits.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export interface RegistryCatalogueOptions {
  readonly persistenceRoot: string;
  readonly benchmarkStore: Pick<BenchmarkStore, 'getTopBenchmarkModelIds' | 'getBenchmarks'>;
  readonly favoritesStore: Pick<FavoritesStore, 'load'>;
  readonly modelLimitsService: ModelLimitsService;
  /**
   * Callbacks to read fresh mutable state from ProviderRegistry on every model-registry
   * build. Using callbacks (not stored references) avoids stale-ref bugs when the
   * registry reassigns its arrays (e.g. customModels = result.models).
   */
  readonly getCustomModels: () => ModelDefinition[];
  readonly getRuntimeModels: () => ModelDefinition[];
  readonly getDiscoveredModels: () => ModelDefinition[];
  readonly getRuntimeCatalogSuppressions: () => Map<string, readonly string[]>;
}

export class RegistryCatalogue {
  catalogModels: CatalogModel[] = [];
  pricingCatalog: PricingCatalog | null = null;
  syntheticCanonicalModels: CanonicalModel[] = [];

  private _cachedModelRegistry: ModelDefinition[] | null = null;
  private _modelRegistryRevision = 0;

  private readonly opts: RegistryCatalogueOptions;

  constructor(opts: RegistryCatalogueOptions) {
    this.opts = opts;
  }

  private getCatalogCachePaths(): { cachePath: string; tmpPath: string } {
    return {
      cachePath: getCatalogCachePath(this.opts.persistenceRoot),
      tmpPath: getCatalogTmpPath(this.opts.persistenceRoot),
    };
  }

  getCatalogBuiltins(): ModelDefinition[] {
    return getCatalogModelDefinitionsFrom(this.catalogModels) as ModelDefinition[];
  }

  getSyntheticBuiltins(): ModelDefinition[] {
    return getSyntheticModelDefinitions(this.catalogModels, this.syntheticCanonicalModels) as ModelDefinition[];
  }

  updateCatalogState(models: readonly CatalogModel[]): void {
    this.catalogModels = [...models];
    this.pricingCatalog = { fetchedAt: Date.now(), models: this.catalogModels };
    this.syntheticCanonicalModels = buildSyntheticCanonicalModels(this.catalogModels);
    this.invalidateModelRegistry();
  }

  getSuppressedCatalogModelIds(): Set<string> {
    return new Set([...this.opts.getRuntimeCatalogSuppressions().values()].flat());
  }

  invalidateModelRegistry(): void {
    this._cachedModelRegistry = null;
    this._modelRegistryRevision++;
  }

  get modelRegistryRevision(): number {
    return this._modelRegistryRevision;
  }

  getModelRegistry(): ModelDefinition[] {
    if (this._cachedModelRegistry !== null) return this._cachedModelRegistry;
    this._cachedModelRegistry = buildModelRegistry({
      customModels: this.opts.getCustomModels(),
      runtimeModels: this.opts.getRuntimeModels(),
      syntheticModels: this.getSyntheticBuiltins(),
      catalogModels: this.getCatalogBuiltins(),
      discoveredModels: this.opts.getDiscoveredModels(),
      suppressedCatalogIds: this.getSuppressedCatalogModelIds(),
    });
    return this._cachedModelRegistry;
  }

  // ── Public catalog query methods ────────────────────────────────────

  getRawCatalogModels(): readonly CatalogModel[] {
    return [...this.catalogModels];
  }

  getCatalogModelDefinitions(): readonly MinimalModelDefinition[] {
    return getCatalogModelDefinitionsFrom(this.catalogModels);
  }

  getSyntheticModelDefinitions(): readonly MinimalModelDefinition[] {
    return getSyntheticModelDefinitions(this.catalogModels, this.syntheticCanonicalModels);
  }

  getSyntheticCanonicalModels(): readonly CanonicalModel[] {
    return [...this.syntheticCanonicalModels];
  }

  getSyntheticBackendModelIds(): Set<string> {
    return getSyntheticBackendModelIds(this.syntheticCanonicalModels);
  }

  getSyntheticModelInfoFromCatalog(modelId: string) {
    return getSyntheticModelInfo(
      modelId,
      this.syntheticCanonicalModels,
      (candidateId) => this.opts.benchmarkStore.getBenchmarks(candidateId),
    );
  }

  getCostFromCatalog(modelId: string, modelLimitsService: ModelLimitsService): { input: number; output: number } {
    return getCostFromPricingCatalog(
      modelId,
      this.pricingCatalog ?? { fetchedAt: Date.now(), models: this.catalogModels },
      modelLimitsService,
    );
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  initCatalog(): void {
    const cached = loadCatalogCache(this.getCatalogCachePaths().cachePath);
    if (cached) {
      this.catalogModels = [...cached.models];
      this.pricingCatalog = { fetchedAt: cached.fetchedAt, models: this.catalogModels };
      this.syntheticCanonicalModels = buildSyntheticCanonicalModels(this.catalogModels);
    }
    if (!cached || isCatalogCacheStale(cached)) {
      void this.refreshCatalog().catch((err) => {
        logger.debug('[model-catalog] Background refresh failed', { error: summarizeError(err) });
      });
    }
  }

  async refreshCatalog(): Promise<void> {
    const previous = [...this.catalogModels];
    const models = await fetchCatalog();
    if (models.length === 0) {
      logger.warn('[model-catalog] Refresh returned 0 models — keeping existing catalog');
      return;
    }
    const { cachePath, tmpPath } = this.getCatalogCachePaths();
    saveCatalogCache(models, cachePath, tmpPath);
    this.updateCatalogState(models);
    const favorites = await this.opts.favoritesStore.load();
    notifyCatalogChanges(
      previous,
      this.catalogModels,
      favorites,
      this.opts.benchmarkStore.getTopBenchmarkModelIds(10),
    );
    logger.debug('[model-catalog] Catalog updated', { count: models.length });
  }
}
