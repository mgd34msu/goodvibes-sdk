import { describe, expect, test } from 'bun:test';

import { fillCard, type FillCardDeps } from '../packages/sdk/src/platform/payments/fill-card.js';
import { CardMaterialRedactor } from '../packages/sdk/src/platform/payments/card-redaction.js';
import { CheckoutRegistry, MemoryCheckoutJournal, type InFlightCheckout } from '../packages/sdk/src/platform/payments/checkout-registry.js';
import type { CardMaterial, CardMaterialStore } from '../packages/sdk/src/platform/payments/card-material.js';
import type { CheckoutPageDriver, PageIdentity } from '../packages/sdk/src/platform/payments/checkout-page.js';

/**
 * fill-card-field-attribution.test.ts (SF-6).
 *
 * `fillCard` used to read `filled`/`failedField` back off the driver's outcome
 * by ARRAY POSITION: `request.targets[filledCount]`. That is only correct when
 * the field that stopped the batch happens to sit at the same index as however
 * many fields got typed before it, true for a rejection reported by VALUE
 * (typing stops in order, so the count and the index agree) but not for a ref
 * that could not be RESOLVED at all: `fillSecretsIntoPage` resolves every ref
 * in the batch before typing any of them, so a ref that fails to resolve two
 * fields in is reported with zero fields typed, `filledCount === 0`, and the
 * old code would name field ONE as the failure regardless of which field's ref
 * actually failed.
 *
 * `4539578763621486` is an obviously fake PAN. No real card material appears
 * in this repository.
 */

const SENTINEL: CardMaterial = {
  number: '4539578763621486',
  expiryMonth: '07',
  expiryYear: '2029',
  cvv: '318',
  cardholderName: 'Sentinel Cardholder',
};

const CARD_ID = 'card-1';
const MERCHANT_DOMAIN = 'bestbuy.com';
const CHECKOUT_URL = `https://www.${MERCHANT_DOMAIN}/checkout`;

function cardStore(): CardMaterialStore {
  return {
    async metadata() {
      return {
        id: CARD_ID, label: 'Test', brand: 'visa', last4: '1486', kind: 'virtual',
        expiryMonth: 7, expiryYear: 2029, issuerCapMinorUnits: null,
        addedAt: '2026-07-01T00:00:00.000Z',
      };
    },
    async read() { return SENTINEL; },
  };
}

async function armingRegistry(): Promise<CheckoutRegistry> {
  const registry = new CheckoutRegistry(new MemoryCheckoutJournal());
  const record: InFlightCheckout = {
    purchaseId: 'p1',
    sessionId: 'session-1',
    pageId: 'page-1',
    merchantDomain: MERCHANT_DOMAIN,
    cardId: CARD_ID,
    item: 'thing' as never,
    currency: 'USD' as never,
    phase: 'arming-payment',
    startedAtMs: 0,
    updatedAtMs: 0,
    draw: null,
    reservationId: null,
    shippingTierRequested: 'standard' as never,
    shippingTierUsed: null,
    stepDown: null,
    totalMinorUnits: null,
  };
  await registry.open(record);
  await registry.advance('p1', 'arming-payment', {}, 0);
  return registry;
}

/** A driver whose `fillSecrets` answers with a caller-supplied outcome, out of order on purpose. */
function driverReturning(outcome: { readonly filledTargets: readonly string[]; readonly failedTarget: string | null }): CheckoutPageDriver {
  return {
    identity(): PageIdentity { return { sessionId: 'session-1', pageId: 'page-1' }; },
    async url() { return CHECKOUT_URL; },
    async fill() { /* not exercised */ },
    async fillSecrets() { return outcome; },
    async choose() { /* not exercised */ },
    async submitOrder() { throw new Error('not exercised'); },
  };
}

describe('fillCard names the TRUE failed field, not whichever one sits at the failure count\'s array index', () => {
  test('a failure reported for a non-first target names that target, not the first one', async () => {
    const registry = await armingRegistry();
    const deps: FillCardDeps = {
      registry, cards: cardStore(), redactor: new CardMaterialRedactor(),
      // Nothing was typed (filledTargets: []), but the ref that failed to
      // resolve was the THIRD target's ('cccvv'), not the first's ('ccnum').
      // The old position-based lookup would have read this back as 'number'.
      driver: driverReturning({ filledTargets: [], failedTarget: 'cccvv' }),
    };

    const result = await fillCard({
      sessionId: 'session-1',
      pageId: 'page-1',
      targets: [
        { field: 'number', target: 'ccnum' },
        { field: 'expiry', target: 'ccexp' },
        { field: 'cvv', target: 'cccvv' },
        { field: 'cardholderName', target: 'ccname' },
      ],
    }, deps);

    expect(result.ok).toBe(false);
    expect(result.failedField).toBe('cvv');
    expect(result.filled).toEqual([]);
  });

  test('a partial success followed by a failure names both correctly, out of the batch\'s declared order', async () => {
    const registry = await armingRegistry();
    const deps: FillCardDeps = {
      registry, cards: cardStore(), redactor: new CardMaterialRedactor(),
      // Two fields were actually typed ('ccexp' and 'ccnum', in that order,
      // NOT the request's declared order), and 'ccname' is what failed.
      driver: driverReturning({ filledTargets: ['ccexp', 'ccnum'], failedTarget: 'ccname' }),
    };

    const result = await fillCard({
      sessionId: 'session-1',
      pageId: 'page-1',
      targets: [
        { field: 'number', target: 'ccnum' },
        { field: 'expiry', target: 'ccexp' },
        { field: 'cardholderName', target: 'ccname' },
      ],
    }, deps);

    expect(result.ok).toBe(false);
    expect(result.filled).toEqual(['expiry', 'number']);
    expect(result.failedField).toBe('cardholderName');
  });

  test('a driver that throws with no attributable target reports no field, rather than blaming the first one', async () => {
    const registry = await armingRegistry();
    const deps: FillCardDeps = {
      registry, cards: cardStore(), redactor: new CardMaterialRedactor(),
      driver: {
        identity(): PageIdentity { return { sessionId: 'session-1', pageId: 'page-1' }; },
        async url() { return CHECKOUT_URL; },
        async fill() { /* not exercised */ },
        async fillSecrets(): Promise<never> { throw new Error('the browser session was lost'); },
        async choose() { /* not exercised */ },
        async submitOrder() { throw new Error('not exercised'); },
      },
    };

    const result = await fillCard({
      sessionId: 'session-1',
      pageId: 'page-1',
      targets: [
        { field: 'number', target: 'ccnum' },
        { field: 'cvv', target: 'cccvv' },
      ],
    }, deps);

    expect(result.ok).toBe(false);
    // Genuinely unknown, so no field is blamed, not even the first one.
    expect(result.failedField).toBeNull();
    expect(result.filled).toEqual([]);
    // The driver's own message never crosses into the result.
    expect(result.reason).not.toContain('browser session was lost');
  });
});
