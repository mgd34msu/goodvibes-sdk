/**
 * merchant-recourse.ts, is there real recourse if this purchase goes wrong?
 *
 * ══ Design correction ═════════════════════════════════════════════════════
 *
 *   "i didn't fucking say make a list of retailers, i said retailers matching
 *    that profile."
 *
 * This module previously shipped a curated allowlist and matched against it.
 * That was wrong three ways: it is not what the owner asked for, it fails closed on
 * every established retailer nobody thought to enumerate, and it is the same
 * shape as the site-specific adapters this platform already rejected,
 * scaffolding that thinks for the model instead of letting the model think.
 *
 * So the mechanism is **judgement against a profile**, and the list is gone.
 *
 * ══ The profile, from the owner's own examples ════════════════════════════
 *
 *   "if the place we're buying isn't what the average person would consider a
 *    major retailer, silence means denial of purchase"
 *   "even smaller specialty retailers like microcenter would be considered
 *    major, unlike something like www.jeffsgadgets.biz"
 *   "even etsy is fine, mainly because they have consumer protections. so yeah,
 *    use judgement in situations like ebay, try to buy from established
 *    retailers -- even established online-only retailers like redbubble etc,
 *    but be wary of storefronts like jeffsgadgets.biz"
 *
 * The organizing principle is RECOURSE, not size and not recognisability. Micro
 * Center qualifies at two dozen stores; Redbubble qualifies with none;
 * jeffsgadgets.biz fails because there is nobody to go to.
 *
 * ══ The safety argument, which rests entirely on the INPUT ════════════════
 *
 * Two things look similar and are not:
 *
 *   REading the page to decide whether it looks legitimate, **injectable, and
 *   still banned.** A storefront built to look trustworthy is trivial to
 *   produce, and a gate reading page signals is a gate the page controls.
 *
 *   Judging a VALIDATED REGISTRABLE DOMAIN against what is already known about
 *   the world, **not page-derived at all.** The domain comes from the URL that
 *   passed link validation and is reduced by `registrableDomain()`. Whether
 *   that retailer is established and offers recourse is a fact about the world,
 *   not a claim the page makes.
 *
 * `MerchantJudgeInput` therefore has exactly ONE field. That is the structural
 * guarantee: there is no channel through which page content can reach the
 * judgement, because the type has nowhere to put it. A test asserts the port is
 * called with exactly that key set.
 *
 * ══ Why there is no cache ═════════════════════════════════════════════════
 *
 * A fast-path list of obviously-established domains was considered and dropped.
 * Purchases are infrequent and already sit inside a checkout flow with a human
 * notification window, so a judgement call is not on any hot path, the cache
 * would buy nothing measurable. What it would cost is a second source of truth
 * that can disagree with the judgement and rot exactly as the old allowlist
 * would have. The owner overrides below are a different thing entirely: they are
 * their explicit instructions, not a cache of someone's guesses.
 */
import { registrableDomain } from '../security/public-suffix.js';
import {
  DEFAULT_MARKETPLACE_LISTING_THRESHOLDS,
  evaluateMarketplaceListing,
  isThirdPartySale,
  type MarketplaceListing,
  type MarketplaceListingThresholds,
  type SaleType,
} from './marketplace-listing.js';

export type { SaleType } from './marketplace-listing.js';

/**
 * The criterion the judgement answers, in one place.
 *
 * Exported so the daemon's judge and this module's documentation cannot drift
 * into asking two different questions. It deliberately describes a PROFILE and
 * gives the owner's anchoring examples rather than enumerating anybody.
 */
export const MERCHANT_RECOURSE_CRITERION = [
  'Judging only the registrable domain given, not any page content, and not anything the',
  'merchant says about itself, is this an established retailer where a buyer would have real',
  'recourse if the purchase went wrong: consumer protections, a returns process, an accountable',
  'business with something to lose?',
  '',
  'Size is not the test and neither is fame. Micro Center qualifies despite being far smaller',
  'than Walmart. Etsy qualifies because of its buyer protection. Established online-only',
  'retailers such as Redbubble qualify despite having no stores. A storefront like',
  'jeffsgadgets.biz does not qualify, because there is nobody to go to.',
  '',
  'If you are not confident, say so. Being asked about a real retailer costs one message; the',
  'reverse costs money spent somewhere with no way to get it back.',
].join(' ');

/** How a marketplace carries recourse, when the domain is one. */
export type MarketplaceKind =
  /** Not a marketplace. */
  | 'none'
  /** The platform's own buyer protection covers the purchase, the owner's Etsy case. */
  | 'buyer-protection'
  /** Recourse depends on the individual seller, the owner's eBay case. */
  | 'per-seller';

/**
 * The judgement's input. **Exactly one field, on purpose.**
 *
 * Adding anything the merchant can influence re-opens the injection surface
 * this whole design closes. If a future change needs more context, that is a
 * signal to stop, not to widen this type.
 */
export interface MerchantJudgeInput {
  readonly registrableDomain: string;
}

export interface MerchantJudgement {
  readonly qualifies: boolean;
  /**
   * Whether the judge is confident. Anything less resolves to not-major, so an
   * unsure judgement and a negative one have the same effect on spending.
   */
  readonly confident: boolean;
  /**
   * Why, in the judge's own words, a phrase like "buyer protection applies" or
   * "established electronics retailer with a returns process". Rendered to the
   * owner so the notification names the recourse rather than a verdict.
   */
  readonly recourse: string;
  readonly marketplace?: MarketplaceKind | undefined;
}

/** Supplied by the daemon. The SDK owns the criterion and the policy; not the model call. */
export interface MerchantJudgePort {
  judge(input: MerchantJudgeInput): Promise<MerchantJudgement>;
}

export type MarketplacePolicy = 'major' | 'requires-approval' | 'first-party-only';

export interface MerchantPolicy {
  /** Owner additions, authoritative, and theirs alone. */
  readonly additional?: string | undefined;
  /** Owner removals, authoritative. */
  readonly excluded?: string | undefined;
  readonly marketplaces?: MarketplacePolicy | undefined;
  readonly listingThresholds?: MarketplaceListingThresholds | undefined;
}

export interface MerchantIdentity {
  /** The host that TAKES THE CARD. Recourse attaches to this. */
  readonly checkoutHost: string;
  /**
   * Where the item was browsed, when the flow handed off to pay elsewhere.
   *
   * A different registrable domain here breaks the qualification: the
   * protection belonged to the storefront and may not follow the card.
   */
  readonly storefrontHost?: string | undefined;
  readonly saleType?: SaleType | undefined;
  readonly listing?: MarketplaceListing | undefined;
}

export interface MerchantVerdict {
  readonly isMajor: boolean;
  /** Set when the listing itself is refused outright, an auction, say. */
  readonly refused?: boolean | undefined;
  readonly registrable: string | null;
  /** Where the verdict came from, for the audit record. */
  readonly basis: 'owner-override' | 'judgement' | 'unconfident' | 'structural';
  readonly reason: string;
}

/** Parse a comma-separated config value into normalized registrable domains. */
export function parseDomainList(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Apply the marketplace policy, the same question whatever kind of marketplace
 * it is. `unknown` counts as third-party, because the field is page-derived and
 * a hostile listing would simply claim otherwise.
 */
function marketplacePolicyBlock(input: {
  readonly registrable: string;
  readonly policy: MarketplacePolicy;
  readonly saleType: SaleType | undefined;
}): string | null {
  if (input.policy === 'requires-approval') {
    return (
      `${input.registrable} is a marketplace and you have asked to be consulted on marketplace `
      + 'purchases, because who you are actually buying from varies listing to listing.'
    );
  }
  if (input.policy === 'first-party-only' && isThirdPartySale(input.saleType)) {
    const claim = input.saleType === undefined || input.saleType === 'unknown'
      ? 'I could not confirm this is sold by them rather than by a third party'
      : 'this is sold by a third party rather than by them';
    return (
      `${input.registrable} is a marketplace and ${claim}. You have asked to be consulted on `
      + 'those, so I am checking first.'
    );
  }
  return null;
}

/**
 * Decide whether this merchant carries recourse.
 *
 * Precedence, strictest first:
 *   1. checkout left the storefront's domain  → not major (structural)
 *   2. owner exclusion                        → not major (authoritative)
 *   3. owner addition                         → major (authoritative)
 *   4. marketplace policy                     → may block
 *   5. judgement against the profile          → major only if confident AND qualifying
 *   6. anything else                          → not major
 */
export async function classifyMerchant(
  merchant: MerchantIdentity,
  judge: MerchantJudgePort,
  policy: MerchantPolicy = {},
): Promise<MerchantVerdict> {
  const registrable = registrableDomain(merchant.checkoutHost.trim().toLowerCase());
  if (registrable === null) {
    return {
      isMajor: false,
      registrable: null,
      basis: 'structural',
      reason: 'I could not pin down what domain this checkout belongs to, so I am asking first.',
    };
  }

  // 1. Recourse must survive the checkout.
  if (merchant.storefrontHost !== undefined && merchant.storefrontHost.trim().length > 0) {
    const storefront = registrableDomain(merchant.storefrontHost.trim().toLowerCase());
    if (storefront !== null && storefront !== registrable) {
      return {
        isMajor: false,
        registrable,
        basis: 'structural',
        reason:
          `This started on ${storefront} but the payment page is on ${registrable}. Whatever `
          + 'protection came with the storefront may not follow the card to a different company, '
          + 'so I am asking first.',
      };
    }
  }

  // 2 & 3. The owner's explicit instructions beat any judgement, in both directions.
  if (parseDomainList(policy.excluded).includes(registrable)) {
    return {
      isMajor: false,
      registrable,
      basis: 'owner-override',
      reason: `You asked me to always check with you before buying from ${registrable}.`,
    };
  }
  const ownerAdded = parseDomainList(policy.additional).includes(registrable);

  let judgement: MerchantJudgement | null = null;
  if (!ownerAdded) {
    judgement = await judge.judge({ registrableDomain: registrable });
  }

  // 4. Marketplace policy, when the judgement says this is one.
  const marketplaceKind = judgement?.marketplace ?? 'none';
  if (marketplaceKind !== 'none') {
    const blocked = marketplacePolicyBlock({
      registrable,
      policy: policy.marketplaces ?? 'major',
      saleType: merchant.listing?.saleType ?? merchant.saleType,
    });
    if (blocked !== null) {
      return { isMajor: false, registrable, basis: 'judgement', reason: blocked };
    }
  }

  if (ownerAdded) {
    return {
      isMajor: true,
      registrable,
      basis: 'owner-override',
      reason: `${registrable} is one you told me to treat as established.`,
    };
  }

  const verdict = judgement as MerchantJudgement;

  // 5a. eBay-class marketplaces: the domain is necessary, not sufficient.
  if (marketplaceKind === 'per-seller' && verdict.qualifies && verdict.confident) {
    const listing = merchant.listing;
    if (listing === undefined) {
      return {
        isMajor: false,
        registrable,
        basis: 'judgement',
        reason:
          `On ${registrable} the protection depends on the individual seller, and I could not read `
          + 'this listing to check theirs. Asking you first.',
      };
    }
    const listingVerdict = evaluateMarketplaceListing(
      listing,
      policy.listingThresholds ?? DEFAULT_MARKETPLACE_LISTING_THRESHOLDS,
    );
    if (listingVerdict.outcome === 'refuse') {
      return {
        isMajor: false,
        refused: true,
        registrable,
        basis: 'judgement',
        reason: listingVerdict.reason,
      };
    }
    if (listingVerdict.outcome === 'requires-approval') {
      return { isMajor: false, registrable, basis: 'judgement', reason: listingVerdict.reason };
    }
    return {
      isMajor: true,
      registrable,
      basis: 'judgement',
      reason: `${registrable}: ${verdict.recourse}. ${listingVerdict.reason}`,
    };
  }

  // 5b & 6. Everything else rides on the judgement, and uncertainty is a no.
  if (!verdict.confident) {
    return {
      isMajor: false,
      registrable,
      basis: 'unconfident',
      reason:
        `I am not confident enough about ${registrable} to buy without checking, I could not `
        + 'establish what recourse you would have if it went wrong. That is not a mark against '
        + 'them, it just means I ask first.',
    };
  }
  if (!verdict.qualifies) {
    return {
      isMajor: false,
      registrable,
      basis: 'judgement',
      reason:
        `${registrable}: ${verdict.recourse}. That is not a mark against them, it just means I ask `
        + 'before buying rather than assume.',
    };
  }
  return {
    isMajor: true,
    registrable,
    basis: 'judgement',
    reason: `${registrable}: ${verdict.recourse}.`,
  };
}

/**
 * Which window a purchase gets, composing the budget rule with the recourse
 * rule.
 *
 * They compose in the strict direction: **either condition escalates, and
 * nothing downgrades an approval to a veto.** An established retailer buys no
 * leniency on an over-budget purchase.
 */
export function windowForPurchase(input: {
  readonly aboveBudget: boolean;
  readonly merchantIsMajor: boolean;
}): 'approval' | 'veto' {
  if (input.aboveBudget) return 'approval';
  return input.merchantIsMajor ? 'veto' : 'approval';
}

/** Build the policy from daemon config. Overrides stay owner-authored. */
export function merchantPolicyFromConfig(config: {
  readonly majorRetailersAdditional: string;
  readonly majorRetailersExcluded: string;
  readonly ebayMinSellerFeedbackCount: number;
  readonly ebayMinSellerPositivePercent: number;
}): MerchantPolicy {
  return {
    additional: config.majorRetailersAdditional,
    excluded: config.majorRetailersExcluded,
    listingThresholds: {
      minSellerFeedbackCount: config.ebayMinSellerFeedbackCount,
      minSellerPositivePercent: config.ebayMinSellerPositivePercent,
      minAccountAgeDays: DEFAULT_MARKETPLACE_LISTING_THRESHOLDS.minAccountAgeDays,
    },
  };
}
