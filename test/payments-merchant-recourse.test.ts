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
  windowForPurchase,
  resolveRecognisedRetailers,
} from '../packages/sdk/src/platform/payments/major-retailers.js';
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

/*
 * The `owner-initiated versus content-initiated` block that stood here covered
 * the taint-gate relaxation (a merchant DISCOVERED on a page being allowed on an
 * owner-initiated purchase). That relaxation is not in this tree: it removes a
 * refusal on the path that decides where money goes, and the only support for it
 * available from here is agent-authored. The classifier tests above are kept,
 * because the merchant grading is used only to make an in-budget purchase
 * STRICTER — an unrecognised merchant turns a veto into an approval, so silence
 * stops it instead of allowing it.
 *
 * The removed block and the taint-gate diff are preserved together and can be
 * restored in one step by a round briefed to carry that ruling from the start.
 */

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
