/**
 * provider-stack.ts — the model side of a runtime composition, built once.
 *
 * A surface that runs its own conversation loop needs exactly what a daemon
 * needs to talk to a model: the capability/limits/benchmark/favorites stores the
 * registry reads, the registry itself, the ONE credential chain that keeps it
 * live across secret writes, the tool-call LLM, and the optimizer bound to its
 * flag and config mode. None of it is daemon-grade — a client owns all of it —
 * so `createRuntimeServices` and `createClientRuntimeServices` share this one
 * implementation rather than each spelling the chain out.
 *
 * The load-bearing part is the credential chain (env -> secrets ->
 * subscription): boot applies secrets-backed keys and every later secrets
 * write/delete re-registers the builtins LIVE, so badges, the model picker and
 * the chat path all read the same provider instances with no restart. A second
 * hand-written copy of that wiring is how a fork ends up with a picker that
 * shows a key the chat path cannot use.
 */

import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import type { SubscriptionManager } from '../config/subscriptions.js';
import { ToolLLM } from '../config/tool-llm.js';
import { CacheHitTracker } from '../providers/cache-strategy.js';
import { ProviderCapabilityRegistry } from '../providers/capabilities.js';
import { FavoritesStore } from '../providers/favorites.js';
import { BenchmarkStore } from '../providers/model-benchmarks.js';
import { ModelLimitsService } from '../providers/model-limits.js';
import { ProviderOptimizer } from '../providers/optimizer.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { RuntimeEventBus } from './events/index.js';
import type { FeatureFlagManager } from './feature-flags/index.js';
import {
  applyProviderOptimizerConfigMode,
  bindProviderOptimizerFeatureFlag,
} from './provider-optimizer-wiring.js';
import type { ShellPathService } from './shell-paths.js';

export interface ProviderStackOptions {
  readonly configManager: ConfigManager;
  readonly subscriptionManager: SubscriptionManager;
  readonly secretsManager: SecretsManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly featureFlags: FeatureFlagManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly shellPaths: ShellPathService;
  /** The product's storage root (`tui`, `agent`, `daemon`, …); the per-user stores hang off it. */
  readonly surfaceRoot: string;
}

/** Everything a composition needs to choose and call a model. */
export interface ProviderStack {
  readonly providerCapabilityRegistry: ProviderCapabilityRegistry;
  readonly cacheHitTracker: CacheHitTracker;
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly modelLimitsService: ModelLimitsService;
  readonly providerRegistry: ProviderRegistry;
  readonly toolLLM: ToolLLM;
  readonly providerOptimizer: ProviderOptimizer;
}

export function createProviderStack(options: ProviderStackOptions): ProviderStack {
  const { configManager, shellPaths, surfaceRoot } = options;
  const providerCapabilityRegistry = new ProviderCapabilityRegistry();
  const cacheHitTracker = new CacheHitTracker();
  const favoritesStore = new FavoritesStore({ dir: shellPaths.resolveUserPath(surfaceRoot) });
  const benchmarkStore = new BenchmarkStore({ dir: shellPaths.resolveUserPath(surfaceRoot) });
  const modelLimitsService = new ModelLimitsService({
    cachePath: shellPaths.resolveUserPath(surfaceRoot, 'model-limits.json'),
  });
  const providerRegistry = new ProviderRegistry({
    configManager,
    subscriptionManager: options.subscriptionManager,
    secretsManager: options.secretsManager,
    serviceRegistry: options.serviceRegistry,
    capabilityRegistry: providerCapabilityRegistry,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    modelLimitsService,
    featureFlags: options.featureFlags,
    runtimeBus: options.runtimeBus,
  });
  providerRegistry.initCustomProviders(); providerRegistry.initProviderModelDiscovery();
  // ONE credential chain (env -> secrets -> subscription): boot applies secrets-backed keys; every secrets write/delete re-registers builtins LIVE (no restart); badges/picker/chat read the same instances.
  options.secretsManager.onDidChange(() => void providerRegistry.refreshProviderCredentials().catch((error) => logger.warn('live credential refresh failed', { error: summarizeError(error) })));
  void providerRegistry.refreshProviderCredentials().catch((error) => logger.warn('boot credential refresh failed', { error: summarizeError(error) }));
  const toolLLM = new ToolLLM({
    configManager,
    providerRegistry,
    runtimeBus: options.runtimeBus,
  });
  const providerOptimizer = new ProviderOptimizer(providerRegistry, providerCapabilityRegistry, false);
  bindProviderOptimizerFeatureFlag(options.featureFlags, providerOptimizer);
  applyProviderOptimizerConfigMode(configManager, providerOptimizer);
  return {
    providerCapabilityRegistry,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    modelLimitsService,
    providerRegistry,
    toolLLM,
    providerOptimizer,
  };
}
