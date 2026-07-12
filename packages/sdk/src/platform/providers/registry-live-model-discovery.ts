/**
 * Provider-native live model discovery — extracted from ProviderRegistry to
 * keep registry.ts under its line-cap ceiling, mirroring the extraction
 * pattern already used by registry-catalog-lifecycle.ts and
 * registry-models.ts.
 *
 * Owns the `providerNativeModels` bucket: model definitions synthesized
 * directly from a provider's own `models` list (populated either
 * synchronously at registration from a dated-static baseline, or later via
 * `refreshModels()`), independent of the shared third-party model catalog.
 */

import type { LLMProvider } from './interface.js';
import type { ModelDefinition } from './registry-types.js';
import {
  buildProviderNativeModelDefinition,
  type LiveModelDiscoveryResult,
} from './live-model-discovery.js';

export type ProviderRefreshableModel = Pick<LLMProvider, 'name'> &
  Partial<{ refreshModels: (force?: boolean) => Promise<LiveModelDiscoveryResult> }>;

/**
 * Seed `providerNativeModels` for one provider from its current `.models`
 * list. Called at registration time (before any async `refreshModels()` has
 * run) and again after each refresh. Only applies to providers that declare
 * a `modelSource` other than `catalog-backed`; providers relying entirely on
 * the shared catalog (or with no declaration, meaning their static list IS
 * the whole story) don't need a separate native-model bucket.
 *
 * Returns a new array with this provider's prior entries replaced.
 */
export function applyProviderNativeModelBaseline(
  providerNativeModels: readonly ModelDefinition[],
  provider: LLMProvider,
): ModelDefinition[] {
  if (!provider.modelSource || provider.modelSource.kind === 'catalog-backed') {
    return [...providerNativeModels];
  }
  const definitions = provider.models.map((id) => buildProviderNativeModelDefinition(provider.name, id));
  return [
    ...providerNativeModels.filter((model) => model.provider !== provider.name),
    ...definitions,
  ];
}

/** Remove a provider's entries from the bucket (used on runtime-provider unregister). */
export function removeProviderNativeModels(
  providerNativeModels: readonly ModelDefinition[],
  providerName: string,
): ModelDefinition[] {
  return providerNativeModels.filter((model) => model.provider !== providerName);
}

export interface LiveModelDiscoverySweepResult {
  readonly providerNativeModels: ModelDefinition[];
  readonly reports: Array<{ providerId: string } & LiveModelDiscoveryResult>;
}

/**
 * Re-check live model discovery for every provider in `providers` that
 * implements `refreshModels()` (or just `providerId` when given). This is
 * the registry-level hook a picker-open handler or an explicit user refresh
 * command calls: routine background refreshes respect each provider's
 * on-disk TTL cache, `force: true` bypasses it.
 *
 * Always resolves with one report per checked provider — a provider whose
 * live fetch fails still gets an honest report (see
 * `LiveModelDiscoveryResult.error`), never a thrown exception that would
 * abort the whole sweep.
 */
export async function sweepLiveModelDiscovery(
  providers: Iterable<ProviderRefreshableModel>,
  providerNativeModels: readonly ModelDefinition[],
  providerId: string | undefined,
  options: { force?: boolean },
): Promise<LiveModelDiscoverySweepResult> {
  const all = [...providers];
  const targets = providerId ? all.filter((p) => p.name === providerId) : all;

  let nextProviderNativeModels = [...providerNativeModels];
  const reports: Array<{ providerId: string } & LiveModelDiscoveryResult> = [];
  for (const provider of targets) {
    if (typeof provider.refreshModels !== 'function') continue;
    const result = await provider.refreshModels(options.force ?? false);
    nextProviderNativeModels = [
      ...nextProviderNativeModels.filter((model) => model.provider !== provider.name),
      ...result.models.map((id) => buildProviderNativeModelDefinition(provider.name, id)),
    ];
    reports.push({ providerId: provider.name, ...result });
  }
  return { providerNativeModels: nextProviderNativeModels, reports };
}
