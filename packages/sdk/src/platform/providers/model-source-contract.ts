/**
 * Provider Model Source Contract — a registration-time check that every
 * provider names where its model list actually comes from, so a caller can
 * always tell a live-refreshed list apart from a hand-maintained one and
 * both apart from a silently dead, undated array.
 *
 * Mirrors the fail-closed shape of `runtime/tools/contract-verifier.ts`: a
 * provider that fails this check is rejected at registration time with an
 * actionable message, instead of being allowed to register with an
 * undeclared model source and no way for a caller to tell whether that's a
 * bug, an outage, or simply a provider nobody wired up yet.
 *
 * A provider passes only when it declares a `modelSource` of:
 *   - `live-discovery`  — fetches its own model list from a live API, or
 *   - `dated-static`    — with a non-empty `asOf`, a complete hand-maintained
 *                         list verified as of that date, or
 *   - `catalog-backed`  — its real selectable models come from the shared,
 *                         independently refreshed model catalog.
 *
 * A non-empty `models` array is no longer accepted by itself: a provider
 * whose list happens to be populated but never says where that list came
 * from (or how it stays current) is exactly the undeclared, silently-stale
 * pattern this check exists to make unwritable, whether or not `models` is
 * empty today.
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
        `Provider '${provider.name}' has no usable model source: it declares no modelSource ` +
        `(a non-empty 'models' array by itself is not enough). Every provider must declare ` +
        `modelSource: { kind: 'live-discovery' } (populated asynchronously from the provider's own API), ` +
        `modelSource: { kind: 'dated-static', asOf: '<YYYY-MM-DD>' } (a complete, dated fallback list), or ` +
        `modelSource: { kind: 'catalog-backed' } (models sourced from the shared, independently refreshed ` +
        `model catalog). An undeclared model source is not valid and registration is refused.`,
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
