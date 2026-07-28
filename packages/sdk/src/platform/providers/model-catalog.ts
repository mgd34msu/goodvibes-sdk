import type { ModelDefinition, ProviderRegistry } from './registry.js';
import type { ModelLimitsService } from './model-limits.js';
import type { MinimalModelDefinition, SyntheticModelInfo } from './model-catalog-synthetic.js';
import { logger } from '../utils/logger.js';
import { inferFallbackContextWindow } from './context-window-fallback.js';
import { type ModelsDevReasoningOption, parseReasoningOptions } from './reasoning-effort.js';
import type { ModelCapabilityFacts, ModelCapabilityFactsSource } from './capabilities.js';
import { resolveReasoningEffortSpec } from './reasoning-effort-families.js';

export interface CatalogProvider {
  id: string;
  name: string;
  envVars: string[];
  baseUrl: string;
  requiresKey?: boolean | undefined;
}

/** Catalog rates, USD per 1M tokens. Cache rates present only when the feed carried them. */
export interface CatalogModelPricing {
  input: number;
  output: number;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
}

export interface CatalogModel {
  id: string;
  name: string;
  family?: string | undefined;
  provider: string;
  providerId: string;
  providerEnvVars: string[];
  /** Null when the catalog carried no cost for this model — honestly unpriced, never $0. */
  pricing: CatalogModelPricing | null;
  tier: 'free' | 'paid' | 'subscription';
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  reasoning?: boolean | undefined;
  /**
   * The feed's per-model `reasoning_options`, carried verbatim. Absent means
   * the catalog said nothing (fall through to the curated family table); an
   * empty array means the catalog said this model has no configurable levels.
   */
  reasoningOptions?: ModelsDevReasoningOption[] | undefined;
  /**
   * The feed's per-model `modalities.input` list, carried verbatim — e.g.
   * `['text', 'image', 'pdf']`. This is the catalog's own answer to "does this
   * model accept images", which is what `multimodal` should be read from.
   * Absent means the entry carried no modality block at all.
   */
  inputModalities?: readonly string[] | undefined;
}

export interface PricingCatalog {
  fetchedAt: number;
  models: CatalogModel[];
}

/**
 * Legacy string-keyed catalog price lookup. Returns null when the model is
 * absent from the catalog or its entry carries no cost — absent must never
 * look free. Prefer ProviderRegistry.resolveModelPricing (model-pricing.ts),
 * which resolves per (provider, model) with manual/provider/catalog
 * precedence and an explicit source.
 */
export function getCostFromPricingCatalog(
  modelId: string,
  catalog: Pick<PricingCatalog, 'models'>,
  modelLimitsService?: Pick<ModelLimitsService, 'getPricingForModel'>,
  opts: { debug?: boolean } = {},
): CatalogModelPricing | null {
  if (modelId.endsWith(':free')) {
    return { input: 0, output: 0 };
  }
  const exact = catalog.models.find((model) => model.id === modelId);
  if (exact) {
    if (exact.tier === 'free') return { input: 0, output: 0 };
    return exact.pricing ? { ...exact.pricing } : null;
  }
  for (const model of catalog.models) {
    if (modelId.startsWith(model.id) || modelId.includes(model.id)) {
      if (model.tier === 'free') return { input: 0, output: 0 };
      return model.pricing ? { ...model.pricing } : null;
    }
  }
  if (catalog.models.length === 0) {
    const slashIdx = modelId.indexOf('/');
    const provider = slashIdx !== -1 ? modelId.slice(0, slashIdx) : '';
    const orPricing = modelLimitsService?.getPricingForModel(modelId, provider) ?? null;
    if (orPricing) {
      return { input: orPricing.prompt * 1_000_000, output: orPricing.completion * 1_000_000 };
    }
  }
  if (opts.debug) {
    logger.debug('[cost-tracker] model not in catalog', { modelId });
  }
  return null;
}

export function normalizeModelId(modelId: string): string {
  let id = modelId;
  if (id.startsWith('coding-')) id = id.slice('coding-'.length);
  const slashIdx = id.lastIndexOf('/');
  if (slashIdx !== -1) id = id.slice(slashIdx + 1);
  if (id.endsWith(':free')) id = id.slice(0, -':free'.length);
  if (id.endsWith('-free')) id = id.slice(0, -'-free'.length);
  return id;
}

export function hasKeyForProvider(provider: CatalogProvider): boolean {
  if (provider.requiresKey === false || provider.envVars.length === 0) return true;
  return provider.envVars.some((envVar) => {
    const value = process.env[envVar]!;
    return typeof value === 'string' && value.length > 0;
  });
}

export interface CatalogModelEntry {
  id: string;
  displayName: string;
  provider: string;
  context: number;
  tier: 'free' | 'paid' | 'subscription';
}

export interface CatalogModelChange {
  model: CatalogModel;
  changes: string[];
}

export interface CatalogDiff {
  added: CatalogModel[];
  removed: CatalogModel[];
  changed: CatalogModelChange[];
}

export interface ModelCatalog {
  getModel(modelId: string): CatalogModelEntry | null;
  findLargerContextModels(
    minContext: number,
    tier?: 'free' | 'paid' | 'subscription',
    limit?: number,
  ): CatalogModelEntry[];
}

type ModelCatalogRegistry = Pick<ProviderRegistry, 'listModels' | 'getContextWindowForModel'>;

export class RegistryBackedCatalog implements ModelCatalog {
  private entriesCache: CatalogModelEntry[] | null = null;
  private entriesCacheVersion = -1;

  constructor(private readonly registry: ModelCatalogRegistry) {}

  private getEntries(): CatalogModelEntry[] {
    const models = this.registry.listModels();
    if (this.entriesCache !== null && models.length === this.entriesCacheVersion) {
      return this.entriesCache;
    }
    this.entriesCacheVersion = models.length;
    this.entriesCache = models.map((model): CatalogModelEntry => ({
      id: model.id,
      displayName: model.displayName,
      provider: model.provider,
      context: this.registry.getContextWindowForModel(model),
      tier: (model.tier ?? 'paid') as 'free' | 'paid' | 'subscription',
    }));
    return this.entriesCache;
  }

  getModel(modelId: string): CatalogModelEntry | null {
    return this.getEntries().find((entry) => entry.id === modelId) ?? null;
  }

  findLargerContextModels(
    minContext: number,
    tier?: 'free' | 'paid' | 'subscription',
    limit = 3,
  ): CatalogModelEntry[] {
    return this.getEntries()
      .filter((entry) => entry.context > minContext && (tier === undefined || entry.tier === tier))
      .sort((a, b) => b.context - a.context)
      .slice(0, limit);
  }
}

export function createModelCatalog(registry: ModelCatalogRegistry): ModelCatalog {
  return new RegistryBackedCatalog(registry);
}

export function getCatalogModelDefinitionsFrom(models: readonly CatalogModel[]): MinimalModelDefinition[] {
  return models.map((model): MinimalModelDefinition => {
    const isFree = model.tier === 'free';
    // Same principle as `reasoning` below, applied to image input: the
    // catalog's own per-model answer decides. This used to read
    // `isGoogle || isOpenAI`, which called every Anthropic model text-only
    // and every OpenAI embedding model multimodal — vendors ship both kinds.
    // `modalities.input` is populated for every entry in the live feed, so
    // the undefined branch is a malformed-entry fallback rather than a
    // routine path; a fallback that guessed by vendor would reintroduce the
    // bug, so an entry that says nothing is reported as saying nothing.
    const inputModalities = model.inputModalities;
    const isMultimodal = inputModalities !== undefined
      ? inputModalities.includes('image')
      : false;
    // The catalog's own per-model answer decides, rather than the vendor the
    // model happens to come from: OpenAI, Anthropic and Google all ship models
    // with `reasoning: false`, and offering those an effort picker was a lie.
    // A populated `reasoning_options` array also counts as proof, for entries
    // that carry the options but not the boolean.
    const catalogSpec = parseReasoningOptions(model.reasoningOptions);
    const hasReasoning = model.reasoning === true
      || (catalogSpec !== undefined && catalogSpec.kind !== 'unavailable');
    const reasoningEffort = hasReasoning
      ? resolveReasoningEffortSpec({
        modelId: model.id,
        ...(catalogSpec ? { spec: catalogSpec } : {}),
      })
      : undefined;
    const hasCatalogContextWindow = model.contextWindow != null && model.contextWindow > 0;
    return {
      id: model.id,
      provider: model.providerId,
      registryKey: `${model.providerId}:${model.id}`,
      displayName: model.name,
      description: `${model.name} — sourced from model catalog.`,
      capabilities: {
        toolCalling: true,
        codeEditing: true,
        reasoning: hasReasoning,
        multimodal: isMultimodal,
      },
      contextWindow: hasCatalogContextWindow
        ? model.contextWindow!
        : inferFallbackContextWindow(model.provider, model.id),
      ...(!hasCatalogContextWindow ? { contextWindowProvenance: 'fallback' as const } : {}),
      selectable: true,
      tier: model.tier === 'subscription' ? 'subscription' : isFree ? 'free' : (model.pricing?.input ?? 0) >= 3 ? 'premium' : 'standard',
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  });
}

/**
 * Build a `ModelCapabilityFactsSource` over the catalog, so the capability
 * registry reads each model's real context window, output cap and reasoning
 * support instead of a hand-maintained per-model table.
 *
 * Lookup prefers the `providerId:modelId` pair, because the same model id is
 * served by several providers at different limits (an OpenRouter mirror and
 * the first-party endpoint do not always agree). A bare-id match is the
 * fallback for callers that only have the id.
 *
 * A field the catalog does not carry is left undefined rather than defaulted,
 * so the registry falls through to its static tables instead of recording a
 * zero as though the provider had reported one.
 */
export function modelCapabilityFactsFromCatalog(
  models: readonly CatalogModel[],
): ModelCapabilityFactsSource {
  const byPair = new Map<string, ModelCapabilityFacts>();
  const byId = new Map<string, ModelCapabilityFacts>();

  for (const model of models) {
    const catalogSpec = parseReasoningOptions(model.reasoningOptions);
    const hasReasoning = model.reasoning === true
      || (catalogSpec !== undefined && catalogSpec.kind !== 'unavailable');
    const facts: ModelCapabilityFacts = {
      ...(model.contextWindow != null && model.contextWindow > 0
        ? { maxContextTokens: model.contextWindow }
        : {}),
      ...(model.maxOutputTokens != null && model.maxOutputTokens > 0
        ? { maxOutputTokens: model.maxOutputTokens }
        : {}),
      // Only a positive statement is made. `reasoning: false` in the feed is
      // an answer, so it is carried; an entry that says nothing at all leaves
      // the field undefined and the static tables decide.
      ...(model.reasoning !== undefined || catalogSpec !== undefined
        ? { reasoningControls: hasReasoning }
        : {}),
    };
    byPair.set(`${model.providerId}:${model.id}`, facts);
    // First provider to publish an id wins the bare-id slot; the pair lookup
    // above is the one that is actually correct when providers disagree.
    if (!byId.has(model.id)) byId.set(model.id, facts);
  }

  return (providerId: string, modelId: string): ModelCapabilityFacts | undefined =>
    byPair.get(`${providerId}:${modelId}`) ?? byId.get(modelId);
}

export type { MinimalModelDefinition, SyntheticModelInfo } from './model-catalog-synthetic.js';
export {
  fetchCatalog,
  getCatalogCachePath,
  getCatalogTmpPath,
  isCatalogCacheStale,
  loadCatalogCache,
  saveCatalogCache,
} from './model-catalog-cache.js';
export {
  buildSyntheticCanonicalModels,
  getSyntheticBackendModelIds,
  getSyntheticModelDefinitions,
  getSyntheticModelInfo,
  nameToSlug,
  normalizeModelName,
} from './model-catalog-synthetic.js';
export {
  diffCatalogs,
  filterRelevantChanges,
  formatChangeNotifications,
  notifyCatalogChanges,
} from './model-catalog-notifications.js';
