/**
 * credentials.ts — provider credential resolution and auth-state queries.
 * Pure functions that do not hold mutable state; called by ProviderRegistry.
 */
import { getConfiguredApiKeys } from '../config/index.js';
import type { LLMProvider } from './interface.js';
import type { CatalogModel } from './model-catalog.js';

/**
 * Determine which provider IDs have a configured API key / env-var / isConfigured flag.
 *
 * @param catalogModels      - Current snapshot of catalog models.
 * @param syntheticBackendModelIds - Set of synthetic backend model IDs.
 * @param providers          - Map of registered LLM providers.
 * @returns Sorted array of provider IDs that appear configured.
 */
export function getConfiguredProviderIds(
  catalogModels: readonly CatalogModel[],
  syntheticBackendModelIds: Set<string>,
  providers: ReadonlyMap<string, LLMProvider>,
): string[] {
  const configured = new Set<string>();
  const providerEnvMap = new Map<string, string[]>();

  for (const model of catalogModels) {
    if (!providerEnvMap.has(model.providerId)) {
      providerEnvMap.set(model.providerId, model.providerEnvVars);
    }
  }

  for (const [providerId, envVars] of providerEnvMap) {
    if (envVars.length === 0) {
      configured.add(providerId);
    } else if (
      envVars.some((envVar) => {
        const value = process.env[envVar]!;
        return typeof value === 'string' && value.length > 0;
      })
    ) {
      configured.add(providerId);
    }
  }

  try {
    const configApiKeys = getConfiguredApiKeys();
    const configToCatalog: Record<string, string> = { gemini: 'google', inceptionlabs: 'inception' };
    for (const [configName, key] of Object.entries(configApiKeys)) {
      if (key) {
        configured.add(configToCatalog[configName] ?? configName);
      }
    }
  } catch {
    // non-fatal
  }

  if (syntheticBackendModelIds.size > 0) {
    configured.add('synthetic');
  }

  for (const [name, provider] of providers) {
    if (typeof provider.isConfigured === 'function' && provider.isConfigured()) {
      configured.add(name);
    }
  }

  return [...configured];
}
