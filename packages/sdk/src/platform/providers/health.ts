/**
 * health.ts — provider reachability and runtime-metadata queries.
 * Pure functions that do not hold mutable state; called by ProviderRegistry.
 */
import type { LLMProvider, ProviderRuntimeMetadata, ProviderRuntimeMetadataDeps } from './interface.js';
import { ProviderNotFoundError } from './provider-not-found-error.js';
import { CATALOG_PROVIDER_NAME_ALIASES } from './builtin-registry.js';

/**
 * Retrieve a provider by name with catalog-provider alias resolution, or throw ProviderNotFoundError.
 * Unlike ProviderRegistry.require(), this does NOT apply subscription route aliasing.
 */
function getRegisteredProvider(
  name: string,
  providers: ReadonlyMap<string, LLMProvider>,
): LLMProvider {
  const p = providers.get(name);
  if (p) return p;
  const aliased = CATALOG_PROVIDER_NAME_ALIASES[name]!;
  if (aliased) {
    const pa = providers.get(aliased);
    if (pa) return pa;
  }
  throw new ProviderNotFoundError(name, [...providers.keys()].sort());
}

/**
 * Fetch runtime metadata (auth state, usage, reachability) for a named provider.
 * Returns null if the provider exposes no describeRuntime() method.
 *
 * @param name                - Provider name as registered.
 * @param providers           - Map of registered LLM providers.
 * @param runtimeMetadataDeps - Dependencies forwarded to provider.describeRuntime().
 */
export async function describeProviderRuntime(
  name: string,
  providers: ReadonlyMap<string, LLMProvider>,
  runtimeMetadataDeps: ProviderRuntimeMetadataDeps,
): Promise<ProviderRuntimeMetadata | null> {
  const provider = getRegisteredProvider(name, providers);
  if (!provider.describeRuntime) return null;
  return provider.describeRuntime(runtimeMetadataDeps);
}
