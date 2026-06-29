import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import type { CatalogModel } from './model-catalog.js';
import { summarizeError } from '../utils/error-display.js';
import { TTL_24H_MS, isTtlCacheStale, validateTtlCacheEnvelope } from './json-ttl-cache.js';
import { instrumentedFetch, fetchWithTimeout } from '../utils/fetch-with-timeout.js';

interface CatalogModelPricing {
  input: number;
  output: number;
}

interface CatalogProviderShape {
  id: string;
  name: string;
  env?: string[] | undefined;
  api?: string | undefined;
  models?: Record<string, ModelsDevModel> | undefined;
}

interface CatalogCacheFile {
  version: 1;
  fetchedAt: number;
  ttlMs: number;
  models: CatalogModel[];
}

interface ModelsDevModelCost {
  input?: number | undefined;
  output?: number | undefined;
}

interface ModelsDevModelLimit {
  context?: number | undefined;
  output?: number | undefined;
}

interface ModelsDevModel {
  id?: string | undefined;
  name?: string | undefined;
  family?: string | undefined;
  cost?: ModelsDevModelCost | undefined;
  limit?: ModelsDevModelLimit | undefined;
  reasoning?: boolean | undefined;
  tool_call?: boolean | undefined;
  structured_output?: boolean | undefined;
  open_weights?: boolean | undefined;
}

type ModelsDevResponse = Record<string, CatalogProviderShape>;

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CATALOG_FETCH_TIMEOUT_MS = 30_000;

export function getCatalogCachePath(cacheDir: string): string {
  return join(cacheDir, 'model-catalog.json');
}

export function getCatalogTmpPath(cacheDir: string): string {
  return `${getCatalogCachePath(cacheDir)}.tmp`;
}

function categorizeProvider(providerId: string): 'subscription' | 'shutdown' | 'normal' {
  const subscriptionProviders = new Set([
    'github-copilot',
    'github-models',
    'v0',
    'vercel',
    'gitlab',
    'kimi-for-coding',
    'llama',
    'lmstudio',
  ]);
  const shutdownProviders = new Set(['iflow', 'iflowcn']);
  if (providerId.includes('coding-plan')) return 'subscription';
  if (subscriptionProviders.has(providerId)) return 'subscription';
  if (shutdownProviders.has(providerId)) return 'shutdown';
  return 'normal';
}

function isFreeModel(
  modelId: string,
  cost: ModelsDevModelCost | undefined,
  providerCategory: 'subscription' | 'shutdown' | 'normal',
): boolean {
  if (providerCategory === 'subscription') return false;
  if (modelId.includes('coding-plan')) return false;
  return (cost?.input ?? -1) === 0 && (cost?.output ?? -1) === 0;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function transformModelsDevResponse(json: ModelsDevResponse): CatalogModel[] {
  const models: CatalogModel[] = [];
  let skippedProviders = 0;
  let skippedProviderModelLists = 0;
  let skippedModels = 0;

  for (const [providerId, providerData] of Object.entries(json)) {
    if (!providerData || typeof providerData !== 'object' || Array.isArray(providerData)) {
      skippedProviders++;
      continue;
    }

    const providerCategory = categorizeProvider(providerId);
    if (providerCategory === 'shutdown') continue;

    const providerName = typeof providerData.name === 'string' && providerData.name.trim()
      ? providerData.name
      : providerId;
    const providerModels = providerData.models;
    if (!providerModels || typeof providerModels !== 'object' || Array.isArray(providerModels)) {
      skippedProviderModelLists++;
      continue;
    }

    for (const [modelKey, modelData] of Object.entries(providerModels)) {
      if (!modelData || typeof modelData !== 'object' || Array.isArray(modelData)) {
        skippedModels++;
        continue;
      }

      const modelId = typeof modelData.id === 'string' && modelData.id.trim() ? modelData.id : modelKey;
      const modelName = typeof modelData.name === 'string' && modelData.name.trim() ? modelData.name : modelId;
      const modelFamily = typeof modelData.family === 'string' ? modelData.family : undefined;
      const cost = modelData.cost;
      const limit = modelData.limit;
      const supportsReasoning = modelData.reasoning === true;

      const inputCost = typeof cost?.input === 'number' ? cost.input : 0;
      const outputCost = typeof cost?.output === 'number' ? cost.output : 0;
      const contextWindow = typeof limit?.context === 'number' && limit.context > 0 ? limit.context : undefined;

      let tier: 'free' | 'paid' | 'subscription';
      if (providerCategory === 'subscription') {
        tier = 'subscription';
      } else if (isFreeModel(modelId, cost, providerCategory)) {
        tier = 'free';
      } else {
        tier = 'paid';
      }

      const maxOutputTokens = typeof limit?.output === 'number' ? limit.output : undefined;

      models.push({
        id: modelId,
        name: modelName,
        ...(modelFamily ? { family: modelFamily } : {}),
        provider: providerName,
        providerId,
        providerEnvVars: getStringArray(providerData.env),
        pricing: { input: inputCost, output: outputCost },
        tier,
        contextWindow,
        maxOutputTokens,
        ...(supportsReasoning ? { reasoning: true } : {}),
      });
    }
  }

  if (skippedProviders > 0 || skippedProviderModelLists > 0 || skippedModels > 0) {
    logger.warn('[model-catalog] Ignored malformed catalog entries', {
      skippedProviders,
      skippedProviderModelLists,
      skippedModels,
    });
  }

  return models;
}

function validateCatalogCache(value: unknown): { cache: CatalogCacheFile | null; reason?: string } {
  return validateTtlCacheEnvelope<CatalogCacheFile>(value, 'models', 'array');
}

function loadCatalogCache(cachePath: string): CatalogCacheFile | null {
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const { cache, reason } = validateCatalogCache(parsed);
    if (!cache) {
      logger.warn('[model-catalog] Ignoring malformed cache', { cachePath, reason: reason ?? 'unknown' });
      return null;
    }
    return cache;
  } catch (err) {
    const msg = summarizeError(err);
    if (msg.includes('ENOENT') || msg.includes('no such file')) {
      logger.debug('[model-catalog] No cache file (first run)');
    } else {
      logger.warn('[model-catalog] Cache load failed', { error: msg });
    }
    return null;
  }
}

function saveCatalogCache(models: CatalogModel[], cachePath: string, tmpPath: string): void {
  try {
    fs.mkdirSync(dirname(cachePath), { recursive: true });
    const payload: CatalogCacheFile = {
      version: 1,
      fetchedAt: Date.now(),
      ttlMs: TTL_24H_MS,
      models,
    };
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmpPath, cachePath);
  } catch (err) {
    logger.warn('[model-catalog] Cache write failed', { error: summarizeError(err) });
  }
}

function isCatalogCacheStale(cache: CatalogCacheFile): boolean {
  return isTtlCacheStale(cache);
}

/**
 * Fetch models.dev/api.json and parse into CatalogModel[].
 * Uses a 30-second timeout.
 */
export async function fetchCatalog(): Promise<CatalogModel[]> {
  const response = await fetchWithTimeout(MODELS_DEV_URL, {
    headers: { Accept: 'application/json' },
  }, CATALOG_FETCH_TIMEOUT_MS, instrumentedFetch);

  if (!response.ok) {
    throw new Error(`models.dev API returned ${response.status} ${response.statusText}`);
  }

  const json = await response.json() as ModelsDevResponse;
  const models = transformModelsDevResponse(json);
  logger.debug('[model-catalog] Fetched models from models.dev', { count: models.length });
  return models;
}

export {
  loadCatalogCache,
  saveCatalogCache,
  isCatalogCacheStale,
};
