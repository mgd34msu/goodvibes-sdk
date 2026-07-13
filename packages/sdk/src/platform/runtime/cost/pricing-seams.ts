/**
 * The two pricing seams the composition root injects wherever usage is
 * priced (fleet registry, orchestration engine/phase-runner), built over the
 * ONE model pricing resolver (manual -> registration -> provider-served ->
 * catalog -> honest unknown):
 *
 * - `priceUsage` — honest-unpriced dollars: unknown/subscription yields null
 *   (costState 'unpriced'), never $0. SHARED by fleet + orchestration so
 *   totals never double-count.
 * - `priceProvenance` — provenance for the SAME resolution priceUsage prices
 *   with, stamped at pricing time so every priced value can say where its
 *   rates came from (costSource) and how fresh dated sources are (as-of).
 */
import { computeUsageCostUsd, type ResolvedModelPricing } from '../../providers/model-pricing.js';

export interface PricingSeams {
  readonly priceUsage: (model: string | undefined, usage: { inputTokens: number; outputTokens: number }) => number | null;
  readonly priceProvenance: (model: string | undefined) => { source: 'user' | 'provider' | 'catalog'; asOf?: string | undefined } | null;
}

export function buildPricingSeams(
  registry: { resolveModelPricing(model: string): ResolvedModelPricing },
): PricingSeams {
  return {
    priceUsage: (model, usage) => (model ? computeUsageCostUsd(registry.resolveModelPricing(model), usage) : null),
    priceProvenance: (model) => {
      if (!model) return null;
      const resolved = registry.resolveModelPricing(model);
      return resolved.status === 'priced' ? { source: resolved.source, asOf: resolved.asOf } : null;
    },
  };
}
