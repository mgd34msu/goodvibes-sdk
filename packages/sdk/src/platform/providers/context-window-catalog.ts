/**
 * Context windows for remote models whose own source never stated one.
 *
 * Older `/provider add` runs wrote `contextWindow: 8192` for every model of
 * an https endpoint it could not measure, and a provider file may leave the
 * field out entirely. Neither is a real figure. For a model that is not local
 * (a local server measures its own window and keeps it), the window is looked
 * up in the models.dev catalog instead, in this order:
 *
 *  1. the exact model id under the provider's own catalog provider id
 *     (`abacusai` maps to the catalog's `abacus`);
 *  2. otherwise the consensus across every catalog provider that lists the
 *     same model id, ignoring vendor prefixes (`anthropic/claude-sonnet-5`
 *     matches `claude-sonnet-5`): the value most providers share, a tie going
 *     to the smaller value, since over-stating a window risks overflow errors;
 *  3. only when no provider lists the model, the family default from
 *     context-window-fallback.ts, which stays a guess (provenance 'fallback').
 *
 * A user override, a learned rejection limit and an accepted-request floor
 * are applied after this step by ContextWindowOverrideStore, so they keep
 * their precedence over the catalog figure.
 */
import { inferFallbackContextWindow } from './context-window-fallback.js';
import type { CatalogModel } from './model-catalog.js';
import type { ContextWindowOrigin, ModelDefinition } from './registry-types.js';

/** The window the old `/provider add` wrote for every unmeasured remote model. */
export const LEGACY_GUESSED_CONTEXT_WINDOW = 8_192;

/** One catalog provider's figure for a model. */
interface CatalogListing {
  readonly providerId: string;
  readonly tokens: number;
}

/** Lookup tables over one catalog snapshot. Build once per snapshot. */
export interface CatalogContextWindowIndex {
  /** catalog providerId -> exact model id -> window. */
  readonly byProvider: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** normalized model id -> one listing per catalog provider. */
  readonly byNormalizedId: ReadonlyMap<string, readonly CatalogListing[]>;
  /** squashed provider id (lowercase, alphanumerics only) -> catalog providerId. */
  readonly providerIdsBySquashed: ReadonlyMap<string, string>;
}

/** A resolved window and where it came from. */
export interface CatalogContextWindowResolution {
  readonly tokens: number;
  readonly provenance: 'catalog' | 'fallback';
  readonly origin: ContextWindowOrigin;
}

/**
 * The catalog form of a model id: lowercase, without a vendor prefix
 * (`Anthropic/Claude-Sonnet-5` -> `claude-sonnet-5`).
 */
export function normalizeCatalogModelId(modelId: string): string {
  const lower = modelId.trim().toLowerCase();
  const slash = lower.lastIndexOf('/');
  return slash >= 0 ? lower.slice(slash + 1) : lower;
}

function squashProviderId(providerId: string): string {
  return providerId.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** `abacusai` -> `abacus`, `togetherai` -> `together`; short ids such as `xai` stay whole. */
function withoutAiSuffix(squashed: string): string {
  return squashed.length > 4 && squashed.endsWith('ai') ? squashed.slice(0, -2) : squashed;
}

/** Build the lookup tables for one catalog snapshot. Entries without a positive window are skipped. */
export function buildCatalogContextWindowIndex(models: readonly CatalogModel[]): CatalogContextWindowIndex {
  const byProvider = new Map<string, Map<string, number>>();
  const perNormalized = new Map<string, Map<string, { tokens: number; exact: boolean }>>();
  const providerIdsBySquashed = new Map<string, string>();
  for (const model of models) {
    const providerId = model.providerId;
    if (!providerId) continue;
    const squashed = squashProviderId(providerId);
    if (!providerIdsBySquashed.has(squashed)) providerIdsBySquashed.set(squashed, providerId);
    const tokens = model.contextWindow;
    if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) continue;
    let ids = byProvider.get(providerId);
    if (!ids) {
      ids = new Map();
      byProvider.set(providerId, ids);
    }
    if (!ids.has(model.id)) ids.set(model.id, tokens);

    // One figure per provider for each normalized id. A provider listing the
    // bare id is preferred over its prefixed variants; between variants the
    // smaller figure is kept.
    const normalized = normalizeCatalogModelId(model.id);
    const exact = model.id.toLowerCase() === normalized;
    let providers = perNormalized.get(normalized);
    if (!providers) {
      providers = new Map();
      perNormalized.set(normalized, providers);
    }
    const existing = providers.get(providerId);
    if (
      !existing ||
      (exact && !existing.exact) ||
      (exact === existing.exact && tokens < existing.tokens)
    ) {
      providers.set(providerId, { tokens, exact });
    }
  }
  const byNormalizedId = new Map<string, CatalogListing[]>();
  for (const [normalized, providers] of perNormalized) {
    byNormalizedId.set(
      normalized,
      [...providers.entries()].map(([providerId, { tokens }]) => ({ providerId, tokens })),
    );
  }
  return { byProvider, byNormalizedId, providerIdsBySquashed };
}

/**
 * The catalog's provider id for a registered provider id: the same id, a
 * known alias, or the same name once case, punctuation and a trailing `ai`
 * are ignored (`abacusai` -> `abacus`). Null when the catalog has no match.
 */
export function matchCatalogProviderId(
  providerId: string,
  index: CatalogContextWindowIndex,
  aliases: Readonly<Record<string, string>> = {},
): string | null {
  if (index.byProvider.has(providerId)) return providerId;
  const alias = aliases[providerId];
  if (alias && index.byProvider.has(alias)) return alias;
  const squashed = squashProviderId(providerId);
  const direct = index.providerIdsBySquashed.get(squashed);
  if (direct) return direct;
  const base = withoutAiSuffix(squashed);
  for (const [candidateSquashed, candidate] of index.providerIdsBySquashed) {
    if (withoutAiSuffix(candidateSquashed) === base) return candidate;
  }
  return null;
}

/**
 * The value most listings share; a tie goes to the smaller value. Null for
 * no listings.
 */
function consensusOf(listings: readonly CatalogListing[]): { tokens: number; agreeing: number } | null {
  const counts = new Map<number, number>();
  for (const { tokens } of listings) counts.set(tokens, (counts.get(tokens) ?? 0) + 1);
  let best: { tokens: number; agreeing: number } | null = null;
  for (const [tokens, agreeing] of counts) {
    if (!best || agreeing > best.agreeing || (agreeing === best.agreeing && tokens < best.tokens)) {
      best = { tokens, agreeing };
    }
  }
  return best;
}

/**
 * Resolve a model's window from the catalog by the order in the module
 * comment. Always returns a figure: the family default when nobody lists
 * the model.
 */
export function resolveCatalogContextWindow(
  providerId: string,
  modelId: string,
  index: CatalogContextWindowIndex,
  aliases: Readonly<Record<string, string>> = {},
): CatalogContextWindowResolution {
  const catalogProviderId = matchCatalogProviderId(providerId, index, aliases);
  if (catalogProviderId) {
    const own = index.byProvider.get(catalogProviderId)?.get(modelId);
    if (own !== undefined) {
      return { tokens: own, provenance: 'catalog', origin: { kind: 'catalog', catalogProviderId } };
    }
  }
  const listings = index.byNormalizedId.get(normalizeCatalogModelId(modelId)) ?? [];
  const consensus = consensusOf(listings);
  if (consensus) {
    return {
      tokens: consensus.tokens,
      provenance: 'catalog',
      origin: { kind: 'consensus', providers: listings.length, agreeing: consensus.agreeing },
    };
  }
  return {
    tokens: inferFallbackContextWindow(providerId, modelId),
    provenance: 'fallback',
    origin: { kind: 'family_default' },
  };
}

/**
 * True when a base URL points at this machine or a private network: such an
 * endpoint is a local server whose own figure is kept.
 */
export function isLocalBaseUrl(baseURL: string): boolean {
  let host: string;
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1' || host === '::') return true;
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) {
    return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80') || host.startsWith('::ffff:127.');
  }
  return false;
}

/**
 * True when a model's window is not a real figure and it is not local: the
 * window is missing, is the old 8192 guess, or is itself only a guess. A
 * window the provider reported, a learned limit, and any local model keep
 * their own figure.
 */
export function needsCatalogContextWindow(model: ModelDefinition, isLocalProvider: boolean): boolean {
  if (isLocalProvider) return false;
  const provenance = model.contextWindowProvenance;
  if (provenance === 'provider_api' || provenance === 'observed_limit' || provenance === 'catalog') return false;
  const window = model.contextWindow;
  if (!Number.isFinite(window) || window <= 0) return true;
  if (provenance === 'fallback') return true;
  // A catalog model (no provenance) states its catalog figure; only a
  // configured value equal to the old guess is replaced.
  return provenance === 'configured_cap' && window === LEGACY_GUESSED_CONTEXT_WINDOW;
}

/**
 * Apply the catalog resolution to one model when it needs it; returns the
 * model unchanged otherwise.
 */
export function applyCatalogContextWindow(
  model: ModelDefinition,
  isLocalProvider: boolean,
  index: CatalogContextWindowIndex,
  aliases: Readonly<Record<string, string>> = {},
): ModelDefinition {
  if (!needsCatalogContextWindow(model, isLocalProvider)) return model;
  const resolved = resolveCatalogContextWindow(model.provider, model.id, index, aliases);
  return {
    ...model,
    contextWindow: resolved.tokens,
    contextWindowProvenance: resolved.provenance,
    contextWindowOrigin: resolved.origin,
  };
}

/**
 * A short label naming where a model's window came from, for /context window
 * and /status: 'catalog: abacus', 'consensus of 4 providers', 'family
 * default', 'user override', and so on.
 */
export function describeContextWindowSource(model: ModelDefinition): string {
  const origin = model.contextWindowOrigin;
  switch (model.contextWindowProvenance) {
    case 'configured_cap':
      if (origin?.kind === 'user_override') return 'user override';
      if (origin?.kind === 'provider_file') return 'provider file';
      return 'configured';
    case 'provider_api':
      return 'reported by the provider';
    case 'observed_limit':
      return 'learned from a provider rejection';
    case 'accepted_floor':
      return 'the provider accepted a larger request than the stated window';
    case 'catalog':
      if (origin?.kind === 'catalog') return `catalog: ${origin.catalogProviderId}`;
      if (origin?.kind === 'consensus') {
        const noun = origin.providers === 1 ? 'provider' : 'providers';
        return origin.agreeing === origin.providers
          ? `consensus of ${origin.providers} ${noun}`
          : `consensus of ${origin.providers} ${noun} (${origin.agreeing} agree)`;
      }
      return 'model catalog';
    case 'fallback':
      return origin?.kind === 'family_default' ? 'family default' : 'default (nothing states it)';
    default:
      return 'model catalog';
  }
}

/**
 * The registry's holder for the catalog step: keeps the lookup tables for
 * the current catalog snapshot and the names of local custom providers, and
 * applies the resolution to each model the registry lists.
 */
export class CatalogContextWindowResolver {
  private indexed: { models: readonly CatalogModel[]; index: CatalogContextWindowIndex } | null = null;
  private localCustomProviders: ReadonlySet<string> = new Set();

  constructor(
    private readonly catalogModels: () => readonly CatalogModel[],
    /** True for a discovered local server. */
    private readonly isDiscovered: (providerName: string) => boolean,
    /** The registered provider, read for a `baseURL` field when it has one. */
    private readonly getProvider: (providerName: string) => object | undefined,
    private readonly aliases: Readonly<Record<string, string>> = {},
  ) {}

  /** Record which custom providers sit at a local or private address. */
  setCustomProviders(configs: ReadonlyArray<{ readonly name: string; readonly baseURL: string }>): void {
    this.localCustomProviders = new Set(configs.filter((config) => isLocalBaseUrl(config.baseURL)).map((config) => config.name));
  }

  /** A discovered server, a custom provider at a local address, or any provider registered with a local base URL. */
  isLocalProvider(providerName: string): boolean {
    if (this.localCustomProviders.has(providerName) || this.isDiscovered(providerName)) return true;
    const provider = this.getProvider(providerName);
    const baseURL = provider && 'baseURL' in provider ? provider.baseURL : undefined;
    return typeof baseURL === 'string' && isLocalBaseUrl(baseURL);
  }

  private index(): CatalogContextWindowIndex {
    const models = this.catalogModels();
    if (this.indexed?.models !== models) this.indexed = { models, index: buildCatalogContextWindowIndex(models) };
    return this.indexed.index;
  }

  apply(model: ModelDefinition): ModelDefinition {
    if (!needsCatalogContextWindow(model, this.isLocalProvider(model.provider))) return model;
    return applyCatalogContextWindow(model, false, this.index(), this.aliases);
  }
}
