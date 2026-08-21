/**
 * shipping.ts, the tier preference, and the ladder that steps down one rung.
 *
 * The preference is ORDINAL against what the checkout actually offers, not
 * against delivery-day promises. Merchants describe delivery in incomparable
 * ways, "2-day", "express", "by Tuesday", and a rule written against those
 * words breaks on the next merchant. Ranking the offered options cheapest-first
 * and indexing into that ranking works everywhere and is honest about what it
 * is doing.
 *
 * A merchant offering three options gets all three tiers; two options collapse
 * `fast` and `fastest` onto the same one; one option leaves nothing to choose.
 *
 * ── The ladder ────────────────────────────────────────────────────────────
 *
 * The preferred tier draws on the overage pool. When the pool cannot cover it,
 * step down ONE tier at a time until it fits, stopping at the cheapest. Not
 * straight to the cheapest: with tiers at $15 / $9 / $5 and $9 available, the
 * one-rung rule gets him $9 delivery and the shortcut gets him $5 delivery he
 * did not ask for.
 *
 * A step-down needs no approval, it is within budget by construction, but it
 * IS recorded and surfaced, because he must not learn about it from a late
 * package.
 *
 * ── Filler items ──────────────────────────────────────────────────────────
 *
 * There is no free-shipping-threshold logic in this file, and there must never
 * be. Adding an item he did not ask for in order to save on delivery is buying
 * something on his behalf to make a number look better. `assertCartMatchesRequest`
 * in cart.ts is the enforcement; its absence here is the design.
 */
import type { MinorUnits, ShippingOption, ShippingStepDown, ShippingTier } from './types.js';
import { SHIPPING_TIERS } from './types.js';

export interface RankedShipping {
  /** Cheapest first. The ranking the tier preference indexes into. */
  readonly ranked: readonly ShippingOption[];
  readonly tierToOption: ReadonlyMap<ShippingTier, ShippingOption>;
}

/**
 * Rank the checkout's delivery options and map each tier onto one.
 *
 * Ties are broken by the order the checkout listed them, so a merchant offering
 * two options at the same price does not get a coin flip between them.
 */
export function rankShippingOptions(options: readonly ShippingOption[]): RankedShipping {
  const ranked = [...options].sort((left, right) => left.costMinorUnits - right.costMinorUnits);
  const tierToOption = new Map<ShippingTier, ShippingOption>();
  if (ranked.length > 0) {
    SHIPPING_TIERS.forEach((tier, index) => {
      // Fewer options than tiers: the higher tiers collapse onto the most
      // expensive available rather than falling off the end.
      const option = ranked[Math.min(index, ranked.length - 1)];
      if (option !== undefined) tierToOption.set(tier, option);
    });
  }
  return { ranked, tierToOption };
}

export interface ShippingLadderResult {
  readonly tier: ShippingTier;
  readonly option: ShippingOption;
  readonly costMinorUnits: MinorUnits;
  readonly stepDown: ShippingStepDown | null;
  /** How many rungs were tried, so a test can prove it stepped rather than jumped. */
  readonly rungsTried: number;
}

/**
 * Walk down from the preferred tier until the total unavoidable draw fits.
 *
 * `budgetForOverage` is what the overage pool can still cover; `fixedUnavoidable`
 * is tax plus mandatory fees, which no amount of stepping down can reduce.
 * Returns null when nothing fits even at the cheastest rung, the caller then
 * either draws on the tolerance pool or refuses, per the decision order.
 */
export function walkShippingLadder(input: {
  readonly preferred: ShippingTier;
  readonly options: readonly ShippingOption[];
  readonly fixedUnavoidableMinorUnits: MinorUnits;
  readonly budgetForOverageMinorUnits: MinorUnits;
}): ShippingLadderResult | null {
  const { tierToOption } = rankShippingOptions(input.options);
  if (tierToOption.size === 0) return null;

  const startIndex = SHIPPING_TIERS.indexOf(input.preferred);
  const from = startIndex === -1 ? 0 : startIndex;

  let rungsTried = 0;
  for (let index = from; index >= 0; index -= 1) {
    const tier = SHIPPING_TIERS[index];
    if (tier === undefined) continue;
    const option = tierToOption.get(tier);
    if (option === undefined) continue;
    rungsTried += 1;

    const draw = input.fixedUnavoidableMinorUnits + option.costMinorUnits;
    if (draw > input.budgetForOverageMinorUnits) continue;

    const preferredOption = tierToOption.get(input.preferred);
    const stepDown: ShippingStepDown | null =
      tier === input.preferred || preferredOption === undefined
        ? null
        : {
            from: input.preferred,
            to: tier,
            savedMinorUnits: preferredOption.costMinorUnits - option.costMinorUnits,
            reason: 'overage-pool-insufficient',
          };

    return { tier, option, costMinorUnits: option.costMinorUnits, stepDown, rungsTried };
  }
  return null;
}

/** The cheapest rung, for the shortfall arithmetic when even it does not fit. */
export function cheapestOption(options: readonly ShippingOption[]): ShippingOption | null {
  return rankShippingOptions(options).ranked[0] ?? null;
}
