/**
 * Spawn-time model reference normalization for AgentManager. Extracted from
 * manager.ts to keep that file under its line-cap ceiling.
 *
 * When `modelCandidates` (the live registry's model list) is supplied, a
 * bare id resolves via the shared resolver (model-id-resolution.ts): unique
 * across the registry -> auto-qualify; ambiguous/unknown -> a rich error
 * naming real candidates. Storage stays provider-qualified either way.
 * Omitted `modelCandidates` falls back to the prior format-only validation
 * so a caller that hasn't threaded the registry through yet is unaffected.
 */

import { splitModelRegistryKey } from '../../providers/registry-helpers.js';
import { resolveModelReference, type ModelIdCandidate } from '../../providers/model-id-resolution.js';

export function requireProviderQualifiedModel(
  modelId: string | undefined,
  label: string,
  modelCandidates?: readonly ModelIdCandidate[],
  contextProviderId?: string | undefined,
): string | undefined {
  const trimmed = typeof modelId === 'string' ? modelId.trim() : '';
  if (!trimmed) return undefined;
  if (modelCandidates) {
    try {
      return resolveModelReference(trimmed, modelCandidates, { contextProviderId });
    } catch (err) {
      throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    splitModelRegistryKey(trimmed);
  } catch {
    throw new Error(`${label} must be a provider-qualified registry key; received '${modelId}'.`);
  }
  return trimmed;
}

export function normalizeProviderQualifiedModelList(
  models: readonly string[] | undefined,
  label: string,
  modelCandidates?: readonly ModelIdCandidate[],
): string[] | undefined {
  const normalized = models
    ?.filter((model) => typeof model === 'string' && model.trim().length > 0)
    .map((model) => requireProviderQualifiedModel(model, label, modelCandidates)!);
  return normalized && normalized.length > 0 ? normalized : undefined;
}
