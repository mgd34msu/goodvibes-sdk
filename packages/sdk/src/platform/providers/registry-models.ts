import type { ModelDefinition } from './registry-types.js';
import { splitModelRegistryKey, withRegistryKey } from './registry-helpers.js';

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
}): ModelDefinition[] {
  const customModels = input.customModels.map(withRegistryKey);
  const runtimeModels = input.runtimeModels.map(withRegistryKey);
  const syntheticModels = input.syntheticModels.map(withRegistryKey);
  const catalogModels = input.catalogModels.map(withRegistryKey);
  const discoveredModels = input.discoveredModels.map(withRegistryKey);
  const sameRegistryKey = (left: ModelDefinition, right: ModelDefinition): boolean =>
    left.registryKey === right.registryKey;

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
    ...syntheticModels,
    ...catalogFiltered,
    ...discoveredFiltered,
  ];
}
