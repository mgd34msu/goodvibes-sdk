import type { ModelDefinition } from './registry-types.js';

export function withRegistryKey(model: ModelDefinition): ModelDefinition {
  return model.registryKey ? model : { ...model, registryKey: `${model.provider}:${model.id}` };
}

export function splitModelRegistryKey(modelId: string): { providerId: string; resolvedModelId: string } {
  const separatorIndex = modelId.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === modelId.length - 1) {
    throw new Error(`Model registry keys must be provider-qualified; received '${modelId}'.`);
  }

  return {
    providerId: modelId.slice(0, separatorIndex),
    resolvedModelId: modelId.slice(separatorIndex + 1),
  };
}

/**
 * Key-order-independent JSON serialisation used for model diff comparisons.
 * Recursively sorts object keys so that { a: 1, b: 2 } and { b: 2, a: 1 }
 * produce the same string.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  return '{' + sorted.map((key) => (
    JSON.stringify(key) + ':' + stableStringify((value as Record<string, unknown>)[key])
  )).join(',') + '}';
}
