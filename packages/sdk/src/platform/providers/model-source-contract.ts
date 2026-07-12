/**
 * Provider Model Source Contract — a registration-time check that a provider's
 * model list can never silently be a dead, undated empty array.
 *
 * Mirrors the fail-closed shape of `runtime/tools/contract-verifier.ts`: a
 * provider that fails this check is rejected at registration time with an
 * actionable message, instead of being allowed to register with zero models
 * and no way for a caller to tell whether that's a bug, an outage, or simply
 * a provider nobody wired up yet.
 *
 * A provider passes when EITHER is true:
 *   1. Its `models` array is already non-empty (a static list, however it was
 *      populated), or
 *   2. It declares a `modelSource` of `live-discovery`, `dated-static` (with a
 *      non-empty `asOf`), or `catalog-backed`.
 *
 * A provider with an empty `models` array AND no `modelSource` declaration
 * fails: that combination is exactly the stale/dead-array anti-pattern this
 * check exists to make unwritable.
 */

import type { LLMProvider } from './interface.js';

export interface ProviderModelSourceViolation {
  readonly providerName: string;
  readonly message: string;
}

/** Minimal shape needed to run the check — real providers satisfy this trivially. */
export type ModelSourceCheckable = Pick<LLMProvider, 'name' | 'models' | 'modelSource'>;

/**
 * Verify a single provider's declared model source. Returns an empty array
 * when the provider passes.
 */
export function verifyProviderModelSource(provider: ModelSourceCheckable): ProviderModelSourceViolation[] {
  if (Array.isArray(provider.models) && provider.models.length > 0) {
    return [];
  }

  const source = provider.modelSource;
  if (source) {
    if (source.kind === 'live-discovery' || source.kind === 'catalog-backed') return [];
    if (source.kind === 'dated-static' && typeof source.asOf === 'string' && source.asOf.trim().length > 0) {
      return [];
    }
  }

  return [
    {
      providerName: provider.name,
      message:
        `Provider '${provider.name}' has no usable model source: its 'models' array is empty and it declares ` +
        `no modelSource. Every provider must supply either a non-empty models list, ` +
        `modelSource: { kind: 'live-discovery' } (populated asynchronously from the provider's own API), ` +
        `modelSource: { kind: 'dated-static', asOf: '<YYYY-MM-DD>' } (a complete, dated fallback list), or ` +
        `modelSource: { kind: 'catalog-backed' } (models sourced from the shared, independently refreshed ` +
        `model catalog). An empty, undated models array is not a valid model source and registration is refused.`,
    },
  ];
}

/** Format a rejection into a single throwable error message. */
export function formatProviderModelSourceRejection(violations: readonly ProviderModelSourceViolation[]): string {
  return violations.map((v) => v.message).join('\n');
}

/** Verify and throw in one call — the fail-closed registration-time gate callers actually want. */
export function assertProviderModelSource(provider: ModelSourceCheckable): void {
  const violations = verifyProviderModelSource(provider);
  if (violations.length > 0) throw new Error(formatProviderModelSourceRejection(violations));
}
