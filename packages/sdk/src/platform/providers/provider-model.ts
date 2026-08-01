/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * provider-model.ts — tolerant parsing of the `provider:model` string that
 * config stores in `provider.model`.
 *
 * Relationship to {@link splitModelRegistryKey} (registry-helpers.ts): that one
 * is the STRICT reader. It is used where a value has already been established
 * as a registry key, and it throws when the value is not provider-qualified,
 * because at those call sites an unqualified key is a defect.
 *
 * These three are the TOLERANT readers, used where the value comes from user
 * configuration and may legitimately be blank, bare, or half-typed:
 *
 *  - an empty/whitespace value falls back to `DEFAULT_CONFIG.provider.model`
 *    rather than yielding an empty provider id;
 *  - a bare value with no `:` is read as the provider id by
 *    {@link getProviderIdFromModel} and as the model id by
 *    {@link getModelIdFromProviderModel};
 *  - {@link formatProviderModel} composes the two halves back without
 *    double-qualifying a model that already carries its provider.
 *
 * Resolving a bare model id against the live registry (auto-qualifying,
 * ambiguity, did-you-mean) is a different job again and lives in
 * model-id-resolution.ts.
 */

import { DEFAULT_CONFIG } from '../config/schema.js';

/** The provider half of a `provider:model` value; a bare value is the provider. */
export function getProviderIdFromModel(model: unknown): string {
  const raw = String(model ?? '').trim();
  if (!raw) return getProviderIdFromModel(DEFAULT_CONFIG.provider.model);
  const separator = raw.indexOf(':');
  return separator > 0 ? raw.slice(0, separator) : raw;
}

/** The model half of a `provider:model` value; a bare value is the model. */
export function getModelIdFromProviderModel(model: unknown): string {
  const raw = String(model ?? '').trim();
  if (!raw) return String(DEFAULT_CONFIG.provider.model);
  const separator = raw.indexOf(':');
  return separator > 0 ? raw.slice(separator + 1) : raw;
}

/** Compose `provider:model`, leaving an already-qualified model untouched. */
export function formatProviderModel(providerId: string, modelId: string): string {
  const provider = providerId.trim();
  const model = modelId.trim();
  if (!provider) return model;
  if (!model) return `${provider}:`;
  return model.includes(':') ? model : `${provider}:${model}`;
}
