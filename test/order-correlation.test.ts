import { describe, expect, test } from 'bun:test';

import {
  correlatePurchaseMail,
  senderRegistrableDomain,
  extractConfirmationFacts,
  CONFIRMATION_WINDOW_MS,
} from '../packages/sdk/src/platform/payments/order-correlation.js';
import type { PurchaseRecord } from '../packages/sdk/src/platform/payments/purchase-record.js';

/**
 * order-correlation.test.ts, converted from a reviewer's reproduction probe
 * (probe.ts) that showed `submitted-unverified` purchases, the ones whose own
 * report tells the owner "check your order history at this merchant", never
 * correlated with the merchant's confirmation mail at all: the filter in
 * `correlatePurchaseMail` accepted only `outcome === 'purchased'`, so a
 * default composition with no `describeSubmission` wired (every purchase it
 * records is `submitted-unverified`) got `unrelated` for every confirmation
 * email that ever arrived, however squarely it matched on domain and timing.
 */

const BASE: PurchaseRecord = {
  purchaseId: 'p1',
  atUtc: new Date(1_700_000_000_000).toISOString(),
  dayKey: '2023-11-14',
  timezone: 'UTC',
  merchantDomain: 'bestbuy.com',
  item: 'thing',
  currency: 'USD',
  itemMinorUnits: 100,
  taxMinorUnits: 0,
  feesMinorUnits: 0,
  shippingMinorUnits: 0,
  totalMinorUnits: 100,
  shippingTierRequested: 'standard',
  shippingTierUsed: 'standard',
  steppedDown: false,
  itemPoolDraw: 100,
  overagePoolDraw: 0,
  tolerancePoolDraw: 0,
  cardLast4: '4242',
  windowKind: 'veto',
  windowOutcome: 'proceeding-silent',
  answeredBy: null,
  outcome: 'purchased',
  refusalReason: null,
  merchantOrderId: null,
  refundedAt: null,
  merchantRecognised: true,
  merchantQualifier: 'major',
  merchantDiscovered: false,
};

const MAIL = { senderAddress: 'orders@bestbuy.com', receivedAtMs: 1_700_000_600_000 };

describe('correlatePurchaseMail includes submitted-unverified records (BLOCKING 3)', () => {
  test('a purchased record still matches, exactly as before', () => {
    const result = correlatePurchaseMail(MAIL, [BASE]);
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') throw new Error('unreachable');
    expect(result.record.purchaseId).toBe('p1');
    expect(result.senderDomain).toBe('bestbuy.com');
  });

  test('a submitted-unverified record now matches too, the regression this guards', () => {
    const record: PurchaseRecord = { ...BASE, outcome: 'submitted-unverified' };
    const result = correlatePurchaseMail(MAIL, [record]);
    // Before the fix this was `unrelated`: the filter accepted only
    // `outcome === 'purchased'`, so a default composition with no
    // describeSubmission wired (every one of its records is
    // submitted-unverified) never recognised its own confirmation mail.
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') throw new Error('unreachable');
    expect(result.record.purchaseId).toBe('p1');
  });

  test('a match never rewrites the record: outcome and verified status are untouched', () => {
    const record: PurchaseRecord = { ...BASE, outcome: 'submitted-unverified' };
    const result = correlatePurchaseMail(MAIL, [record]);
    if (result.kind !== 'matched') throw new Error('expected a match');
    // Recognition, not re-verification: the stored outcome is exactly what was
    // recorded at submit time, whatever this mail says.
    expect(result.record.outcome).toBe('submitted-unverified');
    expect(result.record).toEqual(record);
  });

  test('a refused or cancelled purchase never correlates: nothing was submitted', () => {
    for (const outcome of ['refused', 'cancelled']) {
      const record: PurchaseRecord = { ...BASE, outcome };
      const result = correlatePurchaseMail(MAIL, [record]);
      expect(result.kind).toBe('unrelated');
    }
  });

  test('two correlatable candidates at the same merchant are ambiguous, never guessed', () => {
    const first: PurchaseRecord = { ...BASE, purchaseId: 'p1', outcome: 'purchased' };
    const second: PurchaseRecord = { ...BASE, purchaseId: 'p2', outcome: 'submitted-unverified' };
    const result = correlatePurchaseMail(MAIL, [first, second]);
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') throw new Error('unreachable');
    expect(result.candidates.map((r) => r.purchaseId).sort()).toEqual(['p1', 'p2']);
  });

  test('a different registrable domain does not match, however similar it looks', () => {
    const record: PurchaseRecord = { ...BASE, merchantDomain: 'bestbuy.com', outcome: 'submitted-unverified' };
    const result = correlatePurchaseMail(
      { senderAddress: 'orders@bestbuy.com.evil.test', receivedAtMs: 1_700_000_600_000 },
      [record],
    );
    expect(result.kind).toBe('unrelated');
  });

  test('a subdomain of the purchase domain still matches', () => {
    const record: PurchaseRecord = { ...BASE, outcome: 'submitted-unverified' };
    const result = correlatePurchaseMail(
      { senderAddress: 'confirm@order-update.bestbuy.com', receivedAtMs: 1_700_000_600_000 },
      [record],
    );
    expect(result.kind).toBe('matched');
  });

  test('mail outside the confirmation window does not match, even when correlatable', () => {
    const record: PurchaseRecord = { ...BASE, outcome: 'submitted-unverified' };
    const late = { senderAddress: 'orders@bestbuy.com', receivedAtMs: 1_700_000_000_000 + CONFIRMATION_WINDOW_MS + 1 };
    const result = correlatePurchaseMail(late, [record]);
    expect(result.kind).toBe('unrelated');
  });

  test('mail predating the purchase does not match, however close it lands', () => {
    const record: PurchaseRecord = { ...BASE, outcome: 'submitted-unverified' };
    const early = { senderAddress: 'orders@bestbuy.com', receivedAtMs: 1_699_999_999_999 };
    const result = correlatePurchaseMail(early, [record]);
    expect(result.kind).toBe('unrelated');
  });

  test('senderRegistrableDomain and extractConfirmationFacts are unaffected by this change', () => {
    expect(senderRegistrableDomain('orders@bestbuy.com')).toBe('bestbuy.com');
    expect(senderRegistrableDomain('not-an-address')).toBeNull();
    const facts = extractConfirmationFacts('Confirmation number: BBY-01-556677 ships on August 20, 2026.');
    expect(facts.orderNumber).toBe('BBY-01-556677');
  });
});
