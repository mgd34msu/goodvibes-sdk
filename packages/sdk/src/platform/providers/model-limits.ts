import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ModelDefinition, TokenLimits } from './registry.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { TTL_24H_MS, isTtlCacheStale, validateTtlCacheEnvelope } from './json-ttl-cache.js';
import { instrumentedFetch, fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { inferFallbackContextWindow } from './context-window-fallback.js';

interface OpenRouterModelData {
  id: string;
  context_length: number;
  top_provider: {
    max_completion_tokens: number | null;
  };
  supported_parameters?: string[] | undefined;
  pricing?: {
    prompt: string;
    completion: string;
    input_cache_read?: string | undefined;
    input_cache_write?: string | undefined;
  } | undefined;
}

interface OpenRouterResponse {
  data: OpenRouterModelData[];
}

interface ModelLimitsCache {
  version: 1;
  fetchedAt: number;
  ttlMs: number;
  models: Record<string, {
    contextLength: number;
    maxOutputTokens: number | null;
    supportedParameters: string[];
    pricing?: { prompt: number; completion: number; cacheRead?: number | undefined; cacheWrite?: number | undefined } | undefined;
  }>;
}

/** Per-token USD rates served by the provider's own /models payload. */
export interface ProviderModelPricing {
  prompt: number;
  completion: number;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
}

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const FETCH_TIMEOUT_MS = 15_000;

const DEFAULT_TOKEN_LIMITS: Required<TokenLimits> = {
  maxOutputTokens: 8192,
  maxToolResultTokens: 50_000,
  maxToolCalls: 128,
  maxReasoningTokens: 16384,
};

export interface ModelLimitsServiceOptions {
  readonly cachePath: string;
}

export function getModelLimitsCachePath(cacheDir: string): string {
  return join(cacheDir, 'model-limits.json');
}

function validateModelLimitsCache(value: unknown): { cache: ModelLimitsCache | null; reason?: string } {
  return validateTtlCacheEnvelope<ModelLimitsCache>(value, 'models', 'object');
}

function loadCachedLimits(cachePath: string): ModelLimitsCache | null {
  try {
    const raw = readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const { cache, reason } = validateModelLimitsCache(parsed);
    if (!cache) {
      logger.warn('[model-limits] Ignoring malformed cache', { cachePath, reason: reason ?? 'unknown' });
      return null;
    }
    return cache;
  } catch (error) {
    const message = summarizeError(error);
    if (message.includes('ENOENT') || message.includes('no such file')) {
      logger.debug('[model-limits] No cache file found (first run)');
    } else {
      logger.warn('[model-limits] Cache load failed (corrupted?)', { error: message });
    }
    return null;
  }
}

function saveCachedLimits(cache: ModelLimitsCache, cachePath: string): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (error) {
    logger.warn('[model-limits] Cache write failed', { error: summarizeError(error) });
  }
}

function isCacheStale(cache: ModelLimitsCache): boolean {
  return isTtlCacheStale(cache);
}

async function fetchOpenRouterModels(): Promise<Map<string, OpenRouterModelData>> {
  const response = await fetchWithTimeout(OPENROUTER_MODELS_URL, {
    headers: { Accept: 'application/json' },
  }, FETCH_TIMEOUT_MS, instrumentedFetch);
  if (!response.ok) {
    throw new Error(`OpenRouter API returned ${response.status}`);
  }

  const json = await response.json() as OpenRouterResponse;
  const map = new Map<string, OpenRouterModelData>();
  if (Array.isArray(json.data)) {
    for (const model of json.data) {
      if (typeof model.id === 'string') {
        map.set(model.id, model);
      }
    }
  }
  return map;
}

function getModelStem(modelId: string): string {
  return modelId
    .replace(/-\d{8}$/, '')
    .replace(/-(?:2[4-9]|3[0-9])\d{2}$/, '')
    .replace(/-\d{6}$/, '');
}

function findOpenRouterMatch(
  modelId: string,
  provider: string,
  orModels: Map<string, OpenRouterModelData>,
): OpenRouterModelData | null {
  if (orModels.has(modelId)) return orModels.get(modelId) ?? null;

  const prefixed = `${provider}/${modelId}`;
  if (orModels.has(prefixed)) return orModels.get(prefixed) ?? null;

  const stem = getModelStem(modelId);
  if (stem !== modelId) {
    if (orModels.has(stem)) return orModels.get(stem) ?? null;
    const prefixedStem = `${provider}/${stem}`;
    if (orModels.has(prefixedStem)) return orModels.get(prefixedStem) ?? null;
  }

  for (const [orId, orModel] of orModels) {
    if (orId.endsWith(`/${stem}`) || orId.endsWith(`/${modelId}`)) {
      return orModel;
    }
  }

  return null;
}

function buildOrMap(cache: ModelLimitsCache): Map<string, OpenRouterModelData> {
  const map = new Map<string, OpenRouterModelData>();
  for (const [id, entry] of Object.entries(cache.models)) {
    map.set(id, {
      id,
      context_length: entry.contextLength,
      top_provider: { max_completion_tokens: entry.maxOutputTokens },
      supported_parameters: entry.supportedParameters,
      pricing: entry.pricing
        ? {
          prompt: String(entry.pricing.prompt),
          completion: String(entry.pricing.completion),
          input_cache_read: entry.pricing.cacheRead === undefined ? undefined : String(entry.pricing.cacheRead),
          input_cache_write: entry.pricing.cacheWrite === undefined ? undefined : String(entry.pricing.cacheWrite),
        }
        : undefined,
    });
  }
  return map;
}

export class ModelLimitsService {
  private cachedData: ModelLimitsCache | null = null;
  private cachedOrMap: Map<string, OpenRouterModelData> | null = null;

  constructor(private readonly options: ModelLimitsServiceOptions) {}

  private ensureOpenRouterMap(): Map<string, OpenRouterModelData> | null {
    if (!this.cachedData) return null;
    if (!this.cachedOrMap) {
      this.cachedOrMap = buildOrMap(this.cachedData);
    }
    return this.cachedOrMap;
  }

  private resolveTokenLimits(
    modelDef: ModelDefinition,
    providerLimits?: Partial<TokenLimits>,
  ): Required<TokenLimits> {
    const result: Required<TokenLimits> = { ...DEFAULT_TOKEN_LIMITS };
    const orMap = this.ensureOpenRouterMap();
    if (orMap) {
      const orMatch = findOpenRouterMatch(modelDef.id, modelDef.provider, orMap);
      if (orMatch?.top_provider?.max_completion_tokens != null) {
        result.maxOutputTokens = orMatch.top_provider.max_completion_tokens;
      }
    }
    if (providerLimits) {
      if (providerLimits.maxOutputTokens != null) result.maxOutputTokens = providerLimits.maxOutputTokens;
      if (providerLimits.maxToolResultTokens != null) result.maxToolResultTokens = providerLimits.maxToolResultTokens;
      if (providerLimits.maxToolCalls != null) result.maxToolCalls = providerLimits.maxToolCalls;
      if (providerLimits.maxReasoningTokens != null) result.maxReasoningTokens = providerLimits.maxReasoningTokens;
    }
    const explicit = modelDef.tokenLimits;
    if (explicit) {
      if (explicit.maxOutputTokens != null) result.maxOutputTokens = explicit.maxOutputTokens;
      if (explicit.maxToolResultTokens != null) result.maxToolResultTokens = explicit.maxToolResultTokens;
      if (explicit.maxToolCalls != null) result.maxToolCalls = explicit.maxToolCalls;
      if (explicit.maxReasoningTokens != null) result.maxReasoningTokens = explicit.maxReasoningTokens;
    }
    return result;
  }

  getPricingForModel(modelId: string, provider: string): ProviderModelPricing | null {
    const orMap = this.ensureOpenRouterMap();
    if (!orMap) return null;
    const match = findOpenRouterMatch(modelId, provider, orMap);
    if (!match?.pricing) return null;
    const prompt = parseFloat(match.pricing.prompt);
    const completion = parseFloat(match.pricing.completion);
    if (Number.isNaN(prompt) || Number.isNaN(completion)) return null;
    const cacheRead = match.pricing.input_cache_read === undefined ? Number.NaN : parseFloat(match.pricing.input_cache_read);
    const cacheWrite = match.pricing.input_cache_write === undefined ? Number.NaN : parseFloat(match.pricing.input_cache_write);
    return {
      prompt,
      completion,
      ...(Number.isNaN(cacheRead) ? {} : { cacheRead }),
      ...(Number.isNaN(cacheWrite) ? {} : { cacheWrite }),
    };
  }

  /** Epoch ms of the fetch behind the current pricing/limits cache, or null when no cache is loaded. */
  getPricingFetchedAt(): number | null {
    return this.cachedData?.fetchedAt ?? null;
  }

  getTokenLimitsForModel(modelDef: ModelDefinition): Required<TokenLimits> {
    return this.resolveTokenLimits(modelDef);
  }

  getContextWindowForModel(modelDef: ModelDefinition): number {
    // An explicit user-configured cap (configured_cap) is authoritative and must
    // never be widened — or narrowed — by a fuzzy OpenRouter match. provider_api
    // values are likewise trusted, as are learned provider limits
    // (observed_limit — the provider itself rejected anything larger). All
    // short-circuit ahead of the OpenRouter lookup.
    if (
      (modelDef.contextWindowProvenance === 'provider_api' ||
        modelDef.contextWindowProvenance === 'configured_cap' ||
        modelDef.contextWindowProvenance === 'observed_limit') &&
      modelDef.contextWindow > 0
    ) {
      return modelDef.contextWindow;
    }
    const orMap = this.ensureOpenRouterMap();
    if (orMap) {
      const orMatch = findOpenRouterMatch(modelDef.id, modelDef.provider, orMap);
      if (orMatch?.context_length != null && orMatch.context_length > 0) {
        return orMatch.context_length;
      }
    }
    // Never emit 0/NaN: a non-positive or non-finite window would poison
    // downstream budget math (used / contextWindow -> Infinity/NaN). Fall back to
    // the family-aware floor instead.
    const cw = modelDef.contextWindow;
    return Number.isFinite(cw) && cw > 0
      ? cw
      : inferFallbackContextWindow(modelDef.provider, modelDef.id);
  }

  getToolResultMaxCharsForModel(model: ModelDefinition | null | undefined): number {
    if (!model) return DEFAULT_TOKEN_LIMITS.maxToolResultTokens!;
    return this.resolveTokenLimits(model).maxToolResultTokens!;
  }

  async refresh(): Promise<number> {
    const orModels = await fetchOpenRouterModels();
    const models: ModelLimitsCache['models'] = {};
    for (const [id, model] of orModels) {
      let pricing: ModelLimitsCache['models'][string]['pricing'];
      if (model.pricing?.prompt != null && model.pricing?.completion != null) {
        const prompt = parseFloat(model.pricing.prompt);
        const completion = parseFloat(model.pricing.completion);
        if (!Number.isNaN(prompt) && !Number.isNaN(completion)) {
          const cacheRead = model.pricing.input_cache_read === undefined ? Number.NaN : parseFloat(model.pricing.input_cache_read);
          const cacheWrite = model.pricing.input_cache_write === undefined ? Number.NaN : parseFloat(model.pricing.input_cache_write);
          pricing = {
            prompt,
            completion,
            ...(Number.isNaN(cacheRead) ? {} : { cacheRead }),
            ...(Number.isNaN(cacheWrite) ? {} : { cacheWrite }),
          };
        }
      }
      models[id] = {
        contextLength: model.context_length ?? 0,
        maxOutputTokens: model.top_provider?.max_completion_tokens ?? null,
        supportedParameters: model.supported_parameters ?? [],
        pricing,
      };
    }

    const newCache: ModelLimitsCache = {
      version: 1,
      fetchedAt: Date.now(),
      ttlMs: TTL_24H_MS,
      models,
    };

    saveCachedLimits(newCache, this.options.cachePath);
    this.cachedData = newCache;
    this.cachedOrMap = buildOrMap(newCache);
    return orModels.size;
  }

  init(): void {
    this.cachedData = loadCachedLimits(this.options.cachePath);
    this.cachedOrMap = this.cachedData ? buildOrMap(this.cachedData) : null;
    if (!this.cachedData || isCacheStale(this.cachedData)) {
      void this.refresh().catch((error) => {
        logger.warn('[model-limits] Background refresh failed', { error: summarizeError(error) });
      });
    }
  }
}
