import type { LLMProvider, ProviderRuntimeMetadata, ProviderRuntimeMetadataDeps } from './interface.js';
import { ProviderNotFoundError } from './provider-not-found-error.js';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import {
  ProviderCapabilityRegistry, type ProviderCapability, type RequestProfile, type RouteExplanation,
} from './capabilities.js';
import type { DiscoveredServer } from '../discovery/scanner.js';
import { createDiscoveredProvider, getDiscoveredReasoningFormat } from './discovered-factory.js';
import { getDiscoveredTraits } from './discovered-traits.js';
import { getConfiguredApiKeys, getConfiguredModelId, resolveApiKeys } from '../config/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { emitProvidersChanged, emitProviderWarning, emitModelChanged } from '../runtime/emitters/index.js';
import { loadCustomProviders, watchCustomProviders } from './custom-loader.js';
import {
  buildSyntheticCanonicalModels, getCatalogCachePath, getCatalogModelDefinitionsFrom, getCatalogTmpPath,
  getCostFromPricingCatalog, getSyntheticBackendModelIds, getSyntheticModelDefinitions, getSyntheticModelInfo,
  type CatalogModel, type CatalogModelPricing, type CatalogProvider, type MinimalModelDefinition, type PricingCatalog,
} from './model-catalog.js';
import {
  buildRegistryModelPricingDeps, resolveModelPricing as resolveModelPricingFromDeps, type ResolvedModelPricing,
} from './model-pricing.js';
import { GatewayPricingService } from './gateway-pricing.js';
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
import { inferFallbackContextWindow } from './context-window-fallback.js';
import { ContextWindowOverrideStore, getContextWindowOverridesPath } from './context-window-overrides.js';
import { splitModelRegistryKey, withRegistryKey } from './registry-helpers.js';
import { computeConfiguredProviderIds } from './registry-configured-ids.js';
import { initProviderCatalog, refreshProviderCatalog } from './registry-catalog-lifecycle.js';
import {
  buildModelRegistry, diffCustomModels, findModelDefinition, findModelDefinitionForProvider,
} from './registry-models.js';
import { assertProviderModelSource } from './model-source-contract.js';
import { assertProviderCredentialAuthority } from './credential-authority-contract.js';
import { resolveModelReference } from './model-id-resolution.js';
import type { LiveModelDiscoveryResult } from './live-model-discovery.js';
import {
  applyProviderNativeModelBaseline, removeProviderNativeModels, sweepLiveModelDiscovery,
} from './registry-live-model-discovery.js';
import type {
  ModelDefinition, ProviderRegistryOptions, RuntimeProviderRegistration, TokenLimits,
} from './registry-types.js';
export type {
  ContextWindowProvenance, ModelDefinition, ModelTier, ProviderRegistryOptions, RuntimeProviderRegistration, TokenLimits,
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
  /** Provider-sourced models — see registry-live-model-discovery.ts. */
  private providerNativeModels: ModelDefinition[] = [];
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
  private readonly gatewayPricing: GatewayPricingService;
  private readonly runtimeMetadataDeps: ProviderRuntimeMetadataDeps;
  private readonly runtimeBus: RuntimeEventBus | null;
  private readonly localContextIngestionService = new LocalContextIngestionService();
  private catalogModels: CatalogModel[] = [];
  private pricingCatalog: PricingCatalog | null = null;
  private syntheticCanonicalModels: CanonicalModel[] = [];
  private _cachedModelRegistry: ModelDefinition[] | null = null;
  private _modelRegistryRevision = 0;
  /** Persisted per-model context-window overrides; lazy-constructed (needs persistence root). */
  private _contextWindowOverrideStore: ContextWindowOverrideStore | null = null;

  constructor(options: ProviderRegistryOptions) {
    this.configManager = options.configManager;
    this.subscriptionManager = options.subscriptionManager;
    this.capabilityRegistry = options.capabilityRegistry;
    this.cacheHitTracker = options.cacheHitTracker;
    this.favoritesStore = options.favoritesStore;
    this.benchmarkStore = options.benchmarkStore;
    this.modelLimitsService = options.modelLimitsService
      ?? new ModelLimitsService({ cachePath: getModelLimitsCachePath(this.getPersistenceRoot()) });
    this.gatewayPricing = new GatewayPricingService({ cacheDir: this.getPersistenceRoot() });
    this.runtimeMetadataDeps = {
      secretsManager: options.secretsManager, serviceRegistry: options.serviceRegistry, subscriptionManager: options.subscriptionManager,
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

  private registerBuiltins(resolvedKeys?: Record<string, string>): void {
    // Construction: env keys (sync). Refresh: resolver map (env -> secrets), force-overwriting builtins.
    const apiKey = (name: string): string => resolvedKeys?.[name] ?? getConfiguredApiKeys()[name] ?? '';
    registerBuiltinProviders(this, (name) => (resolvedKeys ? false : this.providers.has(name)), apiKey, {
      cacheHitTracker: this.cacheHitTracker,
      resolveProvider: (providerName) => this.require(providerName),
      getCatalogModels: () => this.syntheticCanonicalModels,
      getBenchmarks: (modelId) => this.benchmarkStore.getBenchmarks(modelId),
      githubCopilotTokenCachePath: getGitHubCopilotTokenCachePath(this.getPersistenceRoot()),
      subscriptionManager: this.subscriptionManager,
      runtimeBus: this.runtimeBus,
      persistenceRoot: this.getPersistenceRoot(),
    });
  }

  /**
   * Live credential refresh: re-resolves every builtin key (env -> secrets
   * store) and force re-registers builtins, so a key written to the secrets
   * store is usable in the SAME process. Runs at boot and on secrets changes.
   */
  async refreshProviderCredentials(): Promise<void> {
    const resolved = await resolveApiKeys(this.runtimeMetadataDeps.secretsManager);
    this.registerBuiltins(resolved);
    this._invalidateModelRegistry();
    if (this.runtimeBus) {
      emitProvidersChanged(this.runtimeBus, { sessionId: 'system', traceId: `providers:credentials:${Date.now()}`, source: 'provider-registry' }, { added: [], removed: [], updated: [...this.providers.keys()] });
    }
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

  private getCatalogBuiltins(): ModelDefinition[] { return getCatalogModelDefinitionsFrom(this.catalogModels) as ModelDefinition[]; }

  private getSyntheticBuiltins(): ModelDefinition[] { return getSyntheticModelDefinitions(this.catalogModels, this.syntheticCanonicalModels) as ModelDefinition[]; }

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
      providerNativeModels: this.providerNativeModels,
      syntheticModels: this.getSyntheticBuiltins(),
      catalogModels: this.getCatalogBuiltins(),
      discoveredModels: this.discoveredModels,
      suppressedCatalogRegistryKeys: this.getSuppressedCatalogModelRegistryKeys(),
    }).map((model) => this.contextWindowOverrideStore().apply(model));
    return this._cachedModelRegistry;
  }

  private contextWindowOverrideStore(): ContextWindowOverrideStore {
    this._contextWindowOverrideStore ??= new ContextWindowOverrideStore(
      getContextWindowOverridesPath(this.getPersistenceRoot()),
    );
    return this._contextWindowOverrideStore;
  }

  /** Register a provider. Overwrites any existing entry with the same name. Fails closed on a dead model source (model-source-contract.ts). */
  register(provider: LLMProvider): void {
    assertProviderModelSource(provider);
    assertProviderCredentialAuthority(provider);
    this.providers.set(provider.name, provider);
    this.providerNativeModels = applyProviderNativeModelBaseline(this.providerNativeModels, provider);
    this._invalidateModelRegistry();
  }

  /** The picker-open re-check hook (see registry-live-model-discovery.ts): force bypasses each provider's TTL cache. */
  async refreshLiveModelDiscovery(
    providerId?: string,
    options: { force?: boolean } = {},
  ): Promise<Array<{ providerId: string } & LiveModelDiscoveryResult>> {
    const { providerNativeModels, reports } = await sweepLiveModelDiscovery(
      this.providers.values(),
      this.providerNativeModels,
      providerId,
      options,
    );
    this.providerNativeModels = providerNativeModels;
    if (reports.length > 0) this._invalidateModelRegistry();
    return reports;
  }

  /** Register a runtime/plugin-owned provider + optional models; returns an unregister callback. */
  registerRuntimeProvider(registration: RuntimeProviderRegistration): () => void {
    const { provider, models = [], suppressCatalogModelRegistryKeys = [], replace = false } = registration;
    if (this.providers.has(provider.name) && !this.runtimeProviderNames.has(provider.name) && !replace) {
      throw new Error(`Provider '${provider.name}' is already registered.`);
    }
    // A plugin's model source may be the explicit `models` list below (this.runtimeModels)
    // rather than the LLMProvider's own fields — only contract-check when both are empty.
    if (models.length === 0) assertProviderModelSource(provider);
    this.providers.set(provider.name, provider);
    this.providerNativeModels = applyProviderNativeModelBaseline(this.providerNativeModels, provider);
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
      this.providerNativeModels = removeProviderNativeModels(this.providerNativeModels, provider.name);
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

  /** Return the provider responsible for a model — a registryKey, or a bare id resolved via the shared resolver. */
  getForModel(modelId: string, provider?: string): LLMProvider {
    const registry = this.getModelRegistry();
    // findModelDefinitionForProvider already resolves bare ids when a provider is given.
    const resolvedModelId = !provider && !modelId.includes(':') ? resolveModelReference(modelId, registry) : modelId;
    const def = provider
      ? findModelDefinitionForProvider(resolvedModelId, provider, registry, CATALOG_PROVIDER_NAME_ALIASES)
      : findModelDefinition(resolvedModelId, registry);
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

  /** Legacy string-keyed catalog lookup — null when unpriced. Prefer resolveModelPricing. */
  getCostFromCatalog(modelId: string): CatalogModelPricing | null {
    return getCostFromPricingCatalog(modelId, this.pricingCatalog ?? { fetchedAt: Date.now(), models: this.catalogModels }, this.modelLimitsService);
  }

  /**
   * ONE pricing resolution per (provider, model): manual config price ('user')
   * -> registration price ('user') -> provider-served ('provider', dated) ->
   * catalog ('catalog', dated) -> subscription -> honest unknown (never $0).
   * Manual prices are read live on every call — no restart.
   */
  resolveModelPricing(modelRef: string, providerId?: string): ResolvedModelPricing {
    return resolveModelPricingFromDeps(buildRegistryModelPricingDeps({
      getManualPrices: () => this.configManager.get('pricing.modelPrices'),
      findModelPricing: (provider, modelId) =>
        this.getModelRegistry().find((def) => def.id === modelId && (!provider || def.provider === provider))?.pricing ?? null,
      openRouterPricing: (modelId) => {
        const served = this.modelLimitsService.getPricingForModel(modelId, 'openrouter');
        return served ? { ...served, fetchedAt: this.modelLimitsService.getPricingFetchedAt() ?? undefined } : null;
      },
      gatewayPricing: (provider, modelId) => this.gatewayPricing.getPricing(provider, modelId),
      getCatalog: () => this.pricingCatalog ?? { fetchedAt: 0, models: this.catalogModels },
      providerAliases: CATALOG_PROVIDER_NAME_ALIASES,
      isKnownProviderId: (id) => this.providers.has(id) || this.catalogModels.some((model) => model.providerId === id),
    }), modelRef, providerId);
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
    if (def) return def;
    const fallback = this.buildConfiguredModelFallback(this.currentModelRegistryKey);
    if (fallback) return fallback;
    throw new Error(`Current model '${this.currentModelRegistryKey}' not in registry.`);
  }

  /**
   * Synthesize a minimal model definition for the configured registryKey when
   * the catalog-backed registry hasn't materialized it yet — e.g. a fresh
   * daemon home before the models.dev catalog fetch has completed (or while
   * offline, where it never will). `buildModelRegistry()` only draws from
   * custom/runtime/synthetic/catalog/discovered models, none of which are
   * populated synchronously at construction time, so a stock default like
   * 'openrouter:openrouter/free' can otherwise be unresolvable for the entire
   * lifetime of a catalog-less boot.
   *
   * Deliberately narrow: only resolves when `providerId` is an actually
   * registered provider AND that provider's own static `models` list already
   * declares `resolvedModelId` (e.g. the builtin openrouter provider declares
   * 'openrouter/free' in builtin-registry.ts). A genuinely unknown or
   * misconfigured registryKey still falls through to the "not in registry"
   * error below so callers keep an honest signal instead of a guess.
   */
  private buildConfiguredModelFallback(registryKey: string): ModelDefinition | null {
    let providerId: string;
    let resolvedModelId: string;
    try {
      ({ providerId, resolvedModelId } = splitModelRegistryKey(registryKey));
    } catch {
      return null;
    }
    const provider = this.tryGet(providerId);
    if (!provider || !provider.models.includes(resolvedModelId)) return null;
    const isFree = resolvedModelId.endsWith(':free') || resolvedModelId.endsWith('-free') || resolvedModelId.endsWith('/free');
    return this.contextWindowOverrideStore().apply({
      id: resolvedModelId,
      provider: providerId,
      registryKey: `${providerId}:${resolvedModelId}`,
      displayName: resolvedModelId,
      description: `${resolvedModelId} — builtin provider default; model catalog has not hydrated yet.`,
      capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
      contextWindow: inferFallbackContextWindow(providerId, resolvedModelId),
      contextWindowProvenance: 'fallback',
      selectable: true,
      tier: isFree ? 'free' : 'standard',
    });
  }

  /**
   * Set a user-configured context window (tokens) for any model — custom,
   * discovered, or catalog. Applied as a 'configured_cap' overlay and
   * persisted to the control-plane config dir, so it survives restarts and
   * reaches every consumer of the same home. Keys for models not yet
   * registered are allowed — discovered models pick the override up when
   * they materialize.
   */
  setModelContextCap(registryKey: string, cap: number): void {
    if (!this.contextWindowOverrideStore().set(registryKey, cap)) {
      logger.warn('[registry] setModelContextCap: rejecting invalid cap', { registryKey, cap });
      return;
    }
    this._invalidateModelRegistry();
  }

  /**
   * Clear the user-configured context window AND any learned provider limit,
   * returning the model to fully automatic resolution (catalog / provider
   * API / family fallback). Returns true when anything was cleared.
   */
  clearModelContextCap(registryKey: string): boolean {
    const existed = this.contextWindowOverrideStore().clear(registryKey);
    if (existed) this._invalidateModelRegistry();
    return existed;
  }

  /** The user-configured context window for a model, or null when automatic. */
  getModelContextCap(registryKey: string): number | null {
    return this.contextWindowOverrideStore().get(registryKey);
  }

  /** The learned provider context ceiling for a model, or null when none observed. */
  getObservedContextWindow(registryKey: string): number | null {
    return this.contextWindowOverrideStore().getObserved(registryKey);
  }

  /**
   * A provider rejected a request of ~`rejectedAtTokens` as too long — learn
   * that ceiling so window math, compaction thresholds, and meters use the
   * endpoint's REAL limit instead of an over-stated catalog value.
   */
  recordContextWindowRejection(registryKey: string, rejectedAtTokens: number): void {
    this.contextWindowOverrideStore().recordRejection(registryKey, rejectedAtTokens);
    this._invalidateModelRegistry();
  }

  /** A request with real billed input succeeded — raise a too-pessimistic learned ceiling. */
  reconcileObservedContextWindow(registryKey: string, successfulInputTokens: number): void {
    const before = this.contextWindowOverrideStore().getObserved(registryKey);
    if (before === null || successfulInputTokens <= before) return;
    this.contextWindowOverrideStore().reconcileSuccess(registryKey, successfulInputTokens);
    this._invalidateModelRegistry();
  }

  /** Switch to a different model. Accepts a registryKey or a bare model id (resolved via the shared resolver). */
  setCurrentModel(modelReference: string): void {
    const registryKey = resolveModelReference(modelReference, this.getModelRegistry());
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
    const diff = diffCustomModels(this.customModels, result.models, this.getCatalogBuiltins());
    const warnings = [...result.warnings, ...diff.collisionWarnings];

    // A single misconfigured provider is skipped with a warning, not an abort of the rest.
    for (const { provider } of result.providers) {
      try {
        this.register(provider);
      } catch (err) {
        warnings.push(`[registry] Custom provider '${provider.name}' rejected at registration: ${summarizeError(err)}`);
      }
    }

    this.customModels = result.models;
    this._invalidateModelRegistry();

    return { warnings, added: diff.added, removed: diff.removed, updated: diff.updated };
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
   *
   * @param modelReference - A provider-qualified registryKey (`provider:modelId`) or a bare model id (resolved via the shared resolver).
   * @returns A fully-resolved, immutable `ProviderCapability`.
   */
  getCapabilityForModel(modelReference: string): ProviderCapability {
    const { providerId, resolvedModelId, provider } = this._resolveModelContext(modelReference);
    return this.capabilityRegistry.getCapability(providerId, resolvedModelId, provider);
  }

  /**
   * Check whether a model can handle a request described by `profile`.
   * Fails early with a typed explanation when unsupported — avoids mid-stream errors.
   *
   * @param modelReference - A provider-qualified registryKey or a bare model id (resolved via the shared resolver).
   * @param profile - The capability requirements for this request.
   * @returns A `RouteExplanation` with `accepted` flag, rejections, and capability.
   */
  explainRoute(modelReference: string, profile: RequestProfile): RouteExplanation {
    const { providerId, resolvedModelId, provider } = this._resolveModelContext(modelReference);
    return this.capabilityRegistry.getRouteExplanation(providerId, resolvedModelId, profile, provider);
  }

  /**
   * Resolve the provider identity and instance for a registryKey.
   * Shared by `getCapabilityForModel` and `explainRoute` to avoid duplication.
   *
   * @param registryKey - Provider-qualified registryKey (`provider:modelId`).
   */
  private _resolveModelContext(modelReference: string): {
    providerId: string;
    resolvedModelId: string;
    provider: LLMProvider | undefined;
  } {
    const registry = this.getModelRegistry();
    const registryKey = resolveModelReference(modelReference, registry);
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

  /** Background, TTL-respecting live model discovery sweep (never blocks/throws); separate from initCatalog() so tests calling that without mocking a provider API aren't surprised by a live network call. Real callers invoke this once at startup too. */
  initProviderModelDiscovery(): void {
    void this.refreshLiveModelDiscovery().catch((err) =>
      logger.warn('[provider-models] Background live model discovery failed', { error: summarizeError(err) }));
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
