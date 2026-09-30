import type { LLMProvider, ProviderRuntimeMetadataDeps } from './interface.js';
import type { ProviderCapabilityRegistry } from './capabilities.js';
import type { ConfigManager } from '../config/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { SubscriptionManager } from '../config/subscriptions.js';
import type { CacheHitTracker } from './cache-strategy.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.js';
import type { FavoritesStore } from './favorites.js';
import type { BenchmarkStore } from './model-benchmarks.js';
import type { ModelLimitsService } from './model-limits.js';
import type { ManualModelPrice } from './model-pricing.js';
import type { ReasoningEffortSpec } from './reasoning-effort.js';

/** Model capability tier, controls system prompt verbosity. */
export type ModelTier = 'free' | 'standard' | 'premium' | 'subscription';

/** Per-model token limits for output, tool results, tool calls, and reasoning. */
export interface TokenLimits {
  maxOutputTokens?: number | undefined;
  maxToolResultTokens?: number | undefined;
  maxToolCalls?: number | undefined;
  maxReasoningTokens?: number | undefined;
}

/**
 * Provenance of a resolved context window value.
 *
 * - `provider_api`  , reported by the provider's own models endpoint
 * - `configured_cap`, set explicitly (a user override or a provider file value)
 * - `observed_limit`, learned from a provider rejecting a longer request
 * - `accepted_floor`, the stated window was disproven: the provider accepted a
 *                     request larger than it. The real window is unknown;
 *                     `contextWindow` holds the largest input seen accepted.
 * - `catalog`       , looked up in the models.dev catalog for a remote model
 *                     whose own source stated no real window (see
 *                     context-window-catalog.ts); `contextWindowOrigin` says
 *                     which provider or how many providers stated it
 * - `fallback`      , nothing states the window; `contextWindow` is a guess
 */
export type ContextWindowProvenance = 'provider_api' | 'configured_cap' | 'observed_limit' | 'accepted_floor' | 'catalog' | 'fallback';

/**
 * Where a resolved context window came from, in more detail than its
 * provenance. `describeContextWindowSource` turns it into a label.
 *
 * - `user_override` , set with /context window or the model picker
 * - `provider_file` , the model's entry in a custom provider file
 * - `catalog`       , the model's own catalog provider lists it
 * - `consensus`     , the value most catalog providers listing the model share
 * - `family_default`, no catalog provider lists the model; a family guess
 */
export type ContextWindowOrigin =
  | { readonly kind: 'user_override' }
  | { readonly kind: 'provider_file' }
  | { readonly kind: 'catalog'; readonly catalogProviderId: string }
  | { readonly kind: 'consensus'; readonly providers: number; readonly agreeing: number }
  | { readonly kind: 'family_default' };

/** Describes a selectable model and its capabilities. */
export interface ModelDefinition {
  id: string;
  provider: string;
  /** Compound unique key: `${provider}:${id}`. Safe separator since model IDs use `/` not `:`. */
  registryKey: string;
  displayName: string;
  description: string;
  capabilities: {
    toolCalling: boolean;
    codeEditing: boolean;
    reasoning: boolean;
    multimodal: boolean;
  };
  contextWindow: number;
  contextWindowProvenance?: ContextWindowProvenance | undefined;
  /** Where the window came from, in more detail than its provenance. */
  contextWindowOrigin?: ContextWindowOrigin | undefined;
  selectable: boolean;
  /**
   * What this exact model accepts for reasoning effort, and which request
   * field carries it. Absent means the model does not reason at all; a spec
   * of kind `unavailable` means it reasons at a depth nobody can configure.
   */
  reasoningEffort?: ReasoningEffortSpec | undefined;
  tier?: ModelTier | undefined;
  tokenLimits?: TokenLimits | undefined;
  /**
   * Registration-supplied rates (USD per 1M tokens), set by custom
   * provider/model files or runtime registration. Resolves as a user-origin
   * price, outranked only by a manual config price. Absent means the
   * registration stated no price (NOT free): pricing falls through to
   * provider/catalog sources or honest unknown.
   */
  pricing?: ManualModelPrice | undefined;
}

export interface RuntimeProviderRegistration {
  readonly provider: LLMProvider;
  readonly models?: readonly ModelDefinition[] | undefined;
  readonly suppressCatalogModelRegistryKeys?: readonly string[] | undefined;
  readonly replace?: boolean | undefined;
}

export interface ProviderRegistryOptions {
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory' | 'getControlPlaneConfigDir'>;
  readonly subscriptionManager: Pick<SubscriptionManager, 'get' | 'getPending' | 'saveSubscription' | 'resolveAccessToken'>;
  readonly secretsManager: ProviderRuntimeMetadataDeps['secretsManager'];
  readonly serviceRegistry: ProviderRuntimeMetadataDeps['serviceRegistry'];
  readonly capabilityRegistry: ProviderCapabilityRegistry;
  readonly cacheHitTracker: CacheHitTracker;
  readonly favoritesStore: Pick<FavoritesStore, 'load'>;
  readonly benchmarkStore: Pick<BenchmarkStore, 'getBenchmarks' | 'getTopBenchmarkModelIds'>;
  readonly modelLimitsService?: ModelLimitsService | undefined;
  readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
  readonly runtimeBus?: RuntimeEventBus | null | undefined;
}
