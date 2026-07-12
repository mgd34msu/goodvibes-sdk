import type { ModelDefinition } from './registry-types.js';
import { splitModelRegistryKey, stableStringify, withRegistryKey } from './registry-helpers.js';

export function getProviderLookupCandidates(
  providerName: string,
  aliases: Readonly<Record<string, string>>,
): string[] {
  const candidates = new Set<string>([providerName]);
  const directAlias = aliases[providerName]!;
  if (directAlias) candidates.add(directAlias);
  for (const [catalogName, registeredName] of Object.entries(aliases)) {
    if (registeredName === providerName) candidates.add(catalogName);
    if (directAlias && registeredName === directAlias) candidates.add(catalogName);
  }
  return [...candidates];
}

export function findModelDefinition(
  modelId: string,
  registry: readonly ModelDefinition[],
): ModelDefinition | undefined {
  if (!modelId.includes(':')) return undefined;
  return registry.find((model) => model.registryKey === modelId);
}

export function findModelDefinitionForProvider(
  modelId: string,
  providerName: string,
  registry: readonly ModelDefinition[],
  aliases: Readonly<Record<string, string>>,
): ModelDefinition | undefined {
  const providerCandidates = new Set(getProviderLookupCandidates(providerName, aliases));
  const resolvedModelId = modelId.includes(':') ? splitModelRegistryKey(modelId).resolvedModelId : modelId;
  if (modelId.includes(':')) {
    const registryMatch = findModelDefinition(modelId, registry);
    return registryMatch && providerCandidates.has(registryMatch.provider)
      ? registryMatch
      : undefined;
  }

  return registry.find((model) => model.id === resolvedModelId && providerCandidates.has(model.provider));
}

export function buildModelRegistry(input: {
  readonly customModels: readonly ModelDefinition[];
  readonly runtimeModels: readonly ModelDefinition[];
  readonly syntheticModels: readonly ModelDefinition[];
  readonly catalogModels: readonly ModelDefinition[];
  readonly discoveredModels: readonly ModelDefinition[];
  readonly suppressedCatalogRegistryKeys: ReadonlySet<string>;
  /**
   * Models sourced directly from a provider's own live/dated-static model
   * source (see `live-model-discovery.ts`) rather than the shared
   * third-party catalog. Takes priority over `catalogModels` for the same
   * registryKey — the provider's own truth beats a third-party snapshot
   * that may lag behind — but only fills gaps: an entry already present in
   * `catalogModels` keeps the richer catalog-sourced definition (pricing,
   * measured context window, etc).
   */
  readonly providerNativeModels?: readonly ModelDefinition[] | undefined;
}): ModelDefinition[] {
  const customModels = input.customModels.map(withRegistryKey);
  const runtimeModels = input.runtimeModels.map(withRegistryKey);
  const syntheticModels = input.syntheticModels.map(withRegistryKey);
  const catalogModels = input.catalogModels.map(withRegistryKey);
  const discoveredModels = input.discoveredModels.map(withRegistryKey);
  const providerNativeModels = (input.providerNativeModels ?? []).map(withRegistryKey);
  const sameRegistryKey = (left: ModelDefinition, right: ModelDefinition): boolean =>
    left.registryKey === right.registryKey;

  const providerNativeFiltered = providerNativeModels.filter(
    (native) =>
      !customModels.some((model) => sameRegistryKey(model, native)) &&
      !runtimeModels.some((model) => sameRegistryKey(model, native)) &&
      !catalogModels.some((model) => sameRegistryKey(model, native)),
  );

  const catalogFiltered = catalogModels.filter(
    (builtin) =>
      !customModels.some((model) => sameRegistryKey(model, builtin)) &&
      !runtimeModels.some((model) => sameRegistryKey(model, builtin)) &&
      !input.suppressedCatalogRegistryKeys.has(builtin.registryKey) &&
      !input.suppressedCatalogRegistryKeys.has(`${builtin.provider}:${builtin.id}`) &&
      !builtin.id.startsWith('hf:'),
  );

  const discoveredFiltered = discoveredModels.filter(
    (discovered) =>
      !catalogModels.some((model) => sameRegistryKey(model, discovered)) &&
      !customModels.some((model) => sameRegistryKey(model, discovered)) &&
      !runtimeModels.some((model) => sameRegistryKey(model, discovered)),
  );

  return [
    ...customModels,
    ...runtimeModels,
    ...providerNativeFiltered,
    ...syntheticModels,
    ...catalogFiltered,
    ...discoveredFiltered,
  ];
}

export interface CustomModelDiff {
  readonly added: string[];
  readonly removed: string[];
  readonly updated: string[];
  /** One warning per custom model whose registryKey collides with a catalog model. */
  readonly collisionWarnings: string[];
}

/**
 * Compute the added/removed/updated diff between a previous and next set of
 * custom models, plus catalog-collision warnings. Extracted from
 * ProviderRegistry.loadCustomProviders() so that method stays a thin
 * orchestration wrapper.
 */
export function diffCustomModels(
  previousModels: readonly ModelDefinition[],
  nextModels: readonly ModelDefinition[],
  catalogModels: readonly ModelDefinition[],
): CustomModelDiff {
  const previousRegistryKeys = new Set(previousModels.map((model) => withRegistryKey(model).registryKey));
  const newRegistryKeys = new Set(nextModels.map((model) => withRegistryKey(model).registryKey));

  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];

  for (const registryKey of newRegistryKeys) {
    if (!previousRegistryKeys.has(registryKey)) {
      added.push(registryKey);
      continue;
    }
    // Only mark as updated if the model definition actually changed.
    const oldModel = previousModels.find((model) => withRegistryKey(model).registryKey === registryKey);
    const newModel = nextModels.find((model) => withRegistryKey(model).registryKey === registryKey);
    if (stableStringify(oldModel && withRegistryKey(oldModel)) !== stableStringify(newModel && withRegistryKey(newModel))) {
      updated.push(registryKey);
    }
  }
  for (const registryKey of previousRegistryKeys) {
    if (!newRegistryKeys.has(registryKey)) removed.push(registryKey);
  }

  const catalogRegistryKeys = new Set(catalogModels.map((model) => withRegistryKey(model).registryKey));
  const collisionWarnings = nextModels
    .map((model) => withRegistryKey(model).registryKey)
    .filter((registryKey) => catalogRegistryKeys.has(registryKey))
    .map((registryKey) => `[registry] Custom model '${registryKey}' overrides catalog model.`);

  return { added, removed, updated, collisionWarnings };
}
