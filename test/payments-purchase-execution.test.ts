/**
 * payments-purchase-execution.test.ts — the daemon actually buying something.
 *
 * ══ What is being proved, and what would make each proof worthless ════════
 *
 * Two things at once, and they pull in opposite directions:
 *
 *  1. **The card reaches the merchant and nothing else.** Every read path back
 *     to it is closed — the control-plane response, a snapshot taken after the
 *     fill, an error message, the driver's own thrown text.
 *  2. **Nothing in the flow knows a merchant.** The whole thing runs against two
 *     fixture stores that share no markup, no label wording, no element
 *     structure and no number formatting.
 *
 * Each would be easy to fake alone. A containment test against a hand-written
 * element list proves the redactor redacts what the test author remembered; a
 * generality test against one realistic fixture proves the flow works on that
 * fixture. So: the containment assertions run through the REAL `takeSnapshot`
 * over the fixtures' real markup, and every flow assertion that can run on both
 * fixtures runs on both.
 *
 *   ALPHA  table-driven US store. `$1,299.00`. Standard `autocomplete="cc-*"`
 *          tokens, so its card fields are caught structurally.
 *   BETA   div-and-span European store. `1.299,00 €` — dot thousands, comma
 *          decimal, trailing symbol. NO autocomplete attributes at all and
 *          German field names, so its card fields are caught only by the name
 *          patterns and the value-based layer.
 *
 * ══ The sentinel ══════════════════════════════════════════════════════════
 *
 * The card number below is a Luhn-valid test PAN that belongs to no issuer, and
 * every containment assertion searches for it in both spellings — as typed, and
 * as a page might reformat it. No test in this file ever contacts a real
 * merchant: both fixtures bind to port 0 on loopback and their "place order"
 * endpoint records what it received instead of shipping anything.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  CardMaterialRedactor,
  REDACTED_MARKER,
} from '../packages/sdk/src/platform/payments/card-redaction.js';
import type {
  CardMaterial,
  CardMaterialStore,
} from '../packages/sdk/src/platform/payments/card-material.js';
import {
  CheckoutRegistry,
  MemoryCheckoutJournal,
  describeInterruption,
  verdictFor,
} from '../packages/sdk/src/platform/payments/checkout-registry.js';
import {
  fillCard,
  FillCardRefusal,
} from '../packages/sdk/src/platform/payments/fill-card.js';
import {
  runCheckout,
  type CheckoutControls,
  type CheckoutFlowDeps,
  type CheckoutOutcome,
  type PurchaseLedger,
  type PurchaseRecord,
  type PurchaseRequest,
} from '../packages/sdk/src/platform/payments/checkout-flow.js';
import { extractCheckout } from '../packages/sdk/src/platform/payments/checkout-extraction.js';
import { BudgetLedger, type BudgetLimits } from '../packages/sdk/src/platform/payments/budget.js';
import type { CardMetadata } from '../packages/sdk/src/platform/payments/types.js';
import type { ChannelDelivery } from '../packages/sdk/src/platform/payments/windows.js';
import { UntrustedContentLedger } from '../packages/sdk/src/platform/security/untrusted-content.js';
import { takeSnapshot } from '../packages/sdk/src/platform/browser/browser-snapshot.js';
import {
  createPaymentsCheckoutFillCardHandler,
  type PaymentFillCardResult,
  type PaymentsGatewayService,
} from '../packages/sdk/src/platform/control-plane/routes/payments.js';
import { PAYMENTS_CHECKOUT_FILL_CARD_OUTPUT_SCHEMA } from '../packages/sdk/src/platform/control-plane/operator-contract-schemas-payments.js';

import {
  startFixtureMerchant,
  type FixtureMerchant,
  type FixtureShape,
} from './helpers/fixture-merchant.js';
import {
  FixtureCheckoutDriver,
  readFixtureCheckout,
} from './helpers/fixture-checkout-driver.js';
import {
  collectFixtureControls,
  fixtureSnapshotPage,
} from './helpers/fixture-snapshot-page.js';

// ── The sentinel card ───────────────────────────────────────────────────────

const SENTINEL: CardMaterial = {
  number: '4539578763621486',
  expiryMonth: '07',
  expiryYear: '2029',
  cvv: '318',
  cardholderName: 'Sentinel Cardholder',
};

/** Every spelling of the sentinel a page or a log could plausibly produce. */
const SENTINEL_SPELLINGS: readonly string[] = [
  SENTINEL.number,
  '4539 5787 6362 1486',
  '4539-5787-6362-1486',
  SENTINEL.cvv,
  SENTINEL.cardholderName,
  `${SENTINEL.expiryMonth}/${SENTINEL.expiryYear}`,
];

const CARD_METADATA: CardMetadata = {
  id: 'card-1',
  label: 'Test card',
  brand: 'visa',
  last4: '1486',
  kind: 'virtual',
  expiryMonth: 7,
  expiryYear: 2029,
  issuerCapMinorUnits: null,
  addedAt: '2026-07-01T00:00:00.000Z',
};

class SentinelCardStore implements CardMaterialStore {
  constructor(private readonly material: CardMaterial | null = SENTINEL) {}

  async metadata(): Promise<CardMetadata | null> {
    return CARD_METADATA;
  }

  async read(): Promise<CardMaterial | null> {
    return this.material;
  }
}

/**
 * Assert a blob of text holds no part of the card.
 *
 * Checks the reformatted spellings too, because a page that renders the number
 * with spaces defeats an exact search while looking like a pass — which is the
 * worst possible outcome for an assertion whose whole job is to notice.
 */
function expectNoCardMaterial(label: string, text: string): void {
  for (const spelling of SENTINEL_SPELLINGS) {
    if (text.includes(spelling)) {
      throw new Error(`${label} contained card material: ${spelling}`);
    }
  }
  // The last four are shown to the owner by design, in every notice and every
  // ledger row. Asserting their ABSENCE would be asserting the audit trail is
  // broken, so this deliberately does not.
  expect(text.includes(SENTINEL.number)).toBe(false);
}

// ── Harness ─────────────────────────────────────────────────────────────────

/** Where the fixtures pretend to live. Real registrable domains, no real traffic. */
const RECOGNISED_ORIGIN = 'https://www.bestbuy.com';
const UNRECOGNISED_ORIGIN = 'https://www.jeffsgadgets.biz';

interface HarnessOptions {
  readonly merchant: FixtureMerchant;
  readonly origin?: string;
  readonly dailyItemMinorUnits?: number;
  readonly dailyOverageMinorUnits?: number;
  /** null ⇒ silence. */
  readonly answer?: { answer: 'approve' | 'deny' | 'acknowledge' | 'object' } | null;
  readonly deliverable?: boolean;
  readonly failSubmit?: boolean;
  readonly challenge?: { kind: '3d-secure' | 'captcha' | 'otp' | 'unknown'; step: string; url: string };
  readonly rejectField?: string;
  readonly storefrontHost?: string;
  readonly material?: CardMaterial | null;
}

interface Harness {
  readonly deps: CheckoutFlowDeps;
  readonly driver: FixtureCheckoutDriver;
  readonly redactor: CardMaterialRedactor;
  readonly registry: CheckoutRegistry;
  readonly ledger: BudgetLedger;
  readonly recorded: PurchaseRecord[];
  readonly notices: { kind: 'approval' | 'veto'; message: string }[];
  readonly request: PurchaseRequest;
  readonly controls: CheckoutControls;
  readonly origin: string;
}

/** The card field targets, per fixture. This is the MODEL's knowledge, not the flow's. */
const CARD_TARGETS: Record<FixtureShape, CheckoutControls> = {
  alpha: {
    cardFields: [
      { field: 'number', target: 'ccnum' },
      { field: 'expiry', target: 'ccexp' },
      { field: 'cvv', target: 'cccvv' },
      { field: 'cardholderName', target: 'ccname' },
    ],
    shippingTargets: ['ship-standard', 'ship-two-day', 'ship-overnight'],
    placeOrderTarget: 'place',
  },
  beta: {
    cardFields: [
      { field: 'number', target: 'k1' },
      { field: 'expiry', target: 'k2' },
      { field: 'cvv', target: 'k3' },
      { field: 'cardholderName', target: 'k4' },
    ],
    shippingTargets: ['versand-post', 'versand-express'],
    placeOrderTarget: 'kaufen',
    twoDigitYear: true,
  },
};

function buildHarness(options: HarnessOptions): Harness {
  const origin = options.origin ?? RECOGNISED_ORIGIN;
  const merchant = options.merchant;
  const driver = new FixtureCheckoutDriver({
    merchant,
    pageUrl: `${origin}/checkout`,
    ...(options.failSubmit === undefined ? {} : { failSubmit: options.failSubmit }),
    ...(options.challenge === undefined ? {} : { challenge: options.challenge }),
    ...(options.rejectField === undefined ? {} : { rejectField: options.rejectField }),
  });
  const redactor = new CardMaterialRedactor();
  const registry = new CheckoutRegistry(new MemoryCheckoutJournal());
  const ledger = new BudgetLedger();
  const recorded: PurchaseRecord[] = [];
  const notices: { kind: 'approval' | 'veto'; message: string }[] = [];

  const purchases: PurchaseLedger = {
    async record(entry) {
      recorded.push(entry);
    },
  };

  const limits: BudgetLimits = {
    dailyItemMinorUnits: options.dailyItemMinorUnits ?? 500_000,
    dailyOverageMinorUnits: options.dailyOverageMinorUnits ?? 500_000,
    perPurchaseCeiling: { enabled: false, minorUnits: 0 },
    overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 },
  };

  const deliveries: readonly ChannelDelivery[] = [
    { channel: 'tui', delivered: options.deliverable !== false, backfillable: false },
  ];

  const deps: CheckoutFlowDeps = {
    registry,
    cards: new SentinelCardStore(options.material === undefined ? SENTINEL : options.material),
    redactor,
    driver,
    ledger,
    purchases,
    notifier: {
      async deliver(input) {
        notices.push({ kind: input.kind, message: input.message });
        return deliveries;
      },
      async awaitAnswer(input) {
        const answer = options.answer ?? null;
        if (answer === null) return null;
        return { answer: answer.answer, channel: 'tui' };
      },
    },
    untrusted: new UntrustedContentLedger(),
    limits,
    budgetCurrency: merchant.currency === 'EUR' ? 'EUR' : 'USD',
    timezone: 'UTC',
    gates: {
      enabled: true,
      hasUsableCard: true,
      hasShippingAddress: true,
      isOwnerDirectRequest: true,
      isPaymentsLeader: true,
    },
    approvalMinutes: 60,
    vetoMinutes: 10,
    now: () => 1_770_000_000_000,
  };

  const request: PurchaseRequest = {
    purchaseId: `p-${merchant.shape}-${String(Math.random()).slice(2, 8)}`,
    merchantDomain: new URL(origin).hostname,
    checkoutUrl: `${origin}/checkout`,
    item: merchant.shape === 'alpha' ? 'Mechanical keyboard, tenkeyless' : 'Espressomaschine, zweikreisig',
    requestedLines: [
      {
        label: merchant.shape === 'alpha' ? 'Mechanical keyboard, tenkeyless' : 'Espressomaschine, zweikreisig',
        quantity: 1,
      },
    ],
    cardId: 'card-1',
    preferredTier: 'normal',
    ...(options.storefrontHost === undefined ? {} : { storefrontHost: options.storefrontHost }),
  };

  return {
    deps,
    driver,
    redactor,
    registry,
    ledger,
    recorded,
    notices,
    request,
    controls: CARD_TARGETS[merchant.shape],
    origin,
  };
}

async function runOn(harness: Harness, merchant: FixtureMerchant): Promise<CheckoutOutcome> {
  const reading = await readFixtureCheckout(merchant);
  return runCheckout(harness.request, reading, harness.controls, harness.deps);
}

// ── Both fixtures, started once per test ────────────────────────────────────

let alpha: FixtureMerchant;
let beta: FixtureMerchant;

beforeEach(async () => {
  alpha = await startFixtureMerchant('alpha');
  beta = await startFixtureMerchant('beta');
});

afterEach(async () => {
  await alpha.close();
  await beta.close();
});

function shapes(): { name: string; get: () => FixtureMerchant }[] {
  return [
    { name: 'alpha (US table markup, $1,234.56)', get: () => alpha },
    { name: 'beta (German div markup, 1.234,56 €)', get: () => beta },
  ];
}

// ═══ 1. The card is absent from every response, log, trace and error ════════

describe('the card never comes back', () => {
  test('the control-plane response carries field NAMES and a boolean, nothing else', async () => {
    const harness = buildHarness({ merchant: alpha });
    const outcome = await runOn(harness, alpha);
    expect(outcome.kind).toBe('purchased');

    // The verb, exercised through the real route handler, against a service
    // that runs the real fill — so this is the response a surface would get.
    const registry = new CheckoutRegistry(new MemoryCheckoutJournal());
    const redactor = new CardMaterialRedactor();
    const driver = new FixtureCheckoutDriver({ merchant: alpha, pageUrl: `${RECOGNISED_ORIGIN}/checkout` });
    await registry.open({
      purchaseId: 'p-route', sessionId: 'session-1', pageId: 'page-1',
      merchantDomain: 'bestbuy.com', cardId: 'card-1', item: 'thing', currency: 'USD',
      phase: 'arming-payment', startedAtMs: 0, updatedAtMs: 0, draw: null, reservationId: null,
      shippingTierRequested: 'normal', shippingTierUsed: null, stepDown: null, totalMinorUnits: null,
    });

    const service = {
      async fillCardIntoCheckout(input): Promise<PaymentFillCardResult> {
        return fillCard(
          {
            sessionId: input.sessionId,
            pageId: input.pageId,
            targets: input.targets.map((entry) => ({ field: entry.field as 'number', target: entry.ref })),
            expirySeparator: input.expirySeparator,
            twoDigitYear: input.twoDigitYear,
          },
          { registry, cards: new SentinelCardStore(), redactor, driver },
        );
      },
    } as unknown as PaymentsGatewayService;

    const handler = createPaymentsCheckoutFillCardHandler(service);
    const response = await handler({
      body: {
        sessionId: 'session-1',
        pageId: 'page-1',
        targets: [
          { field: 'number', ref: 'ccnum' },
          { field: 'cvv', ref: 'cccvv' },
        ],
      },
    } as never);

    expect(response['ok']).toBe(true);
    expect(response['filled']).toEqual(['number', 'cvv']);
    expectNoCardMaterial('the fillCard response', JSON.stringify(response));

    // And the card really did reach the page it was typed into, so the
    // assertion above is about containment rather than about nothing happening.
    expect(driver.formState.get('ccnum')).toBe(SENTINEL.number);
  });

  test('the output schema has no property that could hold a value', () => {
    const schema = PAYMENTS_CHECKOUT_FILL_CARD_OUTPUT_SCHEMA as unknown as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(['failedField', 'filled', 'ok', 'reason']);
  });

  test('the route rebuilds the response from an allowlist, so a leaky service loses the leak', async () => {
    const service = {
      async fillCardIntoCheckout(): Promise<PaymentFillCardResult> {
        return {
          ok: true,
          filled: ['number'],
          failedField: null,
          reason: null,
          // A service that started echoing what it typed. The route must not
          // pass this on, whatever the service thinks it is doing.
          typedValue: SENTINEL.number,
        } as unknown as PaymentFillCardResult;
      },
    } as unknown as PaymentsGatewayService;

    const response = await createPaymentsCheckoutFillCardHandler(service)({
      body: { sessionId: 's', pageId: 'p', targets: [{ field: 'number', ref: 'r' }] },
    } as never);

    expect(Object.keys(response).sort()).toEqual(['failedField', 'filled', 'ok', 'reason']);
    expectNoCardMaterial('the sanitized route response', JSON.stringify(response));
  });

  test('a fill failure names the field, and discards the driver error that quoted the value', async () => {
    // The fixture driver deliberately puts the value into its thrown message,
    // exactly as a real browser fill error does.
    const harness = buildHarness({ merchant: alpha, rejectField: 'cccvv' });
    const outcome = await runOn(harness, alpha);

    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') throw new Error('unreachable');
    expect(outcome.reason).toContain('cvv');
    expectNoCardMaterial('the fill failure reason', outcome.reason);
    expect(alpha.submissions.length).toBe(0);
  });

  test('a refusal thrown out of the route names the field and never the value', async () => {
    const service = {
      async fillCardIntoCheckout(): Promise<PaymentFillCardResult> {
        throw new Error(`could not type "${SENTINEL.number}" into the field`);
      },
    } as unknown as PaymentsGatewayService;

    let message = '';
    try {
      await createPaymentsCheckoutFillCardHandler(service)({
        body: { sessionId: 's', pageId: 'p', targets: [{ field: 'number', ref: 'r' }] },
      } as never);
      throw new Error('expected the handler to throw');
    } catch (error) {
      message = (error as Error).message;
    }
    expectNoCardMaterial('the route error', message);
    expect(message).toContain('Nothing was submitted');
  });

  test('the purchase record carries last4 and no more of the card', async () => {
    const harness = buildHarness({ merchant: alpha });
    await runOn(harness, alpha);
    const record = harness.recorded[0];
    expect(record).toBeDefined();
    expect(record?.cardLast4).toBe('1486');
    expectNoCardMaterial('the purchase record', JSON.stringify(record));
  });

  test('the notice the owner reads carries last4 and no more of the card', async () => {
    const harness = buildHarness({ merchant: alpha });
    await runOn(harness, alpha);
    expect(harness.notices.length).toBe(1);
    expectNoCardMaterial('the purchase notice', harness.notices.map((entry) => entry.message).join('\n'));
  });
});

// ═══ 2. A snapshot taken after a fill does not contain the card ═════════════

describe('a snapshot after the fill', () => {
  for (const shape of shapes()) {
    test(`does not report the card on ${shape.name}`, async () => {
      const merchant = shape.get();
      const harness = buildHarness({ merchant });
      const outcome = await runOn(harness, merchant);
      expect(outcome.kind).toBe('purchased');

      // The material is disarmed after a successful submit, which is correct
      // and would also make this assertion trivially pass. So the snapshot is
      // taken against a page that is STILL holding it: re-arm from the driver's
      // own form state, which is what the browser would still be showing.
      harness.redactor.arm('session-1', 'page-1', [
        { kind: 'number', value: SENTINEL.number },
        { kind: 'cvv', value: SENTINEL.cvv },
        { kind: 'cardholder', value: SENTINEL.cardholderName },
        { kind: 'expiry', value: `${SENTINEL.expiryMonth}/${SENTINEL.expiryYear}` },
      ]);

      const html = await merchant.checkoutHtml();
      const elements = await collectFixtureControls(html, harness.driver.formState);
      // Sanity: the page really is holding the number before redaction runs.
      expect(elements.some((element) => element.value === SENTINEL.number)).toBe(true);

      const page = fixtureSnapshotPage({
        url: `${harness.origin}/checkout`,
        title: 'Checkout',
        elements,
      });
      const snapshot = await takeSnapshot(page, 'session-1', 'page-1', { guard: harness.redactor });

      expectNoCardMaterial(`the ${merchant.shape} snapshot`, JSON.stringify(snapshot));
      // The fields are still addressable — the model can ask for another fill.
      expect(snapshot.elements.some((element) => element.cardField === true)).toBe(true);
    });
  }

  test('a page that reformats or echoes the number is still redacted', () => {
    const redactor = new CardMaterialRedactor();
    redactor.arm('s', 'p', [{ kind: 'number', value: SENTINEL.number }]);

    expect(redactor.redact('s', 'p', `Card ${SENTINEL.number} on file`)).toBe(`Card ${REDACTED_MARKER} on file`);
    expect(redactor.redact('s', 'p', 'Paying with 4539 5787 6362 1486 today')).toBe(
      `Paying with ${REDACTED_MARKER} today`,
    );
    expect(redactor.redact('s', 'p', '4539-5787-6362-1486')).toBe(REDACTED_MARKER);
    // A price is not a card, and blanking one would be redaction he cannot explain.
    expect(redactor.redact('s', 'p', 'Total $129.00')).toBe('Total $129.00');
  });

  test('a card field reports no value even with no guard installed at all', async () => {
    const html = await alpha.checkoutHtml();
    const filled = new Map([['ccnum', SENTINEL.number], ['coupon', 'SAVE10']]);
    const elements = await collectFixtureControls(html, filled);
    const page = fixtureSnapshotPage({ url: `${RECOGNISED_ORIGIN}/checkout`, title: 'Checkout', elements });

    const snapshot = await takeSnapshot(page, 'session-1', 'page-1');

    expectNoCardMaterial('an unguarded snapshot', JSON.stringify(snapshot));
    // The ordinary field is untouched — the suppression is targeted, not blanket.
    expect(snapshot.elements.some((element) => element.value === 'SAVE10')).toBe(true);
  });

  test('beta has no autocomplete tokens at all, so its names are what catch it', async () => {
    const html = await beta.checkoutHtml();
    expect(html).not.toContain('autocomplete');
    const elements = await collectFixtureControls(html, new Map([['k1', SENTINEL.number]]));
    const page = fixtureSnapshotPage({ url: `${RECOGNISED_ORIGIN}/checkout`, title: 'Bestellung', elements });
    const snapshot = await takeSnapshot(page, 'session-1', 'page-1');
    expectNoCardMaterial('the beta snapshot with no guard', JSON.stringify(snapshot));
  });
});

// ═══ 3 & 4. The fill's refusals ════════════════════════════════════════════

describe('the fill refuses before it reads any material', () => {
  test('a fill into a domain the purchase was not decided against is refused', async () => {
    const registry = new CheckoutRegistry(new MemoryCheckoutJournal());
    const redactor = new CardMaterialRedactor();
    // The page has navigated to a different registrable domain.
    const driver = new FixtureCheckoutDriver({ merchant: alpha, pageUrl: 'https://www.walmart.com/checkout' });
    await registry.open({
      purchaseId: 'p-1', sessionId: 'session-1', pageId: 'page-1',
      merchantDomain: 'bestbuy.com', cardId: 'card-1', item: 'thing', currency: 'USD',
      phase: 'arming-payment', startedAtMs: 0, updatedAtMs: 0, draw: null, reservationId: null,
      shippingTierRequested: 'normal', shippingTierUsed: null, stepDown: null, totalMinorUnits: null,
    });

    let thrown: FillCardRefusal | null = null;
    try {
      await fillCard(
        { sessionId: 'session-1', pageId: 'page-1', targets: [{ field: 'number', target: 'ccnum' }] },
        { registry, cards: new SentinelCardStore(), redactor, driver },
      );
    } catch (error) {
      thrown = error as FillCardRefusal;
    }

    expect(thrown).toBeInstanceOf(FillCardRefusal);
    expect(thrown?.message).toContain('bestbuy.com');
    expect(driver.formState.size).toBe(0);
    expect(driver.fillLog.length).toBe(0);
    expectNoCardMaterial('the wrong-domain refusal', thrown?.message ?? '');
  });

  test('a subdomain of the decided merchant is still the decided merchant', async () => {
    const registry = new CheckoutRegistry(new MemoryCheckoutJournal());
    const driver = new FixtureCheckoutDriver({ merchant: alpha, pageUrl: 'https://checkout.bestbuy.com/pay' });
    await registry.open({
      purchaseId: 'p-1', sessionId: 'session-1', pageId: 'page-1',
      merchantDomain: 'bestbuy.com', cardId: 'card-1', item: 'thing', currency: 'USD',
      phase: 'arming-payment', startedAtMs: 0, updatedAtMs: 0, draw: null, reservationId: null,
      shippingTierRequested: 'normal', shippingTierUsed: null, stepDown: null, totalMinorUnits: null,
    });

    const result = await fillCard(
      { sessionId: 'session-1', pageId: 'page-1', targets: [{ field: 'number', target: 'ccnum' }] },
      { registry, cards: new SentinelCardStore(), redactor: new CardMaterialRedactor(), driver },
    );
    expect(result.ok).toBe(true);
  });

  test('a fill with no purchase in flight on that page is refused', async () => {
    const registry = new CheckoutRegistry(new MemoryCheckoutJournal());
    const driver = new FixtureCheckoutDriver({ merchant: alpha, pageUrl: `${RECOGNISED_ORIGIN}/checkout` });

    let thrown: FillCardRefusal | null = null;
    try {
      await fillCard(
        { sessionId: 'session-1', pageId: 'page-1', targets: [{ field: 'number', target: 'ccnum' }] },
        { registry, cards: new SentinelCardStore(), redactor: new CardMaterialRedactor(), driver },
      );
    } catch (error) {
      thrown = error as FillCardRefusal;
    }

    expect(thrown).toBeInstanceOf(FillCardRefusal);
    expect(thrown?.message).toContain('no purchase decision is in flight');
    expect(driver.formState.size).toBe(0);
  });

  test('a purchase in flight on a DIFFERENT page does not authorise this one', async () => {
    const registry = new CheckoutRegistry(new MemoryCheckoutJournal());
    const driver = new FixtureCheckoutDriver({
      merchant: alpha, pageUrl: `${RECOGNISED_ORIGIN}/checkout`, pageId: 'page-2',
    });
    await registry.open({
      purchaseId: 'p-1', sessionId: 'session-1', pageId: 'page-1',
      merchantDomain: 'bestbuy.com', cardId: 'card-1', item: 'thing', currency: 'USD',
      phase: 'arming-payment', startedAtMs: 0, updatedAtMs: 0, draw: null, reservationId: null,
      shippingTierRequested: 'normal', shippingTierUsed: null, stepDown: null, totalMinorUnits: null,
    });

    await expect(
      fillCard(
        { sessionId: 'session-1', pageId: 'page-2', targets: [{ field: 'number', target: 'ccnum' }] },
        { registry, cards: new SentinelCardStore(), redactor: new CardMaterialRedactor(), driver },
      ),
    ).rejects.toThrow(FillCardRefusal);
    expect(driver.formState.size).toBe(0);
  });

  test('a purchase that has not reached the payment stage does not get the card typed', async () => {
    const registry = new CheckoutRegistry(new MemoryCheckoutJournal());
    const driver = new FixtureCheckoutDriver({ merchant: alpha, pageUrl: `${RECOGNISED_ORIGIN}/checkout` });
    await registry.open({
      purchaseId: 'p-1', sessionId: 'session-1', pageId: 'page-1',
      merchantDomain: 'bestbuy.com', cardId: 'card-1', item: 'thing', currency: 'USD',
      phase: 'awaiting-window', startedAtMs: 0, updatedAtMs: 0, draw: null, reservationId: null,
      shippingTierRequested: 'normal', shippingTierUsed: null, stepDown: null, totalMinorUnits: null,
    });

    await expect(
      fillCard(
        { sessionId: 'session-1', pageId: 'page-1', targets: [{ field: 'number', target: 'ccnum' }] },
        { registry, cards: new SentinelCardStore(), redactor: new CardMaterialRedactor(), driver },
      ),
    ).rejects.toThrow(/awaiting-window/);
    expect(driver.formState.size).toBe(0);
  });

  test('a browser with no redaction installed cannot be used to pay for anything', async () => {
    const registry = new CheckoutRegistry(new MemoryCheckoutJournal());
    const driver = new FixtureCheckoutDriver({ merchant: alpha, pageUrl: `${RECOGNISED_ORIGIN}/checkout` });
    await registry.open({
      purchaseId: 'p-1', sessionId: 'session-1', pageId: 'page-1',
      merchantDomain: 'bestbuy.com', cardId: 'card-1', item: 'thing', currency: 'USD',
      phase: 'arming-payment', startedAtMs: 0, updatedAtMs: 0, draw: null, reservationId: null,
      shippingTierRequested: 'normal', shippingTierUsed: null, stepDown: null, totalMinorUnits: null,
    });

    await expect(
      fillCard(
        { sessionId: 'session-1', pageId: 'page-1', targets: [{ field: 'number', target: 'ccnum' }] },
        {
          registry,
          cards: new SentinelCardStore(),
          redactor: {} as unknown as CardMaterialRedactor,
          driver,
        },
      ),
    ).rejects.toThrow(/redaction/);
    expect(driver.formState.size).toBe(0);
  });

  test('incomplete stored material fills nothing rather than filling half a form', async () => {
    const registry = new CheckoutRegistry(new MemoryCheckoutJournal());
    const driver = new FixtureCheckoutDriver({ merchant: alpha, pageUrl: `${RECOGNISED_ORIGIN}/checkout` });
    await registry.open({
      purchaseId: 'p-1', sessionId: 'session-1', pageId: 'page-1',
      merchantDomain: 'bestbuy.com', cardId: 'card-1', item: 'thing', currency: 'USD',
      phase: 'arming-payment', startedAtMs: 0, updatedAtMs: 0, draw: null, reservationId: null,
      shippingTierRequested: 'normal', shippingTierUsed: null, stepDown: null, totalMinorUnits: null,
    });

    await expect(
      fillCard(
        { sessionId: 'session-1', pageId: 'page-1', targets: [{ field: 'number', target: 'ccnum' }] },
        { registry, cards: new SentinelCardStore(null), redactor: new CardMaterialRedactor(), driver },
      ),
    ).rejects.toThrow(/incomplete/);
    expect(driver.formState.size).toBe(0);
  });
});

// ═══ 5. Our integers drive the decision, not the merchant's text ═══════════

describe('the daemon computes every number the owner acts on', () => {
  for (const shape of shapes()) {
    test(`parses ${shape.name} into integer minor units`, async () => {
      const merchant = shape.get();
      const reading = await readFixtureCheckout(merchant);
      const extraction = extractCheckout(reading, merchant.currency === 'EUR' ? 'EUR' : 'USD');
      expect(extraction.ok).toBe(true);
      if (!extraction.ok) throw new Error(extraction.reason);

      if (merchant.shape === 'alpha') {
        expect(extraction.checkout.itemMinorUnits).toBe(12_900);
        expect(extraction.checkout.taxMinorUnits).toBe(1_097);
        expect(extraction.checkout.feesMinorUnits).toBe(150);
        expect(extraction.checkout.shippingOptions.map((option) => option.costMinorUnits))
          .toEqual([499, 1_299, 2_999]);
      } else {
        // `1.299,00` is 1299.00, not 129900. A strip-every-non-digit reader
        // gets this wrong by a factor of a hundred and reports success.
        expect(extraction.checkout.itemMinorUnits).toBe(129_900);
        expect(extraction.checkout.taxMinorUnits).toBe(24_681);
        expect(extraction.checkout.shippingOptions.map((option) => option.costMinorUnits))
          .toEqual([690, 1_990]);
      }
    });
  }

  test('a merchant total that disagrees with its own line items stops the purchase', async () => {
    const reading = await readFixtureCheckout(alpha);
    const lied = {
      ...reading,
      // One delivery option, so a stated total is comparable, and a stated
      // total that flatters the merchant.
      shippingOptions: [{ label: 'Standard', cost: '$4.99' }],
      statedTotal: '$9.99',
    };
    const extraction = extractCheckout(lied, 'USD');
    expect(extraction.ok).toBe(false);
    if (extraction.ok) throw new Error('expected a refusal');
    expect(extraction.field).toBe('statedTotal');
  });

  test('the notice and the record are rendered from our integers, not the page text', async () => {
    const harness = buildHarness({ merchant: alpha });
    const outcome = await runOn(harness, alpha);
    expect(outcome.kind).toBe('purchased');
    if (outcome.kind !== 'purchased') throw new Error('unreachable');

    // 12900 item + 1097 tax + 150 fee + 499 delivery.
    expect(outcome.record.totalMinorUnits).toBe(14_646);
    expect(harness.notices[0]?.message).toContain('146.46');
  });

  test('a price the parser cannot read one way stops the purchase rather than guessing', () => {
    const result = extractCheckout(
      {
        lines: [{ label: 'Thing', quantity: '1', unitPrice: '$12.00 – $18.00' }],
        tax: null,
        fees: [],
        shippingOptions: [{ label: 'Standard', cost: '$4.99' }],
        statedTotal: null,
        currency: 'USD',
        orderSummaryText: '',
      },
      'USD',
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.field).toBe('lines[0].unitPrice');
  });

  test('a separator layout that could mean two different numbers is refused, not picked', () => {
    // Each of these is caught by the GRAMMAR rather than by the one-number
    // rule above, which is the guard that decides "1.234" is 1234 and not 1.23.
    // A parser that fell back to stripping non-digits would answer all of them
    // confidently and be wrong by a factor of a thousand on most.
    for (const price of [
      '$1,23,456.00', // Indian grouping: groups of two, matches no shape we accept
      '$1,2345.00',   // a four-digit group is not a thousands group
      '$12,345,6.78', // a trailing two-digit group
      '$1.234.5',     // dot used as both separators
      '$12.345,67.8', // two decimal separators
    ]) {
      const outcome = extractCheckout(
        {
          lines: [{ label: 'Thing', quantity: '1', unitPrice: price }],
          tax: null,
          fees: [],
          shippingOptions: [{ label: 'Standard', cost: '$4.99' }],
          statedTotal: null,
          currency: 'USD',
          orderSummaryText: '',
        },
        'USD',
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error(`expected ${price} to be refused`);
      expect(outcome.field).toBe('lines[0].unitPrice');
    }
  });
});

// ═══ 6, 7, 8. The one notice, and what silence means ═══════════════════════

describe('one notification, and the merchant decides what silence means', () => {
  for (const shape of shapes()) {
    test(`an in-budget total at a recognised retailer submits after the veto window on ${shape.name}`, async () => {
      const merchant = shape.get();
      const harness = buildHarness({ merchant });
      const outcome = await runOn(harness, merchant);

      expect(outcome.kind).toBe('purchased');
      if (outcome.kind !== 'purchased') throw new Error('unreachable');
      expect(harness.notices.length).toBe(1);
      expect(harness.notices[0]?.kind).toBe('veto');
      expect(merchant.submissions.length).toBe(1);
      expect(outcome.record.windowKind).toBe('veto');
      expect(outcome.record.windowOutcome).toBe('proceeding-silent');
      expect(outcome.record.merchantRecognised).toBe(true);

      // The card reached the merchant, which is the whole point of the capability.
      const submitted = merchant.submissions[0]?.fields ?? {};
      const cardTarget = merchant.shape === 'alpha' ? 'ccnum' : 'k1';
      expect(submitted[cardTarget]).toBe(SENTINEL.number);
    });
  }

  test('an over-budget total asks, and silence does not submit', async () => {
    const harness = buildHarness({ merchant: alpha, dailyItemMinorUnits: 5_000, answer: null });
    const outcome = await runOn(harness, alpha);

    expect(harness.notices.length).toBe(1);
    expect(harness.notices[0]?.kind).toBe('approval');
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') throw new Error('unreachable');
    expect(outcome.code).toBe('item-budget-exceeded-expired');
    expect(alpha.submissions.length).toBe(0);
    expect(harness.recorded.length).toBe(0);
    // The money it was holding went back.
    expect(harness.ledger.state().reservations.length).toBe(0);
  });

  test('an over-budget total that he approves goes through', async () => {
    const harness = buildHarness({
      merchant: alpha, dailyItemMinorUnits: 5_000, answer: { answer: 'approve' },
    });
    const outcome = await runOn(harness, alpha);

    expect(outcome.kind).toBe('purchased');
    if (outcome.kind !== 'purchased') throw new Error('unreachable');
    expect(outcome.record.windowKind).toBe('approval');
    expect(outcome.record.windowOutcome).toBe('approved');
    expect(outcome.record.answeredBy).toBe('tui');
    expect(alpha.submissions.length).toBe(1);
  });

  test('an over-budget total he says no to submits nothing', async () => {
    const harness = buildHarness({
      merchant: alpha, dailyItemMinorUnits: 5_000, answer: { answer: 'deny' },
    });
    const outcome = await runOn(harness, alpha);

    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') throw new Error('unreachable');
    expect(outcome.code).toBe('item-budget-exceeded-denied');
    expect(alpha.submissions.length).toBe(0);
  });

  test('an objection stops without submitting, and reports rather than going quiet', async () => {
    const harness = buildHarness({ merchant: alpha, answer: { answer: 'object' } });
    const outcome = await runOn(harness, alpha);

    expect(outcome.kind).toBe('cancelled');
    if (outcome.kind !== 'cancelled') throw new Error('unreachable');
    expect(alpha.submissions.length).toBe(0);
    expect(harness.recorded.length).toBe(0);
    expect(outcome.report.length).toBeGreaterThan(0);
    expect(harness.ledger.state().reservations.length).toBe(0);
    // Nothing was typed after the objection, and nothing is left armed.
    expect(harness.redactor.hasLiveMaterial('session-1', 'page-1')).toBe(false);
  });

  test('an unrecognised merchant asks even well within budget, and silence denies', async () => {
    const harness = buildHarness({
      merchant: alpha, origin: UNRECOGNISED_ORIGIN, answer: null,
    });
    const outcome = await runOn(harness, alpha);

    expect(harness.notices.length).toBe(1);
    expect(harness.notices[0]?.kind).toBe('approval');
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') throw new Error('unreachable');
    // NOT a budget code: this purchase was comfortably inside the budget and
    // the ledger must not claim otherwise.
    expect(outcome.code).toBe('merchant-not-recognised-expired');
    expect(outcome.reason).toContain('jeffsgadgets.biz');
    expect(alpha.submissions.length).toBe(0);
  });

  test('an unrecognised merchant he approves goes through, and the record says he was asked', async () => {
    const harness = buildHarness({
      merchant: alpha,
      origin: UNRECOGNISED_ORIGIN,
      answer: { answer: 'approve' },
    });
    const outcome = await runOn(harness, alpha);

    expect(outcome.kind).toBe('purchased');
    if (outcome.kind !== 'purchased') throw new Error('unreachable');
    expect(outcome.record.windowKind).toBe('approval');
    expect(outcome.record.merchantRecognised).toBe(false);
    expect(outcome.record.merchantQualifier).toBe(null);
  });

  test('the notice states which mode it is in and why this merchant put it there', async () => {
    const recognised = buildHarness({ merchant: alpha });
    await runOn(recognised, alpha);
    const unrecognised = buildHarness({
      merchant: beta, origin: UNRECOGNISED_ORIGIN, answer: { answer: 'approve' },
    });
    await runOn(unrecognised, beta);

    // Same facts, opposite rules, and each says which it is.
    expect(recognised.notices[0]?.message).toContain('bestbuy.com');
    expect(unrecognised.notices[0]?.message).toContain('jeffsgadgets.biz');
    expect(unrecognised.notices[0]?.message.toLowerCase()).toContain('recourse');
  });

  test('a checkout that leaves the recourse-bearing domain is treated as unrecognised', async () => {
    const harness = buildHarness({
      merchant: alpha,
      origin: UNRECOGNISED_ORIGIN,
      storefrontHost: 'www.bestbuy.com',
      answer: null,
    });
    const outcome = await runOn(harness, alpha);

    expect(harness.notices[0]?.kind).toBe('approval');
    expect(harness.notices[0]?.message).toContain('bestbuy.com');
    expect(outcome.kind).toBe('refused');
  });

  test('exactly one message is sent on every path that reaches the window', async () => {
    for (const options of [
      { merchant: alpha },
      { merchant: alpha, dailyItemMinorUnits: 5_000, answer: { answer: 'approve' as const } },
      { merchant: alpha, answer: { answer: 'object' as const } },
      { merchant: alpha, origin: UNRECOGNISED_ORIGIN, answer: null },
    ]) {
      const harness = buildHarness(options);
      await runOn(harness, alpha);
      expect(harness.notices.length).toBe(1);
    }
  });

  test('an undeliverable notice proceeds within budget and denies over it', async () => {
    const within = buildHarness({ merchant: alpha, deliverable: false });
    const withinOutcome = await runOn(within, alpha);
    expect(withinOutcome.kind).toBe('purchased');

    const over = buildHarness({ merchant: beta, dailyItemMinorUnits: 5_000, deliverable: false });
    const overOutcome = await runOn(over, beta);
    expect(overOutcome.kind).toBe('refused');
    if (overOutcome.kind !== 'refused') throw new Error('unreachable');
    expect(overOutcome.code).toBe('item-budget-exceeded-undeliverable');
    expect(beta.submissions.length).toBe(0);
  });
});

// ═══ 9. The shipping step-down ═════════════════════════════════════════════

describe('the shipping ladder', () => {
  test('steps down one rung when the overage pool cannot cover the preferred tier, and records it', async () => {
    const harness = buildHarness({ merchant: alpha, dailyOverageMinorUnits: 2_600 });
    const request: PurchaseRequest = { ...harness.request, preferredTier: 'fastest' };
    const reading = await readFixtureCheckout(alpha);
    const outcome = await runCheckout(request, reading, harness.controls, harness.deps);

    expect(outcome.kind).toBe('purchased');
    if (outcome.kind !== 'purchased') throw new Error('unreachable');
    // tax 1097 + fee 150 = 1247. Overnight 2999 needs 4246 and 2600 is
    // available; two-day 1299 needs 2546, which fits. One rung, not straight
    // to the cheapest.
    expect(outcome.record.shippingTierRequested).toBe('fastest');
    expect(outcome.record.shippingTierUsed).toBe('fast');
    expect(outcome.record.steppedDown).toBe(true);
    expect(outcome.record.shippingMinorUnits).toBe(1_299);

    // Applied to the page, not merely decided.
    expect(harness.driver.formState.get('ship-two-day')).toBe('Two-day');
    // And he was told, in the same one message.
    expect(harness.notices[0]?.message.toLowerCase()).toContain('stepped down from fastest');
  });

  test('no step-down means the requested tier, recorded as such', async () => {
    const harness = buildHarness({ merchant: alpha });
    const request: PurchaseRequest = { ...harness.request, preferredTier: 'fastest' };
    const reading = await readFixtureCheckout(alpha);
    const outcome = await runCheckout(request, reading, harness.controls, harness.deps);

    expect(outcome.kind).toBe('purchased');
    if (outcome.kind !== 'purchased') throw new Error('unreachable');
    expect(outcome.record.shippingTierUsed).toBe('fastest');
    expect(outcome.record.steppedDown).toBe(false);
    expect(outcome.record.shippingMinorUnits).toBe(2_999);
  });
});

// ═══ Failure handling ══════════════════════════════════════════════════════

describe('when the merchant interrupts or the process dies', () => {
  test('a 3-D Secure challenge pauses cleanly and hands over the exact step', async () => {
    const harness = buildHarness({
      merchant: alpha,
      challenge: {
        kind: '3d-secure',
        step: 'Approve the payment in your banking app, then tell me to carry on.',
        url: `${RECOGNISED_ORIGIN}/3ds`,
      },
    });
    const outcome = await runOn(harness, alpha);

    expect(outcome.kind).toBe('challenge');
    if (outcome.kind !== 'challenge') throw new Error('unreachable');
    expect(outcome.challenge.kind).toBe('3d-secure');
    expect(outcome.reason).toContain('banking app');
    // Nothing recorded as a purchase, and the money stays held, because the
    // order may still complete once he answers.
    expect(harness.recorded.length).toBe(0);
    expect(harness.ledger.state().reservations.length).toBe(1);
    // The material is off the page's read paths either way.
    expect(harness.redactor.hasLiveMaterial('session-1', 'page-1')).toBe(false);
  });

  test('a CAPTCHA pauses the same way, without anything trying to answer it', async () => {
    const harness = buildHarness({
      merchant: alpha,
      challenge: { kind: 'captcha', step: 'Solve the picture puzzle on screen.', url: `${RECOGNISED_ORIGIN}/c` },
    });
    const outcome = await runOn(harness, alpha);
    expect(outcome.kind).toBe('challenge');
    expect(alpha.submissions.length).toBe(0);
  });

  test('a submit that throws leaves "possibly submitted" and is never retried', async () => {
    const harness = buildHarness({ merchant: alpha, failSubmit: true });
    const outcome = await runOn(harness, alpha);

    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') throw new Error('unreachable');
    expect(outcome.reason).toContain('cannot tell whether');
    expect(outcome.reason).toContain('will not try again');

    // The journal is the thing a restart reads, and it says the honest answer.
    const interrupted = await harness.registry.interrupted();
    expect(interrupted.length).toBe(1);
    expect(interrupted[0]?.verdict).toBe('possibly-submitted');
    // The budget stays held: it may well have been spent.
    expect(harness.ledger.state().reservations.length).toBe(1);
    expect(harness.recorded.length).toBe(0);
  });

  test('every phase before the submit is unambiguously "not submitted"', () => {
    expect(verdictFor('deciding')).toBe('not-submitted');
    expect(verdictFor('awaiting-window')).toBe('not-submitted');
    expect(verdictFor('arming-payment')).toBe('not-submitted');
    expect(verdictFor('submit-pending')).toBe('possibly-submitted');
    expect(verdictFor('submitted')).toBe('submitted');
  });

  test('what a restart tells him distinguishes the three cases in plain words', () => {
    const record = {
      purchaseId: 'p-1', sessionId: 's', pageId: 'p', merchantDomain: 'bestbuy.com',
      cardId: 'card-1', item: 'thing', currency: 'USD' as const, phase: 'submit-pending' as const,
      startedAtMs: 0, updatedAtMs: 0, draw: null, reservationId: null,
      shippingTierRequested: 'normal' as const, shippingTierUsed: null, stepDown: null,
      totalMinorUnits: null,
    };
    expect(describeInterruption(record, 'not-submitted')).toContain('Nothing was charged');
    expect(describeInterruption(record, 'possibly-submitted')).toContain('order history');
    expect(describeInterruption(record, 'possibly-submitted')).toContain('will not retry');
    expect(describeInterruption(record, 'submitted')).toContain('recorded');
  });

  test('two purchases cannot drive the same page at once', async () => {
    const harness = buildHarness({ merchant: alpha, challenge: { kind: 'otp', step: 'x', url: 'https://x.test/' } });
    await runOn(harness, alpha);
    // The first is paused mid-flight and still owns the page.
    await expect(runOn(harness, alpha)).rejects.toThrow(/already in flight/);
  });
});

// ═══ Nothing here knows a merchant ═════════════════════════════════════════

describe('the flow is merchant-agnostic by construction', () => {
  test('the two fixtures share no markup, no wording and no number format', async () => {
    const alphaHtml = await alpha.checkoutHtml();
    const betaHtml = await beta.checkoutHtml();

    expect(alphaHtml).toContain('$129.00');
    expect(betaHtml).toContain('1.299,00');
    expect(alphaHtml).toContain('autocomplete="cc-number"');
    expect(betaHtml).not.toContain('autocomplete');
    expect(alphaHtml).toContain('Sales tax');
    expect(betaHtml).toContain('Umsatzsteuer');
    expect(alphaHtml).toContain('<table');
    expect(betaHtml).not.toContain('<table');
  });

  test('no shipped source file names either fixture, or any merchant markup', async () => {
    // A selector table would have to live somewhere. This is the check that
    // notices the first one, while it is still one line.
    const { Glob } = await import('bun');
    const glob = new Glob('packages/sdk/src/platform/payments/**/*.ts');
    const offenders: string[] = [];
    for await (const path of glob.scan({ cwd: process.cwd() })) {
      const source = await Bun.file(path).text();
      for (const marker of ['bezeichnung', 'kreditkartennummer', 'data-amount', 'querySelector', 'td.price']) {
        if (source.includes(marker)) offenders.push(`${path}: ${marker}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
