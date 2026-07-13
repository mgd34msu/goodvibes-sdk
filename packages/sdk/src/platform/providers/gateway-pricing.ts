/**
 * Gateway-served model pricing — providers whose own /models payload carries
 * machine-readable rates (beyond OpenRouter, which model-limits.ts already
 * fetches). Evidence per gateway (probed 2026-07-12):
 *
 *   - aihubmix  GET https://aihubmix.com/api/v1/models
 *     `pricing: { input, output, cache_read?, cache_write? }` — absolute USD
 *     per 1M tokens (claude-fable-5: input 11 / output 55 / cache_read 1.1 /
 *     cache_write 13.75).
 *   - vercel-ai-gateway  GET https://ai-gateway.vercel.sh/v1/models
 *     `pricing: { input, output, input_cache_read?, input_cache_write? }` —
 *     USD per single token as strings (OpenRouter-style). Tiered variants
 *     (`input_tiers` etc.) exist; the flat base rate is used.
 *
 * Each gateway gets its own 24h-TTL cache file. A failed refresh degrades to
 * the cached rates with their fetch date — never to zero. A model absent
 * from the payload resolves to null (unpriced), never $0.
 */

import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { TTL_24H_MS, isTtlCacheStale, validateTtlCacheEnvelope } from './json-ttl-cache.js';
import { instrumentedFetch, fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import type { ProviderServedPricing } from './model-pricing.js';

const FETCH_TIMEOUT_MS = 15_000;

interface GatewayPricingCache {
  version: 1;
  fetchedAt: number;
  ttlMs: number;
  /** Model id -> per-token USD rates. */
  models: Record<string, {
    prompt: number;
    completion: number;
    cacheRead?: number | undefined;
    cacheWrite?: number | undefined;
  }>;
}

type RateMap = GatewayPricingCache['models'];

interface GatewayAdapter {
  readonly url: string;
  /** Parse the raw /models JSON into per-token USD rates keyed by model id. */
  readonly parse: (json: unknown) => RateMap;
}

function finiteRate(value: unknown): number | undefined {
  const num = typeof value === 'string' ? parseFloat(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(num) && num >= 0 ? num : undefined;
}

function parseAihubmix(json: unknown): RateMap {
  const models: RateMap = {};
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return models;
  for (const entry of data) {
    const record = entry as { model_id?: unknown; pricing?: Record<string, unknown> | undefined };
    if (typeof record?.model_id !== 'string' || !record.pricing) continue;
    // Rates are USD per 1M tokens -> convert to per-token.
    const input = finiteRate(record.pricing['input']);
    const output = finiteRate(record.pricing['output']);
    if (input === undefined || output === undefined) continue;
    const cacheRead = finiteRate(record.pricing['cache_read']);
    const cacheWrite = finiteRate(record.pricing['cache_write']);
    models[record.model_id] = {
      prompt: input / 1_000_000,
      completion: output / 1_000_000,
      ...(cacheRead === undefined ? {} : { cacheRead: cacheRead / 1_000_000 }),
      ...(cacheWrite === undefined ? {} : { cacheWrite: cacheWrite / 1_000_000 }),
    };
  }
  return models;
}

function parseVercelAiGateway(json: unknown): RateMap {
  const models: RateMap = {};
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return models;
  for (const entry of data) {
    const record = entry as { id?: unknown; pricing?: Record<string, unknown> | undefined };
    if (typeof record?.id !== 'string' || !record.pricing) continue;
    // Rates are USD per single token (strings).
    const prompt = finiteRate(record.pricing['input']);
    const completion = finiteRate(record.pricing['output']);
    if (prompt === undefined || completion === undefined) continue;
    const cacheRead = finiteRate(record.pricing['input_cache_read']);
    const cacheWrite = finiteRate(record.pricing['input_cache_write']);
    models[record.id] = {
      prompt,
      completion,
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
    };
  }
  return models;
}

/**
 * Gateways with machine-readable pricing in their /models payload.
 * OpenRouter is deliberately absent: model-limits.ts already fetches and
 * caches its payload (pricing included) — one fetch, not two.
 */
const GATEWAY_ADAPTERS: Readonly<Record<string, GatewayAdapter>> = {
  aihubmix: { url: 'https://aihubmix.com/api/v1/models', parse: parseAihubmix },
  'vercel-ai-gateway': { url: 'https://ai-gateway.vercel.sh/v1/models', parse: parseVercelAiGateway },
};

export function gatewayPricingCachePath(cacheDir: string, providerId: string): string {
  return join(cacheDir, `gateway-pricing-${providerId}.json`);
}

export interface GatewayPricingServiceOptions {
  readonly cacheDir: string;
}

/**
 * Lazy, cache-first pricing lookups for gateways that publish rates. The
 * first lookup for a gateway loads its disk cache and, when the cache is
 * absent or stale, starts ONE background refresh; lookups keep serving the
 * cached rates (with their date) meanwhile. No cache and no completed
 * refresh -> null (honest unpriced), never $0.
 */
export class GatewayPricingService {
  private readonly caches = new Map<string, GatewayPricingCache | null>();
  private readonly refreshing = new Set<string>();

  constructor(private readonly options: GatewayPricingServiceOptions) {}

  /** True when this provider id has a pricing-bearing /models adapter. */
  static supports(providerId: string): boolean {
    return providerId in GATEWAY_ADAPTERS;
  }

  getPricing(providerId: string, modelId: string): ProviderServedPricing | null {
    const adapter = GATEWAY_ADAPTERS[providerId];
    if (!adapter) return null;
    const cache = this.ensureCache(providerId);
    if (!cache) return null;
    const rates = cache.models[modelId] ?? null;
    if (!rates) return null;
    return { ...rates, fetchedAt: cache.fetchedAt };
  }

  private ensureCache(providerId: string): GatewayPricingCache | null {
    if (!this.caches.has(providerId)) {
      this.caches.set(providerId, this.loadCache(providerId));
    }
    const cache = this.caches.get(providerId) ?? null;
    if (!cache || isTtlCacheStale(cache)) {
      this.startRefresh(providerId);
    }
    return cache;
  }

  private cachePath(providerId: string): string {
    return gatewayPricingCachePath(this.options.cacheDir, providerId);
  }

  private loadCache(providerId: string): GatewayPricingCache | null {
    try {
      const raw = readFileSync(this.cachePath(providerId), 'utf-8');
      const { cache, reason } = validateTtlCacheEnvelope<GatewayPricingCache>(JSON.parse(raw) as unknown, 'models', 'object');
      if (!cache) {
        logger.warn('[gateway-pricing] Ignoring malformed cache', { providerId, reason: reason ?? 'unknown' });
        return null;
      }
      return cache;
    } catch (error) {
      const message = summarizeError(error);
      if (!message.includes('ENOENT') && !message.includes('no such file')) {
        logger.warn('[gateway-pricing] Cache load failed', { providerId, error: message });
      }
      return null;
    }
  }

  private startRefresh(providerId: string): void {
    if (this.refreshing.has(providerId)) return;
    this.refreshing.add(providerId);
    void this.refresh(providerId)
      .catch((error) => {
        // Degrade to the cached rates (with their date) — never to zero.
        logger.warn('[gateway-pricing] Refresh failed; serving cached rates', {
          providerId,
          error: summarizeError(error),
        });
      })
      .finally(() => {
        this.refreshing.delete(providerId);
      });
  }

  async refresh(providerId: string): Promise<number> {
    const adapter = GATEWAY_ADAPTERS[providerId];
    if (!adapter) return 0;
    const response = await fetchWithTimeout(adapter.url, {
      headers: { Accept: 'application/json' },
    }, FETCH_TIMEOUT_MS, instrumentedFetch);
    if (!response.ok) {
      throw new Error(`${providerId} models endpoint returned ${response.status}`);
    }
    const models = adapter.parse(await response.json() as unknown);
    const cache: GatewayPricingCache = { version: 1, fetchedAt: Date.now(), ttlMs: TTL_24H_MS, models };
    try {
      mkdirSync(dirname(this.cachePath(providerId)), { recursive: true });
      writeFileSync(this.cachePath(providerId), JSON.stringify(cache, null, 2), 'utf-8');
    } catch (error) {
      logger.warn('[gateway-pricing] Cache write failed', { providerId, error: summarizeError(error) });
    }
    this.caches.set(providerId, cache);
    return Object.keys(models).length;
  }
}
