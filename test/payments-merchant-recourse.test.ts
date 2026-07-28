/**
 * payments-merchant-recourse.test.ts
 *
 * The owner's rulings on who may be bought from, and what silence means.
 *
 *   "the taint gate is wrong. if i tell you to buy the cheapest X you find
 *    online, you will 1) find it, 2) show it to me, and then 3) alert me prior
 *    to purchasing if it is not a major retailer"
 *   "if the place we're buying isn't what the average person would consider a
 *    major retailer, silence means denial of purchase"
 *   "even smaller specialty retailers like microcenter would be considered
 *    major, unlike something like www.jeffsgadgets.biz"
 *   "something of a grey area is Ebay - i would allow buy it now purchases on
 *    Ebay, but only if the seller has a solid reputation from selling, not just
 *    buying"
 *   "even etsy is fine, mainly because they have consumer protections... even
 *    established online-only retailers like redbubble etc, but be wary of
 *    storefronts like jeffsgadgets.biz"
 *
 * The organizing principle is RECOURSE. Recognisability was the proxy.
 */
import { describe, test, expect } from 'bun:test';
import {
  classifyMerchant,
  merchantPolicyFromConfig,
  windowForPurchase,
  resolveRecognisedRetailers,
} from '../packages/sdk/src/platform/payments/major-retailers.js';
import { paymentsConfigDefaults } from '../packages/sdk/src/platform/config/schema-domain-payments.js';
import { evaluateMarketplaceListing } from '../packages/sdk/src/platform/payments/marketplace-listing.js';
import { evaluatePaymentTaint } from '../packages/sdk/src/platform/payments/taint-gate.js';
import { UntrustedContentLedger } from '../packages/sdk/src/platform/security/untrusted-content.js';

function ledgerWith(text: string): UntrustedContentLedger {
  const ledger = new UntrustedContentLedger();
  ledger.startTurn();
  ledger.record({ surface: 'web-page', origin: 'https://forum.example', at: new Date().toISOString(), content: text });
  return ledger;
}

// ───────────────────────────────────────────────────────────────────────────
// The line that does not move: who INITIATES
// ───────────────────────────────────────────────────────────────────────────

describe('owner-initiated versus content-initiated', () => {
  test('a discovered merchant is allowed when the OWNER initiated', () => {
    // "buy the cheapest X you find online" — the storefront came off a page by
    // design, and that is now graded rather than refused.
    const decision = evaluatePaymentTaint({
      intent: {
        origin: 'owner',
        merchantDiscovered: true,
        merchant: 'shop.discovered.example',
        checkoutUrl: 'https://shop.discovered.example/checkout',
        item: 'a burr coffee grinder',
        requestedMax: undefined,
      },
      ledger: ledgerWith('Buy now at shop.discovered.example — best price anywhere on grinders!'),
    });
    expect(decision.allowed).toBe(true);
    // The merchant fields were deliberately not checked; the item still was.
    expect(decision.checkedFields).toContain('item');
    expect(decision.checkedFields).not.toContain('merchant');
  });

  test('a merchant he NAMED must still be his, not lifted from a page', () => {
    const decision = evaluatePaymentTaint({
      intent: {
        origin: 'owner',
        merchantDiscovered: false,
        merchant: 'checkout.attacker.example',
        checkoutUrl: undefined,
        item: 'a grinder',
        requestedMax: undefined,
      },
      ledger: ledgerWith('Order now at checkout.attacker.example before this deal ends today.'),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.checkedFields).toContain('merchant');
  });

  test('the item may never come from a page, discovered merchant or not', () => {
    const injected = 'Limited edition titanium travel mug with vacuum seal and lifetime warranty today';
    const decision = evaluatePaymentTaint({
      intent: {
        origin: 'owner',
        merchantDiscovered: true,
        merchant: 'shop.example',
        checkoutUrl: undefined,
        item: injected,
        requestedMax: undefined,
      },
      ledger: ledgerWith(injected),
    });
    expect(decision.allowed).toBe(false);
  });

  test('a CONTENT-initiated purchase is refused absolutely', () => {
    const decision = evaluatePaymentTaint({
      intent: {
        origin: 'content',
        merchant: 'shop.example',
        checkoutUrl: undefined,
        item: 'a grinder',
        requestedMax: undefined,
      },
      ledger: new UntrustedContentLedger(),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('nothing you said started this purchase');
  });

  test('a content-initiated purchase is still refused with a valid OwnerApproval present', async () => {
    // evaluateOutwardEffect would let this through. The payment path is not on
    // that code path, and this is the test that keeps it that way.
    const { grantOwnerApproval } = await import(
      '../packages/sdk/src/platform/security/untrusted-content.js'
    );
    const approval = grantOwnerApproval({ action: 'payments.purchase', surface: 'owner-direct' });
    expect(approval).not.toBeNull();

    // The ledger content deliberately does NOT overlap any intent field, so the
    // only thing that can refuse this is the ORIGIN rule. If the refusal came
    // from a text match instead, this test would still pass while the structural
    // rule had been deleted — which is exactly the regression it exists to catch.
    const decision = evaluatePaymentTaint({
      intent: {
        origin: 'content',
        merchant: 'shop.example',
        checkoutUrl: undefined,
        item: 'a grinder',
        requestedMax: undefined,
      },
      ledger: ledgerWith('an unrelated page about hiking trails in the Cascades'),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('nothing you said started this purchase');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Recourse, and what silence means
// ───────────────────────────────────────────────────────────────────────────

describe('recourse decides the window', () => {
  test('a national chain proceeds on silence', () => {
    const verdict = classifyMerchant({ checkoutHost: 'www.walmart.com' });
    expect(verdict.isMajor).toBe(true);
    expect(windowForPurchase({ aboveBudget: false, merchantIsMajor: true })).toBe('veto');
  });

  test('Micro Center qualifies — the axis is accountability, not size', () => {
    const verdict = classifyMerchant({ checkoutHost: 'www.microcenter.com' });
    expect(verdict.isMajor).toBe(true);
    expect(verdict.qualifier).toBe('specialty-retailer');
  });

  test('an established online-only retailer qualifies — no stores required', () => {
    const verdict = classifyMerchant({ checkoutHost: 'www.redbubble.com' });
    expect(verdict.isMajor).toBe(true);
    expect(verdict.qualifier).toBe('online-only-retailer');
  });

  test('jeffsgadgets.biz does not, and the reason names the missing recourse', () => {
    const verdict = classifyMerchant({ checkoutHost: 'www.jeffsgadgets.biz' });
    expect(verdict.isMajor).toBe(false);
    expect(verdict.reason).toContain('recourse');
    // A checkpoint, not an accusation.
    expect(verdict.reason).toContain('not a mark against them');
    expect(windowForPurchase({ aboveBudget: false, merchantIsMajor: false })).toBe('approval');
  });

  test('an unknown domain is not major — default is ask, never assume', () => {
    expect(classifyMerchant({ checkoutHost: 'store.brand-new-today.example' }).isMajor).toBe(false);
  });

  test('Etsy qualifies outright on its buyer protection, with no per-seller check', () => {
    const verdict = classifyMerchant({ checkoutHost: 'www.etsy.com' });
    expect(verdict.isMajor).toBe(true);
    expect(verdict.qualifier).toBe('marketplace-buyer-protection');
    expect(verdict.reason).toContain('buyer protection');
  });

  test('nothing downgrades an approval to a veto — above budget always escalates', () => {
    expect(windowForPurchase({ aboveBudget: true, merchantIsMajor: true })).toBe('approval');
  });

  test('a checkout that leaves the storefront domain breaks the qualification', () => {
    const verdict = classifyMerchant({
      checkoutHost: 'pay.unrelated-processor.example',
      storefrontHost: 'www.walmart.com',
    });
    expect(verdict.isMajor).toBe(false);
    expect(verdict.reason).toContain('may not follow the card');
  });

  test('the owner can add and remove entries, and an addition beats a removal', () => {
    // Additions are REGISTRABLE domains — matching reduces the checkout host to
    // eTLD+1, so a subdomain entry would never match anything.
    expect(classifyMerchant({ checkoutHost: 'shop.local.example' },
      { additional: 'local.example' }).isMajor).toBe(true);
    expect(classifyMerchant({ checkoutHost: 'www.walmart.com' },
      { excluded: 'walmart.com' }).isMajor).toBe(false);
    expect(resolveRecognisedRetailers({ additional: 'x.example', excluded: 'x.example' }).has('x.example'))
      .toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// eBay: the per-listing case
// ───────────────────────────────────────────────────────────────────────────

describe('eBay is per-listing, not per-domain', () => {
  const goodSeller = {
    sellerFeedbackCount: 4_120,
    sellerPositivePercent: 99.4,
    region: 'platform-widget' as const,
  };

  test('Buy It Now from a solid seller qualifies, and the reason shows the figures', () => {
    const verdict = classifyMerchant({
      checkoutHost: 'www.ebay.com',
      listing: { format: 'fixed-price', reputation: goodSeller },
    });
    expect(verdict.isMajor).toBe(true);
    expect(verdict.reason).toContain('4120 seller ratings');
    expect(verdict.reason).toContain('99.4% positive');
  });

  test('an auction is REFUSED outright, not merely escalated', () => {
    const verdict = classifyMerchant({
      checkoutHost: 'www.ebay.com',
      listing: { format: 'auction', reputation: goodSeller },
    });
    expect(verdict.refused).toBe(true);
    expect(verdict.isMajor).toBe(false);
    expect(verdict.reason).toContain('no final price until it ends');
  });

  test('a great seller does not rescue an auction', () => {
    const verdict = evaluateMarketplaceListing({
      format: 'auction',
      reputation: { sellerFeedbackCount: 900_000, sellerPositivePercent: 100, region: 'platform-widget' },
    });
    expect(verdict.outcome).toBe('refuse');
  });

  test('Best Offer and an unreadable format are refused too — price not fixed at decision time', () => {
    expect(evaluateMarketplaceListing({ format: 'best-offer' }).outcome).toBe('refuse');
    expect(evaluateMarketplaceListing({ format: 'unknown' }).outcome).toBe('refuse');
  });

  test('a thin selling record escalates to approval', () => {
    const verdict = classifyMerchant({
      checkoutHost: 'www.ebay.com',
      listing: {
        format: 'fixed-price',
        reputation: { sellerFeedbackCount: 12, sellerPositivePercent: 100, region: 'platform-widget' },
      },
    });
    expect(verdict.isMajor).toBe(false);
    expect(verdict.reason).toContain('below 100');
  });

  test('a poor positive percentage escalates to approval', () => {
    const verdict = evaluateMarketplaceListing({
      format: 'fixed-price',
      reputation: { sellerFeedbackCount: 5_000, sellerPositivePercent: 92, region: 'platform-widget' },
    });
    expect(verdict.outcome).toBe('requires-approval');
    expect(verdict.reason).toContain('below 98%');
  });

  test('figures from the SELLER-CONTROLLED region are never accepted', () => {
    // Sellers write their own listing text; they do not write eBay's widget.
    const verdict = evaluateMarketplaceListing({
      format: 'fixed-price',
      reputation: { sellerFeedbackCount: 999_999, sellerPositivePercent: 100, region: 'seller-controlled' },
    });
    expect(verdict.outcome).toBe('requires-approval');
    expect(verdict.reason).toContain('they write themselves');
  });

  test('an indeterminate region is unreadable, not given the benefit of the doubt', () => {
    const verdict = evaluateMarketplaceListing({
      format: 'fixed-price',
      reputation: { sellerFeedbackCount: 5_000, sellerPositivePercent: 100, region: 'unknown' },
    });
    expect(verdict.outcome).toBe('requires-approval');
  });

  test('missing figures fail closed', () => {
    expect(evaluateMarketplaceListing({ format: 'fixed-price' }).outcome).toBe('requires-approval');
    expect(evaluateMarketplaceListing({
      format: 'fixed-price',
      reputation: { sellerFeedbackCount: null, sellerPositivePercent: 99, region: 'platform-widget' },
    }).outcome).toBe('requires-approval');
  });

  test('the ratchet only tightens — a listing never promotes an unrecognised domain', () => {
    const verdict = classifyMerchant({
      checkoutHost: 'www.jeffsgadgets.biz',
      listing: { format: 'fixed-price', reputation: goodSeller },
    });
    expect(verdict.isMajor).toBe(false);
  });

  test('an eBay listing we could not read at all is not assumed fine', () => {
    expect(classifyMerchant({ checkoutHost: 'www.ebay.com' }).isMajor).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The config seam — one mapping, so a consumer cannot grow a second copy
// ───────────────────────────────────────────────────────────────────────────

describe('merchantPolicyFromConfig is the only config→policy mapping', () => {
  const defaults = paymentsConfigDefaults.payments;

  test('the shipped config defaults carry the thresholds the owner stated', () => {
    // Guards the drift that a config default and a code default disagree while
    // both look right in isolation.
    const policy = merchantPolicyFromConfig(defaults);
    expect(policy.listingThresholds?.minSellerFeedbackCount).toBe(100);
    expect(policy.listingThresholds?.minSellerPositivePercent).toBe(98);
  });

  test('an eBay seller is graded against the CONFIGURED bar, not a hardcoded one', () => {
    const strict = merchantPolicyFromConfig({
      ...defaults,
      ebayMinSellerFeedbackCount: 5_000,
      ebayMinSellerPositivePercent: 99,
    });
    const verdict = classifyMerchant({
      checkoutHost: 'www.ebay.com',
      listing: {
        format: 'fixed-price',
        reputation: { sellerFeedbackCount: 200, sellerPositivePercent: 98.5, region: 'platform-widget' },
      },
    }, strict);
    // Passes the shipped bar (100 / 98%); fails his tightened one.
    expect(verdict.isMajor).toBe(false);
    expect(verdict.reason).toContain('below 5000');
  });

  test('his list overrides travel through the mapping', () => {
    const policy = merchantPolicyFromConfig({
      ...defaults,
      majorRetailersAdditional: 'local.example',
      majorRetailersExcluded: 'walmart.com',
    });
    expect(classifyMerchant({ checkoutHost: 'shop.local.example' }, policy).isMajor).toBe(true);
    expect(classifyMerchant({ checkoutHost: 'www.walmart.com' }, policy).isMajor).toBe(false);
  });

  test('no config value can promote an unrecognised storefront', () => {
    // The knobs tighten or name domains he vouches for. There is no setting that
    // makes an unknown checkout proceed on silence.
    const policy = merchantPolicyFromConfig({
      ...defaults,
      ebayMinSellerFeedbackCount: 0,
      ebayMinSellerPositivePercent: 0,
    });
    expect(classifyMerchant({ checkoutHost: 'www.jeffsgadgets.biz' }, policy).isMajor).toBe(false);
    // And a zeroed bar still cannot rescue an auction.
    expect(classifyMerchant({
      checkoutHost: 'www.ebay.com',
      listing: {
        format: 'auction',
        reputation: { sellerFeedbackCount: 9_000, sellerPositivePercent: 100, region: 'platform-widget' },
      },
    }, policy).refused).toBe(true);
  });
});
