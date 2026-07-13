/**
 * Model pricing resolution — ONE resolver for every (provider, model) pair.
 *
 * Precedence (first hit wins):
 *   1. User-set manual price from config (`pricing.modelPrices`, keyed
 *      `provider:model`) — always wins when present. Negotiated or
 *      self-hosted rates outrank every catalog.
 *   2. Registration-supplied price on the model definition (custom
 *      provider/model files, runtime provider registration) — also
 *      user-origin: the person who registered the model stated the rate.
 *   3. The provider's own machine-readable pricing where its API serves one
 *      (OpenRouter's /v1/models today), stamped with the fetch date.
 *   4. The models.dev catalog entry for that exact provider+model, stamped
 *      with the fetch date.
 *   5. Honest UNKNOWN — a distinct state, never $0, never inferred-free.
 *
 * Subscription-tier surfaces resolve to `subscription` (no fake per-token
 * price). All rates are USD per 1,000,000 tokens.
 */

import type { CatalogModel } from './model-catalog.js';

/** User- or registration-supplied rates, USD per 1M tokens. */
export interface ManualModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number | undefined;
  readonly cacheWrite?: number | undefined;
}

/** Where a resolved price came from. */
export type ModelPricingSource = 'user' | 'provider' | 'catalog';

/** Resolved rates, USD per 1M tokens. Cache rates present only when the source carried them. */
export interface ModelPricingRates {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok?: number | undefined;
  readonly cacheWritePerMTok?: number | undefined;
}

/**
 * The resolved price for one (provider, model) pair. `unknown` is a distinct,
 * honest state: absent-from-catalog usage must never look free.
 */
export type ResolvedModelPricing =
  | {
    readonly status: 'priced';
    readonly source: ModelPricingSource;
    /** ISO date of the source snapshot (catalog/provider fetches); absent for user prices. */
    readonly asOf?: string | undefined;
    readonly rates: ModelPricingRates;
  }
  | { readonly status: 'subscription' }
  | { readonly status: 'unknown' };

export const UNKNOWN_MODEL_PRICING: ResolvedModelPricing = { status: 'unknown' };

/** Wire shape of an event-level pricing source stamp. */
export type UsageCostSource = ModelPricingSource | 'subscription' | 'unknown';

/**
 * Published per-provider cache ratios relative to the fresh input rate, used
 * only when the pricing source carried no explicit cache rates. Keyed by a
 * provider substring (matched case-insensitively). Default 1.0/1.0 — cache
 * tokens priced at the full input rate, the conservative honest choice.
 * Kept in sync with runtime/cost/attribution.ts CACHE_MULTIPLIERS (that module
 * cannot be imported here without inverting the providers -> runtime layering).
 */
const CACHE_RATE_MULTIPLIERS: Readonly<Record<string, { readonly read: number; readonly write: number }>> = {
  anthropic: { read: 0.1, write: 1.25 },
  openai: { read: 0.5, write: 1.0 },
  google: { read: 0.25, write: 1.0 },
  deepseek: { read: 0.1, write: 1.0 },
};

function cacheRateMultipliers(provider: string | undefined): { read: number; write: number } {
  if (provider) {
    const lower = provider.toLowerCase();
    for (const [needle, mult] of Object.entries(CACHE_RATE_MULTIPLIERS)) {
      if (lower.includes(needle)) return mult;
    }
  }
  return { read: 1.0, write: 1.0 };
}

export interface UsageTokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
}

/**
 * usage x resolved price -> USD. Null when the pricing is not `priced`
 * (unknown/subscription) — callers must carry the unpriced state forward,
 * never coerce to $0. Cache tokens use the source's explicit cache rates when
 * present, else the published per-provider ratio over the input rate.
 */
export function computeUsageCostUsd(
  pricing: ResolvedModelPricing,
  usage: UsageTokenCounts,
  provider?: string | undefined,
): number | null {
  if (pricing.status !== 'priced') return null;
  const rates = pricing.rates;
  const mult = cacheRateMultipliers(provider);
  const cacheReadRate = rates.cacheReadPerMTok ?? rates.inputPerMTok * mult.read;
  const cacheWriteRate = rates.cacheWritePerMTok ?? rates.inputPerMTok * mult.write;
  return (
    usage.inputTokens * rates.inputPerMTok +
    usage.outputTokens * rates.outputPerMTok +
    (usage.cacheReadTokens ?? 0) * cacheReadRate +
    (usage.cacheWriteTokens ?? 0) * cacheWriteRate
  ) / 1_000_000;
}

/** As computeUsageCostUsd, in cents (the wire unit on LLM_RESPONSE_RECEIVED). */
export function computeUsageCostUsdCents(
  pricing: ResolvedModelPricing,
  usage: UsageTokenCounts,
  provider?: string | undefined,
): number | null {
  const usd = computeUsageCostUsd(pricing, usage, provider);
  return usd === null ? null : usd * 100;
}

/** The event-level source stamp for a resolution. */
export function usageCostSource(pricing: ResolvedModelPricing): UsageCostSource {
  return pricing.status === 'priced' ? pricing.source : pricing.status;
}

function validManualPrice(value: unknown): value is ManualModelPrice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  const rate = (key: string, required: boolean): boolean => {
    const v = rec[key];
    if (v === undefined) return !required;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0;
  };
  return rate('input', true) && rate('output', true) && rate('cacheRead', false) && rate('cacheWrite', false);
}

/** Validate the whole `pricing.modelPrices` config value (record keyed `provider:model`). */
export function validateManualModelPrices(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, price]) => key.includes(':') && validManualPrice(price),
  );
}

function pricedFromManual(price: ManualModelPrice, source: 'user'): ResolvedModelPricing {
  return {
    status: 'priced',
    source,
    rates: {
      inputPerMTok: price.input,
      outputPerMTok: price.output,
      cacheReadPerMTok: price.cacheRead,
      cacheWritePerMTok: price.cacheWrite,
    },
  };
}

function isoDate(epochMs: number | undefined): string | undefined {
  if (epochMs === undefined || !Number.isFinite(epochMs) || epochMs <= 0) return undefined;
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** Provider-served machine-readable pricing (USD per single token, OpenRouter shape). */
export interface ProviderServedPricing {
  readonly prompt: number;
  readonly completion: number;
  readonly cacheRead?: number | undefined;
  readonly cacheWrite?: number | undefined;
  /** Epoch ms of the fetch that produced this price. */
  readonly fetchedAt?: number | undefined;
}

/** Everything the resolver reads. All lookups are live — no snapshot is taken. */
export interface ModelPricingDeps {
  /** Manual prices from config, keyed `provider:model`. Read per call so config edits apply live. */
  readonly getManualPrices: () => Readonly<Record<string, ManualModelPrice>> | undefined;
  /** Registration-supplied pricing on the model definition, when the definition exists. */
  readonly getRegisteredPrice: (providerId: string | undefined, modelId: string) => ManualModelPrice | null;
  /** The provider's own machine-readable pricing, when its API serves one. */
  readonly getProviderServedPricing: (providerId: string, modelId: string) => ProviderServedPricing | null;
  /** The models.dev catalog snapshot. */
  readonly getCatalog: () => { readonly fetchedAt: number; readonly models: readonly CatalogModel[] } | null;
  /** True when an SDK provider id and a catalog provider id name the same provider (alias-aware, e.g. gemini/google). */
  readonly providerMatchesCatalogId: (providerId: string, catalogProviderId: string) => boolean;
  /** True when this provider id names a registered provider (used to parse `provider:model` refs). */
  readonly isKnownProviderId: (providerId: string) => boolean;
}

function manualPriceFor(
  deps: ModelPricingDeps,
  providerId: string | undefined,
  modelId: string,
): ManualModelPrice | null {
  const prices = deps.getManualPrices();
  if (!prices) return null;
  if (providerId) {
    const exact = prices[`${providerId}:${modelId}`];
    return exact && validManualPrice(exact) ? exact : null;
  }
  const suffix = `:${modelId}`;
  const matches = Object.entries(prices).filter(([key, price]) => key.endsWith(suffix) && validManualPrice(price));
  return matches.length === 1 ? matches[0]![1] : null;
}

function catalogEntriesFor(
  deps: ModelPricingDeps,
  providerId: string | undefined,
  modelId: string,
): CatalogModel[] {
  const catalog = deps.getCatalog();
  if (!catalog) return [];
  const byId = catalog.models.filter((model) => model.id === modelId);
  if (!providerId) return byId;
  return byId.filter((model) => deps.providerMatchesCatalogId(providerId, model.providerId));
}

function resolveFromCatalog(
  deps: ModelPricingDeps,
  providerId: string | undefined,
  modelId: string,
): ResolvedModelPricing {
  const entries = catalogEntriesFor(deps, providerId, modelId);
  if (entries.length === 0) return UNKNOWN_MODEL_PRICING;
  if (entries.some((entry) => entry.tier === 'subscription')) return { status: 'subscription' };
  const priced = entries.filter((entry) => entry.pricing !== null);
  if (priced.length === 0) return UNKNOWN_MODEL_PRICING;
  const first = priced[0]!.pricing!;
  const agree = priced.every((entry) =>
    entry.pricing!.input === first.input &&
    entry.pricing!.output === first.output);
  // Without a provider, conflicting per-provider entries are honestly unknown —
  // picking one silently would price usage against the wrong provider's rate.
  if (!agree) return UNKNOWN_MODEL_PRICING;
  return {
    status: 'priced',
    source: 'catalog',
    asOf: isoDate(deps.getCatalog()?.fetchedAt),
    rates: {
      inputPerMTok: first.input,
      outputPerMTok: first.output,
      cacheReadPerMTok: first.cacheRead,
      cacheWritePerMTok: first.cacheWrite,
    },
  };
}

/**
 * Resolve the price for a model reference. `modelRef` may be a bare model id
 * (provider taken from `providerId` when given) or a `provider:model`
 * registry key (its provider segment wins when it names a known provider).
 */
export function resolveModelPricing(
  deps: ModelPricingDeps,
  modelRef: string,
  providerId?: string | undefined,
): ResolvedModelPricing {
  let provider = providerId;
  let modelId = modelRef;
  const colon = modelRef.indexOf(':');
  if (colon > 0) {
    const prefix = modelRef.slice(0, colon);
    // OpenRouter-style ids carry ':free'/':extended' suffixes — only treat the
    // prefix as a provider when it actually names one.
    if (deps.isKnownProviderId(prefix)) {
      provider = prefix;
      modelId = modelRef.slice(colon + 1);
    }
  }

  const manual = manualPriceFor(deps, provider, modelId);
  if (manual) return pricedFromManual(manual, 'user');

  const registered = deps.getRegisteredPrice(provider, modelId);
  if (registered) return pricedFromManual(registered, 'user');

  if (provider) {
    const served = deps.getProviderServedPricing(provider, modelId);
    if (served) {
      return {
        status: 'priced',
        source: 'provider',
        asOf: isoDate(served.fetchedAt),
        rates: {
          inputPerMTok: served.prompt * 1_000_000,
          outputPerMTok: served.completion * 1_000_000,
          cacheReadPerMTok: served.cacheRead === undefined ? undefined : served.cacheRead * 1_000_000,
          cacheWritePerMTok: served.cacheWrite === undefined ? undefined : served.cacheWrite * 1_000_000,
        },
      };
    }
  }

  return resolveFromCatalog(deps, provider, modelId);
}

/** Narrow accessors a registry hands the resolver — keeps the registry glue tiny. */
export interface RegistryModelPricingInput {
  readonly getManualPrices: ModelPricingDeps['getManualPrices'];
  readonly findModelPricing: (providerId: string | undefined, modelId: string) => ManualModelPrice | null;
  readonly openRouterPricing: (modelId: string) => ProviderServedPricing | null;
  readonly gatewayPricing: (providerId: string, modelId: string) => ProviderServedPricing | null;
  readonly getCatalog: ModelPricingDeps['getCatalog'];
  readonly providerAliases: Readonly<Record<string, string>>;
  readonly isKnownProviderId: (providerId: string) => boolean;
}

/** Assemble ModelPricingDeps from registry accessors (alias-aware provider matching included). */
export function buildRegistryModelPricingDeps(input: RegistryModelPricingInput): ModelPricingDeps {
  return {
    getManualPrices: input.getManualPrices,
    getRegisteredPrice: input.findModelPricing,
    getProviderServedPricing: (provider, modelId) =>
      provider === 'openrouter' ? input.openRouterPricing(modelId) : input.gatewayPricing(provider, modelId),
    getCatalog: input.getCatalog,
    providerMatchesCatalogId: (provider, catalogId) => provider === catalogId
      || input.providerAliases[catalogId] === provider
      || input.providerAliases[provider] === catalogId
      || (provider === 'gemini' && catalogId === 'google'),
    isKnownProviderId: input.isKnownProviderId,
  };
}
