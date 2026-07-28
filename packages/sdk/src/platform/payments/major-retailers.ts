/**
 * major-retailers.ts — is there a real path to remedy if this goes wrong?
 *
 * ══ The principle, in his words ═══════════════════════════════════════════
 *
 *   "even etsy is fine, mainly because they have consumer protections. so yeah,
 *    use judgement in situations like ebay, try to buy from established
 *    retailers -- even established online-only retailers like redbubble etc, but
 *    be wary of storefronts like jeffsgadgets.biz"
 *
 * **The organizing principle is RECOURSE, not recognisability.** Recognisability
 * was the proxy; this is the thing it was standing in for. A merchant qualifies
 * when there is a real path to remedy if the purchase goes wrong — platform
 * buyer protection, an established returns process, an accountable business with
 * something to lose.
 *
 * `jeffsgadgets.biz` fails not because it is small or obscure but because **there
 * is nobody to go to.** Micro Center qualifies at two dozen stores, and Redbubble
 * qualifies with no stores at all, because both are real businesses with real
 * policies. Size and physical presence are irrelevant except as weak evidence.
 *
 * His earlier framings, which this supersedes without contradicting:
 *
 *   "if the place we're buying isn't what the average person would consider a
 *    major retailer, silence means denial of purchase"
 *   "even smaller specialty retailers like microcenter would be considered
 *    major, unlike something like www.jeffsgadgets.biz"
 *
 * ══ Which window, and what silence means ══════════════════════════════════
 *
 *   RECOURSE ESTABLISHED → VETO window.     Silence PROCEEDS.
 *   Anything else        → APPROVAL window. Silence DENIES.
 *
 * One notification either way, sent once, when the item is chosen and the final
 * total is known. The merchant only changes what silence means, and the message
 * **names the recourse** rather than citing a list — "Etsy, buyer protection
 * applies" is a reason he can weigh; "on your approved list" sends him off to
 * check a list.
 *
 * ══ Where "use judgement" lives — and it is NOT at runtime ════════════════
 *
 * This must never become a model deciding at purchase time whether a storefront
 * looks legitimate. Page-derived legitimacy signals are exactly the injection
 * surface the rest of this capability closes, and a site built to look
 * trustworthy is the easiest thing in the world to produce.
 *
 * **The judgement is exercised when the list is CURATED**, and recorded as data.
 * At runtime this is a lookup. Each entry carries WHY it qualifies, so the
 * judgement is reviewable rather than re-derived, and so the notification can
 * name the actual recourse.
 *
 * ══ Ambiguity fails, on purpose ═══════════════════════════════════════════
 *
 * **Default to not-major.** A longer list does not make a more permissive one:
 * everything outside it asks him. There is no benefit of the doubt, because the
 * fallback is not refusal — it is asking. Treating a real retailer as
 * unqualified costs one message he answers; the reverse costs money spent
 * somewhere with no way to get it back.
 *
 * ══ Recourse must survive the checkout ════════════════════════════════════
 *
 * Matching is on the **validated registrable domain that takes the card**. If an
 * established retailer's flow hands off to a payment page on an unrelated
 * registrable domain, the protection the qualification rested on may not follow
 * it — so that is not-major, and the notification says why.
 */
import { registrableDomain } from '../security/public-suffix.js';
import {
  DEFAULT_MARKETPLACE_LISTING_THRESHOLDS,
  evaluateMarketplaceListing,
  type MarketplaceListing,
  type MarketplaceListingThresholds,
} from './marketplace-listing.js';

/**
 * Why an entry qualifies. Carried so the notification can be specific and so a
 * later reader understands the list rather than treating it as arbitrary
 * strings.
 */
export type RetailerQualifier =
  /** Large general retailer: established returns process, real corporate presence. */
  | 'national-chain'
  /** Established in its category — his Micro Center case. Small, and accountable. */
  | 'specialty-retailer'
  /** Established with no physical stores — his Redbubble case. Recourse is the policies, not the premises. */
  | 'online-only-retailer'
  /** Marketplace whose own buyer protection covers the purchase — his Etsy case. Major outright. */
  | 'marketplace-buyer-protection'
  /** Marketplace where recourse depends on the specific seller — his eBay case. Per-listing conditions apply. */
  | 'marketplace-per-seller';

export interface RetailerEntry {
  readonly domain: string;
  readonly qualifier: RetailerQualifier;
}

/**
 * A starting point for the standard, not an authority.
 *
 * Being absent is not a judgement about a seller — it only means we ask first.
 */
export const DEFAULT_RECOGNISED_RETAILERS: readonly RetailerEntry[] = [
  // National general retailers.
  { domain: 'amazon.com', qualifier: 'national-chain' },
  { domain: 'walmart.com', qualifier: 'national-chain' },
  { domain: 'target.com', qualifier: 'national-chain' },
  { domain: 'bestbuy.com', qualifier: 'national-chain' },
  { domain: 'costco.com', qualifier: 'national-chain' },
  { domain: 'homedepot.com', qualifier: 'national-chain' },
  { domain: 'lowes.com', qualifier: 'national-chain' },
  { domain: 'apple.com', qualifier: 'national-chain' },
  { domain: 'ikea.com', qualifier: 'national-chain' },
  { domain: 'nordstrom.com', qualifier: 'national-chain' },
  { domain: 'staples.com', qualifier: 'national-chain' },
  { domain: 'officedepot.com', qualifier: 'national-chain' },

  // Established category specialists — the Micro Center class.
  { domain: 'microcenter.com', qualifier: 'specialty-retailer' },
  { domain: 'newegg.com', qualifier: 'specialty-retailer' },
  { domain: 'bhphotovideo.com', qualifier: 'specialty-retailer' },
  { domain: 'adorama.com', qualifier: 'specialty-retailer' },
  { domain: 'sweetwater.com', qualifier: 'specialty-retailer' },
  { domain: 'crutchfield.com', qualifier: 'specialty-retailer' },
  { domain: 'guitarcenter.com', qualifier: 'specialty-retailer' },
  { domain: 'rei.com', qualifier: 'specialty-retailer' },
  { domain: 'chewy.com', qualifier: 'specialty-retailer' },
  { domain: 'zappos.com', qualifier: 'specialty-retailer' },
  { domain: 'wayfair.com', qualifier: 'specialty-retailer' },
  { domain: 'gamestop.com', qualifier: 'specialty-retailer' },
  { domain: 'barnesandnoble.com', qualifier: 'specialty-retailer' },
  { domain: 'dickssportinggoods.com', qualifier: 'specialty-retailer' },
  { domain: 'basspro.com', qualifier: 'specialty-retailer' },
  { domain: 'acehardware.com', qualifier: 'specialty-retailer' },
  { domain: 'tractorsupply.com', qualifier: 'specialty-retailer' },
  { domain: 'petco.com', qualifier: 'specialty-retailer' },
  { domain: 'sephora.com', qualifier: 'specialty-retailer' },
  { domain: 'ulta.com', qualifier: 'specialty-retailer' },
  { domain: 'patagonia.com', qualifier: 'specialty-retailer' },
  { domain: 'uline.com', qualifier: 'specialty-retailer' },
  { domain: 'mcmaster.com', qualifier: 'specialty-retailer' },
  { domain: 'digikey.com', qualifier: 'specialty-retailer' },
  { domain: 'mouser.com', qualifier: 'specialty-retailer' },

  // Established online-only — no stores, real policies. His Redbubble case.
  { domain: 'redbubble.com', qualifier: 'online-only-retailer' },
  { domain: 'backcountry.com', qualifier: 'online-only-retailer' },
  { domain: 'thomann.de', qualifier: 'online-only-retailer' },
  { domain: 'monoprice.com', qualifier: 'online-only-retailer' },
  { domain: 'ubuy.com', qualifier: 'online-only-retailer' },

  // Marketplaces whose own buyer protection carries the recourse. Major
  // outright — his ruling on Etsy, and Amazon Marketplace follows the same
  // reasoning since amazon.com holds the payment and the protection.
  { domain: 'etsy.com', qualifier: 'marketplace-buyer-protection' },

  // Marketplace where recourse depends on the seller. His eBay ruling: Buy It
  // Now only, never auctions, and a real SELLING record. See
  // marketplace-listing.ts.
  { domain: 'ebay.com', qualifier: 'marketplace-per-seller' },
];

/**
 * How a sale is fulfilled, where the checkout makes it knowable.
 *
 * `'unknown'` is the honest default and is treated as the STRICTER case
 * wherever the distinction is used — see `MarketplacePolicy`.
 */
export type SaleType = 'first-party' | 'third-party' | 'unknown';

/**
 * The merchant, modelled so marketplace policy is a configuration edit rather
 * than a rewrite.
 *
 * `sellerIdentity` is page-derived and therefore untrusted: it is carried for
 * the audit record and for policy that the owner opts into, and it is NEVER
 * rendered raw into a notification (see `security/notice-text.ts`) and never
 * used to infer majorness.
 */
export interface MerchantIdentity {
  /** The host that TAKES THE CARD. This is what recourse attaches to. */
  readonly checkoutHost: string;
  /**
   * Where the item was browsed, when the flow handed off to pay elsewhere.
   *
   * If this reduces to a different registrable domain than `checkoutHost`, the
   * qualification breaks: the protection belonged to the storefront and may not
   * follow the card to an unrelated payment domain.
   */
  readonly storefrontHost?: string | undefined;
  readonly sellerIdentity?: string | undefined;
  readonly saleType?: SaleType | undefined;
  /**
   * The specific listing, on marketplaces where majorness is per-listing rather
   * than per-domain.
   *
   * eBay is the ruled case: the domain is necessary and not sufficient, and the
   * listing must be fixed-price from a seller with a real SELLING record. See
   * marketplace-listing.ts.
   */
  readonly listing?: MarketplaceListing | undefined;
}

/**
 * What a marketplace sale gets.
 *
 * ── The open question ─────────────────────────────────────────────────────
 *
 * On ebay.com, etsy.com or Amazon Marketplace the checkout domain is a
 * household name while the actual seller is anonymous. Pure domain matching
 * calls every one of them recognised, so an unknown eBay seller would proceed on
 * silence — arguably much closer to `jeffsgadgets.biz` than to Micro Center.
 *
 * **Built as `'major'` for now**, on the reasoning that the card goes to the
 * marketplace and the recourse sits with the marketplace, which is the
 * accountability the rule is reaching for. The question is with the owner.
 *
 * ── If he flips it ────────────────────────────────────────────────────────
 *
 * `'requires-approval'` makes every marketplace sale ask him;
 * `'first-party-only'` recognises the marketplace's own sales and asks about
 * third-party ones. Both are policy edits here rather than new code.
 *
 * **Note the trap if that day comes:** `saleType` is read off the page, so a
 * hostile listing would simply claim `'first-party'`. That is why `'unknown'`
 * counts as third-party, and why turning on `'first-party-only'` requires the
 * saleType to come from a trusted extractor rather than page text. Until then
 * the field is carried and not trusted.
 */
export type MarketplacePolicy = 'major' | 'requires-approval' | 'first-party-only';

export interface MajorRetailerPolicy {
  /** Owner additions, from `payments.majorRetailers.additional`. */
  readonly additional?: string | undefined;
  /** Owner removals, from `payments.majorRetailers.excluded`. */
  readonly excluded?: string | undefined;
  /** Default `'major'`, pending the owner's ruling. */
  readonly marketplaces?: MarketplacePolicy | undefined;
  /** Per-listing bar for marketplaces that carry one. */
  readonly listingThresholds?: MarketplaceListingThresholds | undefined;
}

/** Parse a comma-separated config value into normalized domains. */
export function parseRetailerList(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * The effective list: shipped defaults, plus his additions, minus his removals.
 *
 * An owner addition carries the `specialty-retailer` qualifier — he is
 * asserting the recognition the standard asks for, and nothing about his
 * addition claims marketplace semantics.
 */
export function resolveRecognisedRetailers(
  policy: MajorRetailerPolicy = {},
): ReadonlyMap<string, RetailerQualifier> {
  const excluded = new Set(parseRetailerList(policy.excluded));
  const effective = new Map<string, RetailerQualifier>();
  for (const entry of DEFAULT_RECOGNISED_RETAILERS) {
    if (!excluded.has(entry.domain)) effective.set(entry.domain, entry.qualifier);
  }
  // An addition beats a removal: listing a domain in both is a contradiction,
  // and the addition is the more specific instruction.
  for (const domain of parseRetailerList(policy.additional)) {
    effective.set(domain, 'specialty-retailer');
  }
  return effective;
}

export interface MajorRetailerVerdict {
  readonly isMajor: boolean;
  /**
   * Set when the listing itself is refused outright — an auction, a Best Offer,
   * or a format we could not confirm as fixed-price. Distinct from `isMajor:
   * false`, which only means "ask him first".
   */
  readonly refused?: boolean | undefined;
  /** The registrable domain the decision was made on, for the audit record. */
  readonly registrable: string | null;
  readonly qualifier: RetailerQualifier | null;
  /**
   * Why, phrased for the owner.
   *
   * A not-recognised verdict must read as a CHECKPOINT rather than an
   * accusation. He may well want to buy there; all we are saying is that it is
   * not on his list, so we ask instead of assuming.
   */
  readonly reason: string;
}

/**
 * Would the average person recognise the business taking this card?
 *
 * Takes the validated checkout host — never a page title, a seller name, or
 * anything a merchant writes.
 */
export function classifyMerchant(
  merchant: MerchantIdentity,
  policy: MajorRetailerPolicy = {},
): MajorRetailerVerdict {
  const registrable = registrableDomain(merchant.checkoutHost.trim().toLowerCase());
  if (registrable === null) {
    return {
      isMajor: false,
      registrable: null,
      qualifier: null,
      reason: 'I could not pin down what domain this checkout belongs to, so I am asking first.',
    };
  }

  // Recourse must survive the checkout. An established storefront that hands
  // off to an unrelated payment domain no longer carries the protection the
  // qualification rested on.
  if (merchant.storefrontHost !== undefined && merchant.storefrontHost.trim().length > 0) {
    const storefront = registrableDomain(merchant.storefrontHost.trim().toLowerCase());
    if (storefront !== null && storefront !== registrable) {
      return {
        isMajor: false,
        registrable,
        qualifier: null,
        reason:
          `This started on ${storefront} but the payment page is on ${registrable}. Whatever `
          + 'protection came with the storefront may not follow the card to a different company, '
          + 'so I am asking first.',
      };
    }
  }

  const qualifier = resolveRecognisedRetailers(policy).get(registrable) ?? null;
  if (qualifier === null) {
    return {
      isMajor: false,
      registrable,
      qualifier: null,
      reason:
        `I do not know what recourse you would have with ${registrable} if this went wrong — no `
        + 'buyer protection or returns process I can point to. That is not a mark against them, '
        + 'it just means I ask before buying rather than assume.',
    };
  }

  if (qualifier === 'marketplace-per-seller') {
    const marketplaces = policy.marketplaces ?? 'major';
    if (marketplaces === 'requires-approval') {
      return {
        isMajor: false,
        registrable,
        qualifier,
        reason:
          `${registrable} is a marketplace and you have asked to be consulted on marketplace `
          + 'purchases, because the recourse depends on who the seller is.',
      };
    }
    const listing = merchant.listing;
    if (listing === undefined) {
      return {
        isMajor: false,
        registrable,
        qualifier,
        reason:
          `On ${registrable} the protection depends on the individual seller, and I could not read `
          + 'this listing to check theirs. Asking you first.',
      };
    }
    const verdict = evaluateMarketplaceListing(
      listing,
      policy.listingThresholds ?? DEFAULT_MARKETPLACE_LISTING_THRESHOLDS,
    );
    if (verdict.outcome === 'refuse') {
      return { isMajor: false, refused: true, registrable, qualifier, reason: verdict.reason };
    }
    if (verdict.outcome === 'requires-approval') {
      return { isMajor: false, registrable, qualifier, reason: verdict.reason };
    }
    return {
      isMajor: true,
      registrable,
      qualifier,
      reason: `${registrable}, buyer protection applies. ${verdict.reason}`,
    };
  }

  if (qualifier === 'marketplace-buyer-protection') {
    return {
      isMajor: true,
      registrable,
      qualifier,
      reason: `${registrable}, buyer protection applies — they hold the payment and the dispute.`,
    };
  }

  const recourse = qualifier === 'national-chain'
    ? 'an established retailer with a real returns process'
    : qualifier === 'online-only-retailer'
      ? 'an established online retailer with real policies behind it'
      : 'an established retailer in its field, with a reputation and a returns process';
  return { isMajor: true, registrable, qualifier, reason: `${registrable} is ${recourse}.` };
}

/**
 * Which window a purchase gets, composing the budget rule with the recognition
 * rule.
 *
 * Above budget is already an approval by his earlier ruling; a merchant that
 * fails the recognition test is an approval by this one. They compose in the
 * strict direction: **either condition escalates, and nothing downgrades an
 * approval to a veto.** A recognised retailer buys no leniency on an
 * over-budget purchase.
 */
export function windowForPurchase(input: {
  readonly aboveBudget: boolean;
  readonly merchantIsMajor: boolean;
}): 'approval' | 'veto' {
  if (input.aboveBudget) return 'approval';
  return input.merchantIsMajor ? 'veto' : 'approval';
}
