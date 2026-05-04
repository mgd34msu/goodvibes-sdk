import type { LLMProvider } from './interface.js';
import { getConfiguredApiKeys } from '../config/index.js';
import type { CatalogModel } from './model-catalog.js';

/**
 * Compute the set of provider IDs that are currently configured
 * (have an API key in env, config, or self-report as configured).
 *
 * Extracted from ProviderRegistry to keep the class focused on provider
 * management. Called via a thin delegate on ProviderRegistry.
 *
 * @param catalogModels - Current catalog model list (read-only).
 * @param providers - Live provider map (read-only).
 * @param getSyntheticBackendModelIds - Delegate to check synthetic model count.
 */
export function computeConfiguredProviderIds(
  catalogModels: readonly CatalogModel[],
  providers: ReadonlyMap<string, LLMProvider>,
  getSyntheticBackendModelIds: () => Set<string>,
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
    } else if (envVars.some((envVar) => {
      const value = process.env[envVar];
      return typeof value === 'string' && value.length > 0;
    })) {
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

  if (getSyntheticBackendModelIds().size > 0) {
    configured.add('synthetic');
  }

  for (const [name, provider] of providers) {
    if (typeof provider.isConfigured === 'function' && provider.isConfigured()) {
      configured.add(name);
    }
  }

  return [...configured];
}
