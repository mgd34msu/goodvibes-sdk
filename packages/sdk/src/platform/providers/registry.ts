import type { LLMProvider, ProviderRuntimeMetadata, ProviderRuntimeMetadataDeps } from './interface.js';
import { ProviderNotFoundError } from './provider-not-found-error.js';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import {
  ProviderCapabilityRegistry,
  type ProviderCapability,
  type RequestProfile,
  type RouteExplanation,
} from './capabilities.js';
import type { DiscoveredServer } from '../discovery/scanner.js';
import { createDiscoveredProvider, getDiscoveredReasoningFormat } from './discovered-factory.js';
import { getDiscoveredTraits } from './discovered-traits.js';
import { getConfiguredApiKeys, getConfiguredModelId } from '../config/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { emitProvidersChanged, emitProviderWarning, emitModelChanged } from '../runtime/emitters/index.js';
import { loadCustomProviders, watchCustomProviders } from './custom-loader.js';
import {
  buildSyntheticCanonicalModels,
  getCatalogCachePath,
  getCatalogModelDefinitionsFrom,
  getCatalogTmpPath,
  getCostFromPricingCatalog,
  getSyntheticBackendModelIds,
  getSyntheticModelDefinitions,
  getSyntheticModelInfo,
  type CatalogModel,
  type CatalogProvider,
  type MinimalModelDefinition,
  type PricingCatalog,
} from './model-catalog.js';
import { registerBuiltinProviders, CATALOG_PROVIDER_NAME_ALIASES } from './builtin-registry.js';
import type { CacheHitTracker } from './cache-strategy.js';
import type { ConfigManager } from '../config/manager.js';
import type { SubscriptionManager } from '../config/subscriptions.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.js';
import type { FavoritesStore } from './favorites.js';
import type { BenchmarkStore } from './model-benchmarks.js';
import type { CanonicalModel } from './synthetic.js';
import { LocalContextIngestionService } from './local-context-ingestion.js';
import { getModelLimitsCachePath, ModelLimitsService } from './model-limits.js';
import { getGitHubCopilotTokenCachePath } from './github-copilot.js';
import { summarizeError } from '../utils/error-display.js';
import {
  splitModelRegistryKey,
  stableStringify,
  withRegistryKey,
} from './registry-helpers.js';
import { computeConfiguredProviderIds } from './registry-configured-ids.js';
import { initProviderCatalog, refreshProviderCatalog } from './registry-catalog-lifecycle.js';
import {
  buildModelRegistry,
  findModelDefinition,
  findModelDefinitionForProvider,
} from './registry-models.js';
import type {
  ModelDefinition,
  ProviderRegistryOptions,
  RuntimeProviderRegistration,
  TokenLimits,
} from './registry-types.js';
export type {
  ContextWindowProvenance,
  ModelDefinition,
  ModelTier,
  ProviderRegistryOptions,
  RuntimeProviderRegistration,
  TokenLimits,
} from './registry-types.js';

/**
 * ProviderRegistry — manages LLM provider instances and model selection.
 * Lazily instantiates providers on first use.
 */
export class ProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map();
  private currentModelRegistryKey: string;
  private discoveredProviderNames: Set<string> = new Set();
  private runtimeProviderNames: Set<string> = new Set();
  private customModels: ModelDefinition[] = [];
  private runtimeModels: ModelDefinition[] = [];
  private discoveredModels: ModelDefinition[] = [];
  private readonly runtimeCatalogSuppressedRegistryKeys = new Map<string, readonly string[]>();
  private _watcher: { close: () => void } | undefined;
  private _readyPromise: Promise<void> | null = null;
  private readonly configManager: Pick<ConfigManager, 'get' | 'getCategory' | 'getControlPlaneConfigDir'>;
  private readonly subscriptionManager: Pick<SubscriptionManager, 'get' | 'getPending' | 'saveSubscription' | 'resolveAccessToken'>;
  private readonly capabilityRegistry: ProviderCapabilityRegistry;
  private readonly cacheHitTracker: CacheHitTracker;
  private readonly featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null;
  private readonly favoritesStore: Pick<FavoritesStore, 'load'>;
  private readonly benchmarkStore: Pick<BenchmarkStore, 'getBenchmarks' | 'getTopBenchmarkModelIds'>;
  private readonly modelLimitsService: ModelLimitsService;
  private readonly runtimeMetadataDeps: ProviderRuntimeMetadataDeps;
  private readonly runtimeBus: RuntimeEventBus | null;
  private readonly localContextIngestionService = new LocalContextIngestionService();
  private catalogModels: CatalogModel[] = [];
  private pricingCatalog: PricingCatalog | null = null;
  private syntheticCanonicalModels: CanonicalModel[] = [];
  private _cachedModelRegistry: ModelDefinition[] | null = null;
  private _modelRegistryRevision = 0;

  constructor(options: ProviderRegistryOptions) {
    this.configManager = options.configManager;
    this.subscriptionManager = options.subscriptionManager;
    this.capabilityRegistry = options.capabilityRegistry;
    this.cacheHitTracker = options.cacheHitTracker;
    this.favoritesStore = options.favoritesStore;
    this.benchmarkStore = options.benchmarkStore;
    this.modelLimitsService = options.modelLimitsService ?? new ModelLimitsService({
      cachePath: getModelLimitsCachePath(this.getPersistenceRoot()),
    });
    this.runtimeMetadataDeps = {
      secretsManager: options.secretsManager,
      serviceRegistry: options.serviceRegistry,
      subscriptionManager: options.subscriptionManager,
    };
    this.featureFlags = options.featureFlags ?? null;
    this.runtimeBus = options.runtimeBus ?? null;
    this.currentModelRegistryKey = this.readConfiguredModelRegistryKey();
    this.registerBuiltins();
  }

  private readConfiguredModelRegistryKey(): string {
    const rawConfiguredModel = getConfiguredModelId(this.configManager);
    const configuredModel = typeof rawConfiguredModel === 'string' ? rawConfiguredModel.trim() : '';
    if (!configuredModel) return 'openrouter:openrouter/free';
    if (configuredModel.includes(':')) return configuredModel;
    throw new Error(`provider.model must be a provider-qualified registryKey; received '${configuredModel}'.`);
  }

  private registerBuiltins(): void {
    const apiKey = (name: string): string => getConfiguredApiKeys()[name] ?? '';
    registerBuiltinProviders(
      this,
      (name) => this.providers.has(name),
      apiKey,
      {
        cacheHitTracker: this.cacheHitTracker,
        resolveProvider: (providerName) => this.require(providerName),
        getCatalogModels: () => this.syntheticCanonicalModels,
        getBenchmarks: (modelId) => this.benchmarkStore.getBenchmarks(modelId),
        githubCopilotTokenCachePath: getGitHubCopilotTokenCachePath(this.getPersistenceRoot()),
        subscriptionManager: this.subscriptionManager,
        runtimeBus: this.runtimeBus,
      },
    );
  }

  private getPersistenceRoot(): string {
    return this.configManager.getControlPlaneConfigDir();
  }

  private getCustomProvidersDir(): string {
    return join(this.getPersistenceRoot(), 'providers');
  }

  private getCatalogCachePaths(): { cachePath: string; tmpPath: string } {
    const cachePath = getCatalogCachePath(this.getPersistenceRoot());
    return {
      cachePath,
      tmpPath: getCatalogTmpPath(this.getPersistenceRoot()),
    };
  }

  private getCatalogBuiltins(): ModelDefinition[] {
    return getCatalogModelDefinitionsFrom(this.catalogModels) as ModelDefinition[];
  }

  private getSyntheticBuiltins(): ModelDefinition[] {
    return getSyntheticModelDefinitions(this.catalogModels, this.syntheticCanonicalModels) as ModelDefinition[];
  }

  private updateCatalogState(models: readonly CatalogModel[], fetchedAt = Date.now()): void {
    this.catalogModels = [...models];
    this.pricingCatalog = { fetchedAt, models: this.catalogModels };
    this.syntheticCanonicalModels = buildSyntheticCanonicalModels(this.catalogModels);
    this._invalidateModelRegistry();
  }

  private getSuppressedCatalogModelRegistryKeys(): Set<string> {
    return new Set([...this.runtimeCatalogSuppressedRegistryKeys.values()].flat());
  }

  private _invalidateModelRegistry(): void {
    this._cachedModelRegistry = null;
    this._modelRegistryRevision++;
  }

  private getModelRegistry(): ModelDefinition[] {
    if (this._cachedModelRegistry !== null) return this._cachedModelRegistry;
    this._cachedModelRegistry = buildModelRegistry({
      customModels: this.customModels,
      runtimeModels: this.runtimeModels,
      syntheticModels: this.getSyntheticBuiltins(),
      catalogModels: this.getCatalogBuiltins(),
      discoveredModels: this.discoveredModels,
      suppressedCatalogRegistryKeys: this.getSuppressedCatalogModelRegistryKeys(),
    });
    return this._cachedModelRegistry;
  }

  /** Register a provider. Overwrites any existing entry with the same name. */
  register(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
    this._invalidateModelRegistry();
  }

  /**
   * Register a runtime/plugin-owned provider and optional model definitions.
   * Returns an unregister callback so plugin cleanup can remove the provider and
   * its runtime model/catalog contributions.
   */
  registerRuntimeProvider(registration: RuntimeProviderRegistration): () => void {
    const { provider, models = [], suppressCatalogModelRegistryKeys = [], replace = false } = registration;
    if (this.providers.has(provider.name) && !this.runtimeProviderNames.has(provider.name) && !replace) {
      throw new Error(`Provider '${provider.name}' is already registered.`);
    }
    this.providers.set(provider.name, provider);
    this.runtimeProviderNames.add(provider.name);
    this.runtimeModels = [
      ...this.runtimeModels.filter((model) => model.provider !== provider.name),
      ...models.map((model) => withRegistryKey({
        ...model,
        provider: provider.name,
        registryKey: model.registryKey || `${provider.name}:${model.id}`,
      })),
    ];
    this.runtimeCatalogSuppressedRegistryKeys.set(provider.name, [...new Set(suppressCatalogModelRegistryKeys)]);
    this.capabilityRegistry.invalidate();
    this._invalidateModelRegistry();
    return () => {
      if (!this.runtimeProviderNames.has(provider.name)) return;
      this.providers.delete(provider.name);
      this.runtimeProviderNames.delete(provider.name);
      this.runtimeModels = this.runtimeModels.filter((model) => model.provider !== provider.name);
      this.runtimeCatalogSuppressedRegistryKeys.delete(provider.name);
      this.capabilityRegistry.invalidate();
      this._invalidateModelRegistry();
    };
  }

  listProviders(): readonly LLMProvider[] {
    return [...this.providers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Register providers discovered by the local LLM scanner.
   * Clears previously discovered providers before re-registering.
   * Does not overwrite built-in or custom-loaded providers/models.
   */
  registerDiscoveredProviders(servers: DiscoveredServer[]): void {
    // Unregister previously discovered providers
    for (const name of this.discoveredProviderNames) {
      this.providers.delete(name);
    }
    this.discoveredProviderNames.clear();
    this.discoveredModels = [];
    for (const server of servers) {
      // Skip if a non-discovered provider already holds this name
      if (this.providers.has(server.name)) continue;
      // Skip servers with no models — defaultModel would be undefined
      if (server.models.length === 0) continue;

      const reasoningFormat = getDiscoveredReasoningFormat(server.serverType);
      const traits = getDiscoveredTraits(server.serverType);

      const provider = createDiscoveredProvider(server);

      this.providers.set(server.name, provider);
      this.discoveredProviderNames.add(server.name);

      for (const modelId of server.models) {
        this.discoveredModels.push({
          id: modelId,
          provider: server.name,
          registryKey: `${server.name}:${modelId}`,
          displayName: modelId,
          description: `Discovered local model on ${server.baseURL}`,
          capabilities: traits.modelCapabilities,
          ...(traits.reasoningEffort ? { reasoningEffort: traits.reasoningEffort } : {}),
          contextWindow: server.modelContextWindows?.[modelId] ?? 8192,
          ...(server.modelContextWindows?.[modelId] != null
            ? { contextWindowProvenance: 'provider_api' as const }
            : { contextWindowProvenance: 'fallback' as const }),
          ...(server.modelOutputLimits?.[modelId] != null
            ? { tokenLimits: { maxOutputTokens: server.modelOutputLimits[modelId] } }
            : {}),
          selectable: true,
          tier: 'standard',
        });
      }
    }
    this._invalidateModelRegistry();
  }

  /**
   * Returns `true` if a provider with the given name (or its catalog alias) is registered.
   *
   * @param id - Provider name as registered (e.g. `'anthropic'`, `'openai'`).
   */
  has(id: string): boolean {
    if (this.providers.has(id)) return true;
    const aliased = CATALOG_PROVIDER_NAME_ALIASES[id]!;
    return aliased !== undefined && this.providers.has(aliased);
  }

  /**
   * Retrieve a provider by name, applying subscription route aliasing.
   * Throws a {@link ProviderNotFoundError} if no provider with that name is registered.
   *
   * The error message includes the list of all currently registered provider IDs
   * to aid discoverability.
   *
   * @param id - Provider name as registered (e.g. `'anthropic'`, `'openai'`).
   * @throws {ProviderNotFoundError} When no matching provider is registered.
   */
  require(id: string): LLMProvider {
    const provider = this.tryGet(id);
    if (provider) return provider;
    const available = [...this.providers.keys()].sort();
    throw new ProviderNotFoundError(id, available);
  }

  /**
   * Retrieve a provider by name, applying subscription route aliasing.
   * Returns `undefined` if no provider with that name (or its catalog alias) is registered.
   *
   * Prefer {@link require} when you know the provider must exist and want a clear
   * error when it does not.
   *
   * @param name - Provider name as registered (e.g. `'anthropic'`, `'openai'`).
   */
  tryGet(name: string): LLMProvider | undefined {
    if (name === 'openai' && this.subscriptionManager.get('openai')) {
      const subscriber = this.providers.get('openai-subscriber');
      if (subscriber) return subscriber;
    }
    const p = this.providers.get(name);
    if (p) return p;
    // Check alias map — catalog may use a different name than the registered provider
    const aliased = CATALOG_PROVIDER_NAME_ALIASES[name]!;
    if (aliased) {
      const pa = this.providers.get(aliased);
      if (pa) return pa;
    }
    return undefined;
  }

  get(name: string): LLMProvider | undefined {
    return this.tryGet(name);
  }

  /**
   * Retrieve the directly-registered provider without subscription route aliasing.
   * Throws if no provider with that name (or its catalog alias) is registered.
   *
   * Note: Unlike {@link require}, this method does NOT apply subscription route aliasing
   * (e.g. the openai-subscriber redirect). Prefer {@link require} for general use.
   */
  getRegistered(name: string): LLMProvider {
    const p = this.providers.get(name);
    if (p) return p;
    // Check alias map — catalog may use a different name than the registered provider
    const aliased = CATALOG_PROVIDER_NAME_ALIASES[name]!;
    if (aliased) {
      const pa = this.providers.get(aliased);
      if (pa) return pa;
    }
    throw new ProviderNotFoundError(name, [...this.providers.keys()].sort());
  }

  async describeRuntime(name: string): Promise<ProviderRuntimeMetadata | null> {
    const provider = this.getRegistered(name);
    if (!provider.describeRuntime) return null;
    return await provider.describeRuntime(this.runtimeMetadataDeps);
  }

  /**
   * Return the provider responsible for a model. Callers without an explicit
   * provider must pass a provider-qualified registryKey (`provider:modelId`).
   */
  getForModel(modelId: string, provider?: string): LLMProvider {
    if (!provider && !modelId.includes(':')) {
      throw new Error(`Model lookup requires a provider-qualified registryKey; received '${modelId}'.`);
    }
    const registry = this.getModelRegistry();
    const def = provider
      ? findModelDefinitionForProvider(modelId, provider, registry, CATALOG_PROVIDER_NAME_ALIASES)
      : findModelDefinition(modelId, registry);
    if (!def) {
      if (provider) throw new Error(`No model '${modelId}' for provider '${provider}' in registry.`);
      throw new Error(`No model '${modelId}' in registry.`);
    }
    return this.require(def.provider);
  }

  /** All registered model definitions. */
  listModels(): ModelDefinition[] {
    return this.getModelRegistry();
  }

  getCostFromCatalog(modelId: string): { input: number; output: number } {
    return getCostFromPricingCatalog(
      modelId,
      this.pricingCatalog ?? { fetchedAt: Date.now(), models: this.catalogModels },
      this.modelLimitsService,
    );
  }

  getContextWindowForModel(modelDef: ModelDefinition): number {
    return this.modelLimitsService.getContextWindowForModel(modelDef);
  }

  getTokenLimitsForModel(modelDef: ModelDefinition): Required<TokenLimits> {
    return this.modelLimitsService.getTokenLimitsForModel(modelDef);
  }

  getPricingForModel(modelId: string, provider: string): { prompt: number; completion: number } | null {
    return this.modelLimitsService.getPricingForModel(modelId, provider);
  }

  getToolResultMaxCharsForModel(model: ModelDefinition | null | undefined): number {
    return this.modelLimitsService.getToolResultMaxCharsForModel(model);
  }

  initModelLimits(): void {
    this.modelLimitsService.init();
  }

  refreshModelLimits(): Promise<number> {
    return this.modelLimitsService.refresh();
  }

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
      (candidateId) => this.benchmarkStore.getBenchmarks(candidateId),
    );
  }

  getConfiguredProviderIds(): string[] {
    return computeConfiguredProviderIds(
      this.catalogModels,
      this.providers,
      () => this.getSyntheticBackendModelIds(),
    );
  }

  /** Only the models the user can switch to. */
  getSelectableModels(): ModelDefinition[] {
    return this.getModelRegistry().filter((m) => m.selectable);
  }

  /** Currently active model definition. */
  getCurrentModel(): ModelDefinition {
    const registry = this.getModelRegistry();
    const def = findModelDefinition(this.currentModelRegistryKey, registry);
    if (!def) {
      throw new Error(`Current model '${this.currentModelRegistryKey}' not in registry.`);
    }
    return def;
  }

  /**
   * Override the context window cap for a custom or discovered (local) model.
   * Mutates the live model entry in customModels or discoveredModels so the change
   * is reflected immediately without requiring a full provider reload.
   *
   * @param registryKey - The model's registryKey (`provider:id`).
   * @param cap         - New context window value in tokens.
   * @remarks Context cap is session-only. Not persisted to config — lost on restart.
   */
  setModelContextCap(registryKey: string, cap: number): void {
    // Try customModels first, then discoveredModels
    const customIdx = this.customModels.findIndex((m) => m.registryKey === registryKey);
    if (customIdx >= 0) {
      this.customModels[customIdx] = {
        ...this.customModels[customIdx]!,
        contextWindow: cap,
        contextWindowProvenance: 'configured_cap',
      };
      this._invalidateModelRegistry();
      return;
    }
    const discoveredIdx = this.discoveredModels.findIndex((m) => m.registryKey === registryKey);
    if (discoveredIdx >= 0) {
      this.discoveredModels[discoveredIdx] = {
        ...this.discoveredModels[discoveredIdx]!,
        contextWindow: cap,
        contextWindowProvenance: 'configured_cap',
      };
      this._invalidateModelRegistry();
      return;
    }
    logger.warn('[registry] setModelContextCap: model not found', { registryKey });
  }

  /** Switch to a different model. Requires the model registryKey (`provider:modelId`). */
  setCurrentModel(registryKey: string): void {
    if (!registryKey.includes(':')) {
      throw new Error(`Model selection requires a provider-qualified registryKey; received '${registryKey}'.`);
    }
    const def = findModelDefinition(registryKey, this.getModelRegistry());
    if (!def) throw new Error(`Model '${registryKey}' not found.`);
    if (!def.selectable) throw new Error(`Model '${registryKey}' is not selectable.`);
    const previousRegistryKey = this.currentModelRegistryKey;
    const previousProvider = splitModelRegistryKey(previousRegistryKey).providerId;
    // Store the registryKey for unambiguous future lookups
    this.currentModelRegistryKey = def.registryKey;
    if (this.runtimeBus) {
      const traceId = `model:changed:${Date.now()}`;
      emitModelChanged(this.runtimeBus, { sessionId: 'system', source: 'provider-registry', traceId }, {
        registryKey: this.currentModelRegistryKey,
        provider: def.provider ?? '',
        ...(previousRegistryKey !== this.currentModelRegistryKey
          ? { previous: { registryKey: previousRegistryKey, provider: previousProvider ?? '' } }
          : {}),
      });
    }
  }

  /**
   * Load custom providers from the configured providers directory and merge them
   * into the live model registry. Returns any warnings collected during loading.
   * Call this after construction to populate custom providers.
   */
  async loadCustomProviders(): Promise<{ warnings: string[]; added: string[]; removed: string[]; updated: string[] }> {
    const result = await loadCustomProviders({
      providersDir: this.getCustomProvidersDir(),
      ingestContextWindows: this.featureFlags?.isEnabled('local-provider-context-ingestion') ?? false,
      contextIngestion: this.localContextIngestionService,
    });
    const previousRegistryKeys = new Set(this.customModels.map((model) => withRegistryKey(model).registryKey));
    const newRegistryKeys = new Set(result.models.map((model) => withRegistryKey(model).registryKey));

    const added: string[] = [];
    const removed: string[] = [];
    const updated: string[] = [];

    for (const registryKey of newRegistryKeys) {
      if (!previousRegistryKeys.has(registryKey)) {
        added.push(registryKey);
      } else {
        // Only mark as updated if the model definition actually changed
        const oldModel = this.customModels.find((model) => withRegistryKey(model).registryKey === registryKey);
        const newModel = result.models.find((model) => withRegistryKey(model).registryKey === registryKey);
        const oldComparable = oldModel ? withRegistryKey(oldModel) : oldModel;
        const newComparable = newModel ? withRegistryKey(newModel) : newModel;
        if (stableStringify(oldComparable) !== stableStringify(newComparable)) {
          updated.push(registryKey);
        }
      }
    }
    for (const registryKey of previousRegistryKeys) {
      if (!newRegistryKeys.has(registryKey)) removed.push(registryKey);
    }

    // Warn about registry-key collisions with catalog models.
    const catalogRegistryKeys = new Set(this.getCatalogBuiltins().map((builtin) => withRegistryKey(builtin).registryKey));
    for (const model of result.models) {
      const registryKey = withRegistryKey(model).registryKey;
      if (catalogRegistryKeys.has(registryKey)) {
        const msg = `[registry] Custom model '${registryKey}' overrides catalog model.`;
        result.warnings.push(msg);
        // Warning already added to result.warnings — don't console.warn (corrupts TUI)
      }
    }

    // Register provider instances
    for (const { provider } of result.providers) {
      this.register(provider);
    }

    // Swap custom models
    this.customModels = result.models;
    this._invalidateModelRegistry();

    return { warnings: result.warnings, added, removed, updated };
  }

  /**
   * Start watching the configured providers directory for file changes.
   * On change, reloads custom providers and emits typed provider runtime events.
   * Safe to call multiple times — stops the previous watcher first.
   */
  startWatching(runtimeBus: RuntimeEventBus | null = null): void {
    this.stopWatching();
    this._watcher = watchCustomProviders(runtimeBus, async () => {
      const result = await this.loadCustomProviders();
      for (const msg of result.warnings) {
        if (runtimeBus) {
          emitProviderWarning(runtimeBus, {
            sessionId: 'system',
            traceId: `providers:warning:${Date.now()}`,
            source: 'provider-registry',
          }, { message: msg });
        }
      }
      if (runtimeBus) {
        emitProvidersChanged(runtimeBus, {
          sessionId: 'system',
          traceId: `providers:changed:${Date.now()}`,
          source: 'provider-registry',
        }, {
          added: result.added,
          removed: result.removed,
          updated: result.updated,
        });
      }
    }, this.getCustomProvidersDir());
  }

  /** Stop the file watcher started by startWatching(). */
  stopWatching(): void {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = undefined;
    }
  }

  /**
   * Returns a promise that resolves when the initial custom provider load
   * completes. Callers can await this before looking up a custom registryKey.
   */
  ready(): Promise<void> {
    return this._readyPromise ?? Promise.resolve();
  }

  /**
   * Find an alternative model when the current provider fails non-transiently.
   * Prefers a synthetic failover wrapper; falls back to same-tier model on a different provider.
   */
  findAlternativeModel(currentRegistryKey: string): ModelDefinition | null {
    const current = findModelDefinition(currentRegistryKey, this.getModelRegistry());
    if (!current || current.provider === 'synthetic') return null;
    // Check if synthetic wrapper exists
    const baseName = current.id.split('/').pop() ?? '';
    const syntheticMatch = this.getModelRegistry().find((model) => model.provider === 'synthetic' && (model.id === baseName || model.id.endsWith('/' + baseName)));
    if (syntheticMatch) return syntheticMatch;
    // Find same-tier model on different provider
    return this.getModelRegistry().find((model) => model.registryKey !== current.registryKey && model.provider !== current.provider && model.tier === current.tier && model.selectable) ?? null;
  }

  /**
   * Resolve the full capability record for a model.
   * Requires a provider-qualified registryKey.
   *
   * @param registryKey - Provider-qualified registryKey (`provider:modelId`).
   * @returns A fully-resolved, immutable `ProviderCapability`.
   */
  getCapabilityForModel(registryKey: string): ProviderCapability {
    const { providerId, resolvedModelId, provider } = this._resolveModelContext(registryKey);
    return this.capabilityRegistry.getCapability(providerId, resolvedModelId, provider);
  }

  /**
   * Check whether a model can handle a request described by `profile`.
   * Fails early with a typed explanation when unsupported — avoids mid-stream errors.
   *
   * @param registryKey - Provider-qualified registryKey.
   * @param profile - The capability requirements for this request.
   * @returns A `RouteExplanation` with `accepted` flag, rejections, and capability.
   */
  explainRoute(registryKey: string, profile: RequestProfile): RouteExplanation {
    const { providerId, resolvedModelId, provider } = this._resolveModelContext(registryKey);
    return this.capabilityRegistry.getRouteExplanation(providerId, resolvedModelId, profile, provider);
  }

  /**
   * Resolve the provider identity and instance for a registryKey.
   * Shared by `getCapabilityForModel` and `explainRoute` to avoid duplication.
   *
   * @param registryKey - Provider-qualified registryKey (`provider:modelId`).
   */
  private _resolveModelContext(registryKey: string): {
    providerId: string;
    resolvedModelId: string;
    provider: LLMProvider | undefined;
  } {
    if (!registryKey.includes(':')) {
      throw new Error(`Model capability lookups require a provider-qualified registryKey; received '${registryKey}'.`);
    }
    const registry = this.getModelRegistry();
    const def = findModelDefinition(registryKey, registry);
    if (def) {
      return { providerId: def.provider, resolvedModelId: def.id, provider: this.tryGet(def.provider) };
    }
    throw new Error(`Model '${registryKey}' is not in registry.`);
  }

  /** Kick off async custom provider loading. Called once from bootstrap-owned construction. */
  initCustomProviders(): void {
    this._readyPromise = this.loadCustomProviders()
      .then((result) => {
        // Warnings captured in result.warnings — don't console.warn (corrupts TUI)
        // Invalidate the capability cache so custom providers' self-declared
        // capabilities are reflected in subsequent getCapabilityForModel calls.
        this.capabilityRegistry.invalidate();
        this._readyPromise = null;
      })
      .catch((err) => {
        // Do not console.warn here; it corrupts TUI display.
        this._readyPromise = null;
      });
  }

  initCatalog(): void {
    initProviderCatalog(this._catalogLifecycleCtx());
  }

  async refreshCatalog(): Promise<void> {
    await refreshProviderCatalog(this._catalogLifecycleCtx());
  }

  private _catalogLifecycleCtx() {
    return {
      getCatalogCachePaths: () => this.getCatalogCachePaths(),
      updateCatalogState: (models: readonly CatalogModel[], fetchedAt?: number) =>
        this.updateCatalogState(models, fetchedAt),
      getCatalogModels: () => this.catalogModels as readonly CatalogModel[],
      favoritesStore: this.favoritesStore,
      benchmarkStore: this.benchmarkStore,
      refreshCatalog: () => this.refreshCatalog(),
    };
  }
}
