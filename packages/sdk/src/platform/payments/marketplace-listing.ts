/**
 * marketplace-listing.ts, when a marketplace domain is not enough on its own.
 *
 * ══ The owner's ruling ════════════════════════════════════════════════════
 *
 *   "something of a grey area is Ebay - i would allow buy it now purchases on
 *    Ebay, but only if the seller has a solid reputation from selling, not just
 *    buying"
 *
 * Two conditions, both required, or the listing is not recognised and the
 * owner is asked. This is a **per-listing** determination rather than a per-domain one:
 * ebay.com is necessary and not sufficient, and that shape will fit other
 * marketplaces.
 *
 * ══ Condition 1: fixed price only. Auctions are refused, not downgraded ═══
 *
 * An auction is refused OUTRIGHT, regardless of seller reputation or price, and
 * this is structural rather than a preference.
 *
 * The flow the owner designed is: know the final total → notify them → run the
 * window → pay. An auction has no final total until it ends, so that flow cannot
 * execute at all. Bidding is also an open-ended commitment rather than a
 * purchase, the thing they authorised was buying an item at a price, not entering
 * a contest whose cost is decided later by strangers.
 *
 * The same reasoning covers Best Offer and anything else where the price is not
 * fixed at decision time. `'unknown'` is refused too: a listing type we could not
 * read is one we cannot promise is fixed-price.
 *
 * ══ Condition 2: reputation earned SELLING ════════════════════════════════
 *
 * eBay's headline feedback score combines buying and selling, so a large number
 * can have been earned entirely by buying. The seller-side figures are the ones
 * read: feedback count as a seller, and positive percentage as a seller.
 *
 * ══ Why reading a page here is acceptable, and how it stays safe ══════════
 *
 * Purchase gates must not run on page-derived signals, that is the injection
 * surface the rest of this capability closes. The distinction that makes this
 * one acceptable: the figures are rendered by **eBay**, on a domain already
 * validated, in eBay's own feedback widget, not by the seller, and the
 * security boundary is unchanged, since the checkout is on ebay.com with eBay's
 * buyer protection behind it.
 *
 * It is nonetheless built as a **ratchet**:
 *
 *  - It can only ever make the outcome STRICTER. It can move a listing from
 *    recognised to approval-required and can never move one the other way. No
 *    reputation figure promotes a domain that was not already recognised.
 *  - **Unreadable means not-major.** Missing, ambiguous, an unexpected page
 *    shape, or a number that cannot be attributed specifically to selling, all
 *    fail closed and the owner is asked.
 *  - A figure from a seller-controlled region of the page is not accepted.
 *    Sellers control listing descriptions; they do not control eBay's feedback
 *    widget. **If the region cannot be told apart, the figure is unreadable.**
 *
 * The worst case a hostile listing can achieve is being sent for the owner's
 * approval, which is where an unrecognised seller was going anyway.
 */

/** Where on the page a figure was found. Anything seller-controlled is refused. */
export type FigureRegion =
  /** eBay's own feedback widget, the only region whose numbers are accepted. */
  | 'platform-widget'
  /** The seller's listing description or storefront copy. */
  | 'seller-controlled'
  /** The region could not be determined, which is treated as unreadable. */
  | 'unknown';

export type ListingSaleFormat = 'fixed-price' | 'auction' | 'best-offer' | 'unknown';

/**
 * Who is actually selling: the marketplace itself, or a third party trading on
 * it.
 *
 * `'unknown'` is the honest default and is treated as `'third-party'` wherever
 * the distinction gates anything. `saleType` is read off the page, so a hostile
 * listing would simply claim to be first-party, the strict default is what
 * stops that claim from buying leniency. Turning on a policy that trusts this
 * field requires it to come from a trusted extractor rather than page text.
 */
export type SaleType = 'first-party' | 'third-party' | 'unknown';

/** True unless the sale is confidently the marketplace's own. */
export function isThirdPartySale(saleType: SaleType | undefined): boolean {
  return (saleType ?? 'unknown') !== 'first-party';
}

/** Seller-side reputation, as read from the platform's own widget. */
export interface SellerReputation {
  /** Feedback ratings earned AS A SELLER, not the combined headline score. */
  readonly sellerFeedbackCount: number | null;
  /** Positive percentage AS A SELLER. */
  readonly sellerPositivePercent: number | null;
  /** Account age in days, when the platform exposes it reliably. */
  readonly accountAgeDays?: number | null | undefined;
  readonly region: FigureRegion;
}

export interface MarketplaceListing {
  readonly format: ListingSaleFormat;
  readonly reputation?: SellerReputation | undefined;
  /**
   * Whether the marketplace or a third party is selling.
   *
   * Modelled here, with the checkout domain and the seller identity, so that
   * flipping marketplaces to approval-required, or splitting first-party from
   * third-party sales, is a CONFIGURATION edit rather than a rewrite.
   */
  readonly saleType?: SaleType | undefined;
  /**
   * The seller's name as the listing gives it.
   *
   * Page-derived and therefore untrusted: carried for the audit record, never
   * used to infer majorness, and never rendered raw into a notification (see
   * security/notice-text.ts).
   */
  readonly sellerIdentity?: string | undefined;
}

export interface MarketplaceListingThresholds {
  readonly minSellerFeedbackCount: number;
  readonly minSellerPositivePercent: number;
  /**
   * Minimum account age, or null to not require one.
   *
   * Defaults to null: eBay does not expose a member-since date in a place that
   * can be read reliably and attributed with confidence, and a threshold that
   * silently fails closed on every listing would make the whole eBay path
   * unusable while looking like a working check. Reported rather than guessed,
   * see the note in the payments design doc.
   */
  readonly minAccountAgeDays: number | null;
}

/** The owner's stated defaults. All configurable. */
export const DEFAULT_MARKETPLACE_LISTING_THRESHOLDS: MarketplaceListingThresholds = {
  minSellerFeedbackCount: 100,
  minSellerPositivePercent: 98,
  minAccountAgeDays: null,
};

export type ListingVerdictOutcome =
  /** Refused outright, no window, no approval path. */
  | 'refuse'
  /** Qualifies; the domain's own verdict stands. */
  | 'qualifies'
  /** Does not qualify; escalate to the approval window. */
  | 'requires-approval';

export interface MarketplaceListingVerdict {
  readonly outcome: ListingVerdictOutcome;
  /** Stated for the notification, so the owner sees the reasoning and not just a verdict. */
  readonly reason: string;
}

function readable(reputation: SellerReputation | undefined): boolean {
  if (reputation === undefined) return false;
  // Only the platform's own widget counts. Seller-controlled and undetermined
  // regions are both unreadable, if we cannot tell them apart, we do not guess.
  if (reputation.region !== 'platform-widget') return false;
  if (reputation.sellerFeedbackCount === null) return false;
  if (reputation.sellerPositivePercent === null) return false;
  if (!Number.isFinite(reputation.sellerFeedbackCount)) return false;
  if (!Number.isFinite(reputation.sellerPositivePercent)) return false;
  return true;
}

/**
 * Evaluate one marketplace listing.
 *
 * Returns `'refuse'` for an auction, terminal, before any reputation question
 * is asked, because no reputation makes an open-ended commitment into a purchase
 * with a knowable total.
 */
export function evaluateMarketplaceListing(
  listing: MarketplaceListing,
  thresholds: MarketplaceListingThresholds = DEFAULT_MARKETPLACE_LISTING_THRESHOLDS,
): MarketplaceListingVerdict {
  if (listing.format === 'auction') {
    return {
      outcome: 'refuse',
      reason:
        'This is an auction, so I will not bid on it. There is no final price until it ends, which '
        + 'means I cannot show you the total and wait before paying, and bidding commits you to '
        + 'something open-ended rather than buying an item at a price.',
    };
  }
  if (listing.format === 'best-offer') {
    return {
      outcome: 'refuse',
      reason:
        'This is a Best Offer listing, so the price is not fixed at the point I would decide. I only '
        + 'buy at a price I can show you first.',
    };
  }
  if (listing.format !== 'fixed-price') {
    return {
      outcome: 'refuse',
      reason:
        'I could not confirm this is a fixed-price listing, so I am not buying it. If the price is '
        + 'not settled before I decide, I cannot show you what you would be charged.',
    };
  }

  const reputation = listing.reputation;
  if (!readable(reputation)) {
    const detail = reputation === undefined
      ? 'I could not find the seller feedback at all'
      : reputation.region === 'seller-controlled'
        ? 'the only feedback numbers I found were in the seller\'s own listing text, which they write themselves'
        : reputation.region === 'unknown'
          ? 'I could not tell whether the feedback numbers came from eBay or from the seller\'s own text'
          : 'the seller-side feedback figures were missing or unclear';
    return {
      outcome: 'requires-approval',
      reason: `${detail}, so I cannot confirm this seller's selling record. Asking you first.`,
    };
  }

  const count = reputation?.sellerFeedbackCount ?? 0;
  const percent = reputation?.sellerPositivePercent ?? 0;
  const failures: string[] = [];
  if (count < thresholds.minSellerFeedbackCount) {
    failures.push(`${count} seller ratings (below ${thresholds.minSellerFeedbackCount})`);
  }
  if (percent < thresholds.minSellerPositivePercent) {
    failures.push(`${percent}% positive as a seller (below ${thresholds.minSellerPositivePercent}%)`);
  }
  if (thresholds.minAccountAgeDays !== null) {
    const age = reputation?.accountAgeDays;
    if (age === null || age === undefined || !Number.isFinite(age)) {
      failures.push('account age could not be read');
    } else if (age < thresholds.minAccountAgeDays) {
      failures.push(`account ${age} days old (below ${thresholds.minAccountAgeDays})`);
    }
  }

  if (failures.length > 0) {
    return {
      outcome: 'requires-approval',
      reason: `This seller does not meet your bar: ${failures.join(', ')}. Asking you first.`,
    };
  }

  return {
    outcome: 'qualifies',
    reason:
      `Buy It Now from a seller with ${count} seller ratings at ${percent}% positive, which meets `
      + 'your bar.',
  };
}
