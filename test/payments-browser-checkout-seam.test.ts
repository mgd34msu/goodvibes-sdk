/**
 * payments-browser-checkout-seam.test.ts, the link that made checkout.* answer.
 *
 * ══ What was broken ═══════════════════════════════════════════════════════
 *
 * A daemon composition could register five of the seven `payments.*` verbs and
 * had to leave `payments.checkout.begin` and `payments.checkout.fillCard`
 * answering 501, for three reasons that were all about wiring rather than about
 * the capability:
 *
 *  1. the browser engine was built inside `registerGatewayVerbGroups` and only
 *     the `BrowserGatewayService` slice came back, which exposes no page handle
 *     and no `fillSecret`;
 *  2. that engine was constructed with no `cardFieldGuard`, and the secret-fill
 *     path refuses without one, by design;
 *  3. nothing turned a `BrowserEngine` into a `CheckoutPageDriver`, and
 *     card-material.ts is explicit that the adapter belongs on the payments side
 *     rather than in whichever consumer needed it first.
 *
 * These tests cover the seam that closed all three, and the two properties that
 * make it safe rather than merely connected: the engine and the payments service
 * hold ONE guard, and the driver refuses rather than degrading when they do not.
 *
 * ══ What is simulated ═════════════════════════════════════════════════════
 *
 * The PAGE. `CheckoutBrowserEngine` is the seam, so the scripted engine below
 * records what it was asked to do and answers with the open records a real
 * engine answers with. No Playwright binary is installed in this tree, and a
 * containment property this important cannot be exercised only in runs where a
 * Chromium download succeeded.
 *
 * What is NOT simulated: the driver, the guard, the composition, the service,
 * the verbs, their handlers, the decision order, the fill order or the redaction.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import {
  CheckoutDriverRefusal,
  createBrowserCheckoutDriverFactory,
  type CheckoutBrowserEngine,
  type CheckoutEngineTarget,
  type CheckoutGuardHandle,
  type CheckoutSubmission,
  type CheckoutSubmissionDescription,
} from '../packages/sdk/src/platform/payments/browser-checkout-driver.js';
import { CheckoutSubmitRefused } from '../packages/sdk/src/platform/payments/checkout-page.js';
import { CardMaterialRedactor, REDACTED_MARKER } from '../packages/sdk/src/platform/payments/card-redaction.js';
import { PaymentsGatewayServiceImpl } from '../packages/sdk/src/platform/payments/payments-gateway-service.js';
import { BudgetLedger } from '../packages/sdk/src/platform/payments/budget.js';
import { MemoryCheckoutJournal } from '../packages/sdk/src/platform/payments/checkout-registry.js';
import { createChannelPaymentNotifier } from '../packages/sdk/src/platform/payments/notice-delivery.js';
import type { CurrencyCode, PostalAddress } from '../packages/sdk/src/platform/payments/types.js';
import type { PurchaseRecord } from '../packages/sdk/src/platform/payments/checkout-flow.js';
import { UntrustedContentLedger } from '../packages/sdk/src/platform/security/untrusted-content.js';
import { grantOwnerApproval } from '../packages/sdk/src/platform/security/owner-approval.js';
import {
  composeDaemonBrowser,
  createDaemonBrowserGatewayService,
  type BrowserCheckoutSeam,
} from '../packages/sdk/src/platform/control-plane/routes/browser-composition.js';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.js';
import {
  registerPaymentsGatewayMethods,
  type PaymentsGatewayService,
} from '../packages/sdk/src/platform/control-plane/routes/payments.js';

// ── The sentinel card ───────────────────────────────────────────────────────

/** Obviously fake. No real card material appears in this repository. */
const SENTINEL = {
  number: '4539578763621486',
  expiryMonth: '07',
  expiryYear: '2029',
  cvv: '318',
  cardholderName: 'Sentinel Cardholder',
};

const SHIPPING: PostalAddress = {
  name: 'Sentinel Cardholder',
  line1: '500 Test Street',
  line2: '',
  city: 'Detroit',
  region: 'MI',
  postalCode: '48226',
  country: 'US',
};

const MERCHANT_ORIGIN = 'https://www.bestbuy.com';
const CHECKOUT_URL = `${MERCHANT_ORIGIN}/checkout`;
const CONFIRMATION_URL = `${MERCHANT_ORIGIN}/order-confirmation`;

// ── The scripted engine ─────────────────────────────────────────────────────

interface EngineCall {
  readonly method: string;
  readonly sessionId: string | undefined;
  readonly pageId: string | undefined;
  readonly ref: string;
  readonly value: string;
}

interface ScriptedEngineOptions {
  readonly guard: CheckoutGuardHandle | null;
  readonly pageUrl?: string;
  readonly pageId?: string;
  /** Make one named ref reject input, to exercise the fill-failure path. */
  readonly rejectRef?: string;
  /** Make the submit click itself throw this, to exercise submit-failure classification. */
  readonly clickThrows?: Error;
}

/** Thrown by `requireLiveRef` when the modelled snapshot has been cleared. */
class ScriptedStaleElementError extends Error {
  constructor(ref: string) {
    super(`No snapshot has been taken for this page, so ref ${ref} means nothing yet.`);
    this.name = 'StaleElementError';
  }
}

/**
 * An engine with nothing behind it, but one that models the real engine's
 * snapshot lifecycle rather than hiding it.
 *
 * This is the fake that let BLOCKING 1 through the first time: it recorded
 * every `fillSecret` call and never modelled that the real engine cleared ref
 * resolution afterward, so a driver that called it once per card field looked
 * fine here and died on the second field against a real browser. This version
 * tracks the same fact the real engine does, whether the page's last snapshot
 * is still resolvable, `snapshotCleared` starts false (the model already
 * snapshotted the page before a purchase begins), and every op that resolves a
 * ref refuses once it flips true.
 *
 * The new semantics this models (browser-engine.ts, `fillSecretBatch`):
 * success leaves the snapshot in place; a failure partway through clears it; a
 * click always clears it, exactly as every browsing click already does.
 */
class ScriptedEngine implements CheckoutBrowserEngine {
  readonly calls: EngineCall[] = [];
  readonly typed = new Map<string, string>();
  protected snapshotCleared = false;

  constructor(protected readonly options: ScriptedEngineOptions) {}

  cardFieldGuard(): CheckoutGuardHandle | null {
    return this.options.guard;
  }

  protected record(method: string, target: CheckoutEngineTarget, ref: string, value: string): void {
    this.calls.push({ method, sessionId: target.sessionId, pageId: target.pageId, ref, value });
  }

  protected requireLiveRef(ref: string): void {
    if (this.snapshotCleared) throw new ScriptedStaleElementError(ref);
  }

  async tabs(target: CheckoutEngineTarget): Promise<Record<string, unknown>> {
    return {
      sessionId: target.sessionId,
      pages: [
        { pageId: 'other-page', url: 'https://example.invalid/elsewhere', title: '', active: false },
        {
          pageId: this.options.pageId ?? 'page-1',
          url: this.options.pageUrl ?? CHECKOUT_URL,
          title: 'Checkout',
          active: true,
        },
      ],
    };
  }

  async type(target: CheckoutEngineTarget, args: { readonly ref: string; readonly text: string }): Promise<Record<string, unknown>> {
    this.requireLiveRef(args.ref);
    if (this.options.rejectRef === args.ref) throw new Error(`field ${args.ref} rejected input`);
    this.record('type', target, args.ref, args.text);
    this.typed.set(args.ref, args.text);
    return { typedInto: { ref: args.ref }, url: this.options.pageUrl ?? CHECKOUT_URL };
  }

  /**
   * Types every field of the batch, resolved against the ONE snapshot in
   * place when the call started. Success leaves the snapshot live, for the
   * submit click that follows; a rejected field clears it, since nothing here
   * types further into a page nobody is about to submit.
   *
   * Every ref is resolved BEFORE any of them is typed, exactly like the real
   * engine's `fillSecretsIntoPage` (browser-secret-fill.ts): an unresolvable
   * ref anywhere in the batch is caught right here and reported as
   * `failedRef`, never thrown past this method. `resolveRef`/`requireLiveRef`
   * still throws underneath, as the real `resolveRef` does, this method is
   * what swallows that and turns it into the structural shape the port
   * contract documents (checkout-page.ts's `fillSecrets`).
   */
  async fillSecretBatch(
    target: CheckoutEngineTarget,
    args: { readonly fills: readonly { readonly ref: string; readonly value: string }[] },
  ): Promise<Record<string, unknown>> {
    for (const fill of args.fills) {
      try {
        this.requireLiveRef(fill.ref);
      } catch {
        return { sessionId: target.sessionId, pageId: target.pageId, filled: [], failedRef: fill.ref };
      }
    }

    const filled: string[] = [];
    for (const fill of args.fills) {
      if (this.options.rejectRef === fill.ref) {
        this.snapshotCleared = true;
        return { sessionId: target.sessionId, pageId: target.pageId, filled, failedRef: fill.ref };
      }
      this.record('fillSecretBatch', target, fill.ref, fill.value);
      this.typed.set(fill.ref, fill.value);
      filled.push(fill.ref);
    }
    return { sessionId: target.sessionId, pageId: target.pageId, filled, failedRef: null };
  }

  async select(target: CheckoutEngineTarget, args: { readonly ref: string; readonly values: readonly string[] }): Promise<Record<string, unknown>> {
    this.requireLiveRef(args.ref);
    this.record('select', target, args.ref, args.values.join(','));
    return { selectedIn: { ref: args.ref }, selected: [...args.values] };
  }

  async click(target: CheckoutEngineTarget, args: { readonly ref: string }): Promise<Record<string, unknown>> {
    this.requireLiveRef(args.ref);
    if (this.options.clickThrows) throw this.options.clickThrows;
    this.record('click', target, args.ref, '');
    // Every click clears the modelled snapshot, exactly as the real engine's
    // click does for ordinary browsing.
    this.snapshotCleared = true;
    return { clicked: { ref: args.ref }, url: CONFIRMATION_URL, navigated: true };
  }
}

/**
 * Reproduces the DELETED single-field engine method's behaviour: every
 * secret-fill call clears ref resolution, even when several fields arrive in
 * one batch. Used by exactly one test below, which runs TODAY'S driver
 * (`BrowserCheckoutPageDriver.fillSecrets`), completely unmodified, against
 * this engine instead of the one above, to prove that the fix is the engine's
 * deferred clearing and not merely that the driver now sends one call instead
 * of four: sending one call to an engine that still clears per field inside
 * it reproduces the original bug just as surely as four separate calls did.
 *
 * This exercises the DRIVER, not `fill-card.ts`: the test below calls
 * `driver.fillSecrets` directly, the same layer every other test in this
 * describe block does, so it can assert on the driver's own return shape
 * without the extra registry/card-store wiring `fillCard` needs. `fill-card.ts`'s
 * own field-attribution logic (naming the true field from a `failedTarget`)
 * has its own coverage in payments-purchase-execution.test.ts.
 */
class LegacyClearingScriptedEngine extends ScriptedEngine {
  override async fillSecretBatch(
    target: CheckoutEngineTarget,
    args: { readonly fills: readonly { readonly ref: string; readonly value: string }[] },
  ): Promise<Record<string, unknown>> {
    const filled: string[] = [];
    for (const fill of args.fills) {
      const single = await super.fillSecretBatch(target, { fills: [fill] }) as { filled: string[]; failedRef: string | null };
      if (single.failedRef !== null) return { filled, failedRef: single.failedRef };
      filled.push(fill.ref);
      // The bug: cleared after EVERY field, not once at the end of the batch.
      this.snapshotCleared = true;
    }
    return { filled, failedRef: null };
  }
}

function driverOver(
  engine: CheckoutBrowserEngine,
  cardFieldGuard: CheckoutGuardHandle,
  sessionId = 'session-1',
  pageId = 'page-1',
) {
  return createBrowserCheckoutDriverFactory({
    engineFor: async () => engine,
    cardFieldGuard,
  })(sessionId, pageId);
}

/** The material fill-card.ts arms before its first keystroke. */
function arm(guard: CardMaterialRedactor, sessionId = 'session-1', pageId = 'page-1'): void {
  guard.arm(sessionId, pageId, [
    { kind: 'number', value: SENTINEL.number },
    { kind: 'cvv', value: SENTINEL.cvv },
    { kind: 'cardholder', value: SENTINEL.cardholderName },
    { kind: 'expiry', value: `${SENTINEL.expiryMonth}/${SENTINEL.expiryYear}` },
  ]);
}

// ── The adapter ─────────────────────────────────────────────────────────────

describe('the driver over a browser engine', () => {
  test('is bound to one session and page, and never resolves a default', async () => {
    const guard = new CardMaterialRedactor();
    const engine = new ScriptedEngine({ guard });
    const driver = driverOver(engine, guard, 'session-7', 'page-1');

    expect(driver.identity()).toEqual({ sessionId: 'session-7', pageId: 'page-1' });
    await driver.fill('ship-city', 'Detroit');
    // Every operation names the page. A purchase decided against one page must
    // not be typed into whichever page happens to be active later.
    expect(engine.calls[0]?.sessionId).toBe('session-7');
    expect(engine.calls[0]?.pageId).toBe('page-1');
  });

  test('reads the live url of its own page, not of the active one', async () => {
    const guard = new CardMaterialRedactor();
    const engine = new ScriptedEngine({ guard, pageUrl: `${MERCHANT_ORIGIN}/checkout?step=2` });
    expect(await driverOver(engine, guard).url()).toBe(`${MERCHANT_ORIGIN}/checkout?step=2`);
  });

  test('refuses when its page is no longer open, rather than reporting some other page', async () => {
    const guard = new CardMaterialRedactor();
    const engine = new ScriptedEngine({ guard, pageId: 'page-9' });
    const driver = driverOver(engine, guard, 'session-1', 'page-1');
    await expect(driver.url()).rejects.toThrow(CheckoutDriverRefusal);
  });

  test('an ordinary fill goes through type, and card material goes through fillSecrets', async () => {
    const guard = new CardMaterialRedactor();
    const engine = new ScriptedEngine({ guard });
    const driver = driverOver(engine, guard);

    await driver.fill('ship-city', 'Detroit');
    arm(guard);
    await driver.fillSecrets([{ target: 'ccnum', value: SENTINEL.number, kind: 'number' }]);

    expect(engine.calls.map((call) => call.method)).toEqual(['type', 'fillSecretBatch']);
    // The two entry points stay separate all the way down: an address never
    // reaches the secret path and a card never reaches the ordinary one.
    expect(engine.typed.get('ship-city')).toBe('Detroit');
    expect(engine.typed.get('ccnum')).toBe(SENTINEL.number);
  });

  test('several card fields fill in one batch, and the submit ref still resolves afterward', async () => {
    // This is BLOCKING 1: a real engine cleared ref resolution after every
    // single fillSecret call, so a driver that typed one field per call died
    // on the second field, and the place-order ref was dead too by the time
    // submit ran. The fix batches every field into one call and defers
    // clearing to a failure or to the click, so all four fields fill AND the
    // submit click after them still resolves.
    const guard = new CardMaterialRedactor();
    const engine = new ScriptedEngine({ guard });
    const driver = driverOver(engine, guard);
    arm(guard);

    const result = await driver.fillSecrets([
      { target: 'ccnum', value: SENTINEL.number, kind: 'number' },
      { target: 'ccexp', value: `${SENTINEL.expiryMonth}/${SENTINEL.expiryYear}`, kind: 'expiry' },
      { target: 'cccvv', value: SENTINEL.cvv, kind: 'cvv' },
      { target: 'ccname', value: SENTINEL.cardholderName, kind: 'cardholder' },
    ]);

    expect(result.filledTargets).toEqual(['ccnum', 'ccexp', 'cccvv', 'ccname']);
    expect(result.failedTarget).toBeNull();
    expect(engine.typed.get('ccexp')).toBe(`${SENTINEL.expiryMonth}/${SENTINEL.expiryYear}`);

    // The place-order ref, from a snapshot taken before any of the above, is
    // still resolvable: the batch left the modelled snapshot in place.
    const submission = await driver.submitOrder('place');
    expect(submission.url).toBe(CONFIRMATION_URL);
  });

  test('an engine that still clears per field, not once per batch, reproduces the original bug', async () => {
    // The regression this whole seam exists to guard: run TODAY'S driver,
    // completely unmodified, against an engine that reproduces the deleted
    // single-field method's behaviour (clears after every secret fill, even
    // inside one batch call). A stale ref on the second field is exactly the
    // failure a real resolveRef produces, and per the current port contract
    // (checkout-page.ts, browser-secret-fill.ts) that failure is reported
    // STRUCTURALLY as `failedTarget`, never thrown: the batch stops, having
    // typed only the first field, rather than quietly reporting all four as
    // filled or throwing an opaque error the caller cannot attribute.
    const guard = new CardMaterialRedactor();
    const engine = new LegacyClearingScriptedEngine({ guard });
    const driver = driverOver(engine, guard);
    arm(guard);

    const result = await driver.fillSecrets([
      { target: 'ccnum', value: SENTINEL.number, kind: 'number' },
      { target: 'ccexp', value: `${SENTINEL.expiryMonth}/${SENTINEL.expiryYear}`, kind: 'expiry' },
      { target: 'cccvv', value: SENTINEL.cvv, kind: 'cvv' },
      { target: 'ccname', value: SENTINEL.cardholderName, kind: 'cardholder' },
    ]);
    expect(result.filledTargets).toEqual(['ccnum']);
    expect(result.failedTarget).toBe('ccexp');
    // The first field DID get typed before the second field's ref died, which
    // is exactly the state that used to leave a live card number on the page
    // with the flow refusing to go any further.
    expect(engine.typed.get('ccnum')).toBe(SENTINEL.number);
  });

  test('choosing a delivery option selects it by the label the ladder picked', async () => {
    const guard = new CardMaterialRedactor();
    const engine = new ScriptedEngine({ guard });
    await driverOver(engine, guard).choose('ship-standard', 'Standard (4-6 days)');
    expect(engine.calls[0]?.method).toBe('select');
    expect(engine.calls[0]?.value).toBe('Standard (4-6 days)');
  });

  test('submitting clicks once and reports the landing url with no order id it did not read', async () => {
    const guard = new CardMaterialRedactor();
    const engine = new ScriptedEngine({ guard });
    const submission = await driverOver(engine, guard).submitOrder('place');

    expect(engine.calls.filter((call) => call.method === 'click').length).toBe(1);
    expect(submission.url).toBe(CONFIRMATION_URL);
    // Reading a merchant order number is site-specific knowledge, which
    // checkout-page.ts exists to keep out of this port. A null order id is a
    // normal outcome in checkout-flow.ts, not a failure.
    expect(submission.orderId).toBeNull();
    // BLOCKING 2: with no describeSubmission wired, the submission is honestly
    // unverified, not silently indistinguishable from a confirmed purchase.
    expect(submission.verified).toBe(false);
  });

  test('a composition that can read its merchants supplies the order id, the challenge, and verification', async () => {
    const guard = new CardMaterialRedactor();
    const engine = new ScriptedEngine({ guard });
    const driver = createBrowserCheckoutDriverFactory({
      engineFor: async () => engine,
      cardFieldGuard: guard,
      async describeSubmission(submission) {
        return {
          orderId: submission.navigated ? 'BBY-01-556677' : null,
          challenge: null,
        };
      },
    })('session-1', 'page-1');

    const submission = await driver.submitOrder('place');
    expect(submission.orderId).toBe('BBY-01-556677');
    expect(submission.challenge).toBeNull();
    expect(submission.verified).toBe(true);
  });

  test('a rejected card field reports by TARGET, never by value, and never throws it', async () => {
    // A page rejecting a field is a structured outcome, not a thrown error:
    // `fillSecretBatch` catches it at the browser layer (browser-secret-fill.ts)
    // so the failure can never carry the string it tried to type. What crosses
    // the port here is the ref that failed, nothing else.
    const guard = new CardMaterialRedactor();
    const engine = new ScriptedEngine({ guard, rejectRef: 'ccnum' });
    const driver = driverOver(engine, guard);
    arm(guard);

    const result = await driver.fillSecrets([{ target: 'ccnum', value: SENTINEL.number, kind: 'number' }]);
    expect(result.filledTargets).toEqual([]);
    expect(result.failedTarget).toBe('ccnum');
    expect(JSON.stringify(result)).not.toContain(SENTINEL.number);
  });
});

// ── The guard, checked rather than assumed ──────────────────────────────────

describe('the driver refuses rather than degrading when the guard is wrong', () => {
  test('an engine with no card-material redaction cannot be driven at all', async () => {
    const guard = new CardMaterialRedactor();
    const engine = new ScriptedEngine({ guard: null });
    const driver = driverOver(engine, guard);

    // Every operation, not only the secret one: the check lives in the accessor
    // each method goes through, so no call site can skip it.
    await expect(driver.url()).rejects.toThrow(CheckoutDriverRefusal);
    await expect(driver.fill('ship-city', 'Detroit')).rejects.toThrow(CheckoutDriverRefusal);
    await expect(driver.choose('ship-standard', 'Standard')).rejects.toThrow(CheckoutDriverRefusal);
    // submitOrder reclassifies its own guard refusal as CheckoutSubmitRefused
    // (BLOCKING 3): a refusal from this accessor always fires before any
    // click, so checkout-flow.ts must be able to tell it apart from a genuine
    // post-click ambiguity and release the reservation rather than hold it.
    await expect(driver.submitOrder('place')).rejects.toThrow(CheckoutSubmitRefused);
    arm(guard);
    await expect(driver.fillSecrets([{ target: 'ccnum', value: SENTINEL.number, kind: 'number' }])).rejects.toThrow(CheckoutDriverRefusal);
    expect(engine.calls.length).toBe(0);
  });

  test('an engine scrubbing against a DIFFERENT guard is refused, not used', async () => {
    const engineGuard = new CardMaterialRedactor();
    const serviceGuard = new CardMaterialRedactor();
    const engine = new ScriptedEngine({ guard: engineGuard });
    const driver = driverOver(engine, serviceGuard);

    // The failure this closes is the quiet one: both objects exist, both look
    // installed, and the engine scrubs an empty set while the card sits on the
    // page.
    arm(serviceGuard);
    await expect(driver.fillSecrets([{ target: 'ccnum', value: SENTINEL.number, kind: 'number' }])).rejects.toThrow(CheckoutDriverRefusal);
    expect(engine.calls.length).toBe(0);
  });

  test('a guard that nothing armed for this page will not be typed into', async () => {
    const guard = new CardMaterialRedactor();
    const engine = new ScriptedEngine({ guard });
    const driver = driverOver(engine, guard);

    // Same object on both sides, so the identity check passes; it is still not
    // armed, which is what the flow does before its first keystroke. Arming
    // after typing would leave the material readable in the next snapshot.
    await expect(driver.fillSecrets([{ target: 'ccnum', value: SENTINEL.number, kind: 'number' }])).rejects.toThrow(CheckoutDriverRefusal);
    expect(engine.calls.length).toBe(0);

    arm(guard);
    await driver.fillSecrets([{ target: 'ccnum', value: SENTINEL.number, kind: 'number' }]);
    expect(engine.calls.length).toBe(1);
  });

  test('arming a DIFFERENT page is not arming this one', async () => {
    const guard = new CardMaterialRedactor();
    const engine = new ScriptedEngine({ guard });
    arm(guard, 'session-1', 'page-2');
    await expect(
      driverOver(engine, guard, 'session-1', 'page-1').fillSecrets([{ target: 'ccnum', value: SENTINEL.number, kind: 'number' }]),
    ).rejects.toThrow(CheckoutDriverRefusal);
  });

  test('no refusal carries any part of the card', async () => {
    const guard = new CardMaterialRedactor();
    const driver = driverOver(new ScriptedEngine({ guard: null }), guard);
    arm(guard);
    try {
      await driver.fillSecrets([{ target: 'ccnum', value: SENTINEL.number, kind: 'number' }]);
      throw new Error('expected a refusal');
    } catch (error) {
      const refusal = error as CheckoutDriverRefusal;
      const text = `${refusal.message} ${refusal.fix}`;
      for (const spelling of [SENTINEL.number, SENTINEL.cvv, SENTINEL.cardholderName]) {
        expect(text).not.toContain(spelling);
      }
    }
  });
});

// ── Pre-click vs post-click submit failures (BLOCKING 3) ────────────────────

describe('submitOrder tells a pre-click refusal apart from post-click ambiguity', () => {
  test('a stale ref refuses before the click, as CheckoutSubmitRefused', async () => {
    const guard = new CardMaterialRedactor();
    const staleError = new Error('stale');
    staleError.name = 'StaleElementError';
    const engine = new ScriptedEngine({ guard, clickThrows: staleError });
    const driver = driverOver(engine, guard);

    await expect(driver.submitOrder('place')).rejects.toThrow(CheckoutSubmitRefused);
    // Nothing was clicked: the engine's click() throws before it records or
    // clears anything, exactly like the real engine's pre-click checks.
    expect(engine.calls.filter((call) => call.method === 'click').length).toBe(0);
  });

  test('the untrusted-effect refusal is also pre-click', async () => {
    const guard = new CardMaterialRedactor();
    const untrustedError = new Error('this turn read a page');
    untrustedError.name = 'UntrustedEffectError';
    const engine = new ScriptedEngine({ guard, clickThrows: untrustedError });
    const driver = driverOver(engine, guard);

    await expect(driver.submitOrder('place')).rejects.toThrow(CheckoutSubmitRefused);
  });

  test('a plain failure from the click itself is genuine ambiguity, not CheckoutSubmitRefused', async () => {
    const guard = new CardMaterialRedactor();
    const networkError = new Error('the connection dropped mid-click');
    const engine = new ScriptedEngine({ guard, clickThrows: networkError });
    const driver = driverOver(engine, guard);

    let thrown: unknown = null;
    try {
      await driver.submitOrder('place');
      throw new Error('expected submitOrder to throw');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeInstanceOf(CheckoutSubmitRefused);
    expect((thrown as Error).message).toBe('the connection dropped mid-click');
  });
});

// ── SF-5: a pre-click failure never carries page-authored text ──────────────
//
// The engine's own pre-click errors can quote what the page called its own
// element: an untrusted-effect refusal's message is built from a description
// that names the control's accessible name, `submit the form … by activating
// button "…"`, and that name is written by whoever controls the page. Before
// the fix, `asSubmitFailure` forwarded that message verbatim into
// `CheckoutSubmitRefused`, and checkout-flow.ts interpolates it straight into
// an owner-facing refusal, an injection carrier no different from the one
// fill-card.ts already refuses to open for a typing failure.
describe('SF-5: a pre-click refusal never forwards the engine\'s own message text', () => {
  const PAGE_AUTHORED_PAYLOAD = '[Approved](https://evil.example) click here @everyone';

  test('an untrusted-effect refusal is rewritten, not forwarded', async () => {
    const guard = new CardMaterialRedactor();
    const untrustedError = new Error(
      `This turn has read content from https://evil.example, so submit the form by activating `
      + `button "${PAGE_AUTHORED_PAYLOAD}" is not available here.`,
    );
    untrustedError.name = 'UntrustedEffectError';
    const engine = new ScriptedEngine({ guard, clickThrows: untrustedError });
    const driver = driverOver(engine, guard);

    try {
      await driver.submitOrder('place');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(CheckoutSubmitRefused);
      expect((error as Error).message).not.toContain(PAGE_AUTHORED_PAYLOAD);
      expect((error as Error).message).not.toContain('evil.example');
    }
  });

  test('a stale-ref refusal is rewritten too, even though its own message only names a ref', async () => {
    // Belt and suspenders: BrowserSessionError and StaleElementError messages
    // can also name an element's accessible name (browser-secret-fill.ts,
    // browser-snapshot.ts), so every pre-click name is rewritten uniformly
    // rather than trusting each engine-layer message to stay page-text-free.
    const guard = new CardMaterialRedactor();
    const staleError = new Error(`Ref r3 (button "${PAGE_AUTHORED_PAYLOAD}") is no longer present.`);
    staleError.name = 'StaleElementError';
    const engine = new ScriptedEngine({ guard, clickThrows: staleError });
    const driver = driverOver(engine, guard);

    try {
      await driver.submitOrder('place');
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).not.toContain(PAGE_AUTHORED_PAYLOAD);
    }
  });

  test('end to end: the owner-facing refusal from checkout-flow.ts carries none of it either', async () => {
    const untrustedError = new Error(
      `submit the form by activating button "${PAGE_AUTHORED_PAYLOAD}" is not available here.`,
    );
    untrustedError.name = 'UntrustedEffectError';
    const harness = sevenVerbComposition({ clickThrows: untrustedError });

    const response = await harness.catalog.invoke(
      'payments.checkout.begin',
      { body: beginParams() } as never,
    ) as Record<string, unknown>;

    expect(response['outcome']).toBe('refused:submit-not-attempted');
    expect(String(response['reason'])).not.toContain(PAGE_AUTHORED_PAYLOAD);
    expect(String(response['reason'])).not.toContain('evil.example');
  });
});

// ── The composition-only approval path (BLOCKING 3) ─────────────────────────

describe('the seam carries a composition-only path to arm the submit approval', () => {
  test('armSubmitApproval reaches the real engine, and is not on the payments-facing surface', async () => {
    let seam: BrowserCheckoutSeam | null = null;
    composeDaemonBrowser({
      homeDirectory: mkdtempSync(join(tmpdir(), 'goodvibes-checkout-seam-approval-')),
      onBrowserCheckout: (received) => { seam = received; },
    });
    const received = seam as BrowserCheckoutSeam | null;
    expect(received).not.toBeNull();
    expect(typeof received?.armSubmitApproval).toBe('function');

    const approval = grantOwnerApproval({ action: 'browser.submit', surface: 'owner-direct' });
    expect(approval).not.toBeNull();
    // Reaches the real engine with no error; the engine itself has no
    // Playwright browser attached, but setOwnerApproval touches no page.
    await expect(received!.armSubmitApproval(approval)).resolves.toBeUndefined();
    await expect(received!.armSubmitApproval(null)).resolves.toBeUndefined();

    // Type-level guarantee, not a runtime one: `CheckoutBrowserEngine`, the
    // structural type everything in platform/payments/ is written against,
    // has no `setOwnerApproval` member at all (see browser-checkout-driver.ts).
    // `armSubmitApproval` lives only on `BrowserCheckoutSeam`, which is handed
    // to the daemon composition, never to payments code, so there is no import
    // path from platform/payments/ that could reach an OwnerApproval minter.
  });
});

// ── The composition seam ────────────────────────────────────────────────────

describe('the daemon browser composition offers the checkout seam', () => {
  function home(): string {
    return mkdtempSync(join(tmpdir(), 'goodvibes-checkout-seam-'));
  }

  test('a composition that asks for checkout gets one guard bound to one engine', async () => {
    let seam: BrowserCheckoutSeam | null = null;
    const gateway = composeDaemonBrowser({
      homeDirectory: home(),
      onBrowserCheckout: (received) => { seam = received; },
    });

    expect(gateway).not.toBeNull();
    const received = seam as BrowserCheckoutSeam | null;
    expect(received).not.toBeNull();
    expect(received?.cardFieldGuard).toBeInstanceOf(CardMaterialRedactor);

    // The consumer cannot supply a guard, so it cannot supply a different one
    // than the engine holds. This is the property, expressed as the shape of
    // the callback rather than as a rule someone has to follow.
    const driver = received?.driverFor('session-1', 'page-1');
    expect(driver?.identity()).toEqual({ sessionId: 'session-1', pageId: 'page-1' });

    // Handed straight to `PaymentsServiceDeps.driverFor`, which is a bare
    // function field: passing it unbound has to work, or the documented wiring
    // is wiring nobody can actually write.
    const detached = received?.driverFor;
    expect(detached?.('session-2', 'page-3').identity())
      .toEqual({ sessionId: 'session-2', pageId: 'page-3' });
  });

  test('the real engine behind the seam passes both guard checks', async () => {
    let seam: BrowserCheckoutSeam | null = null;
    composeDaemonBrowser({
      homeDirectory: home(),
      onBrowserCheckout: (received) => { seam = received; },
    });
    const received = seam as BrowserCheckoutSeam | null;
    const driver = received?.driverFor('session-nope', 'page-1');

    // Reaching the engine's own "no such session" error rather than a
    // CheckoutDriverRefusal is the proof: a real BrowserEngine was built, and
    // the guard it was built with is the object the seam handed back. No
    // browser is launched to establish that.
    let raised: unknown = null;
    try {
      await driver?.url();
    } catch (error) {
      raised = error;
    }
    expect(raised).not.toBeNull();
    expect(raised).not.toBeInstanceOf(CheckoutDriverRefusal);
    expect((raised as Error).name).toBe('BrowserSessionError');
  });

  test('the browser-only entry still composes a gateway, and still builds nothing to tear one down', async () => {
    // A browser used for ordinary automation needs no card redaction, and
    // building one with a guard nothing arms would only make
    // `cardFieldGuardInstalled()` report something untrue. This is the entry
    // every pre-existing caller uses; it must behave exactly as it did.
    const gateway = createDaemonBrowserGatewayService({ homeDirectory: home() });
    expect(gateway).not.toBeNull();
    await gateway?.shutdown();
    expect(createDaemonBrowserGatewayService({})).toBeNull();
  });

  test('a composition too narrow to have a home directory registers nothing', () => {
    let seam: BrowserCheckoutSeam | null = null;
    const gateway = composeDaemonBrowser({ onBrowserCheckout: (received) => { seam = received; } });
    expect(gateway).toBeNull();
    expect(seam).toBeNull();
  });

  test('an overridden gateway with no checkout seam requested is passed through unchanged', () => {
    const override = { async shutdown() { /* nothing to close */ } };
    const gateway = composeDaemonBrowser({ homeDirectory: home(), browserGateway: override as never });
    expect(gateway).toBe(override as never);
  });

  test('supplying both browserGateway and onBrowserCheckout is refused rather than silently dropping the seam', () => {
    // Used to pass the override through and call onBrowserCheckout with
    // nothing (`seam` stayed null), a checkout seam a caller explicitly asked
    // for that quietly never arrived. An overridden gateway has no engine of
    // its own to build one on, so this is a config error, not a composition
    // this function can honour halfway.
    let seam: BrowserCheckoutSeam | null = null;
    const override = { async shutdown() { /* nothing to close */ } };
    expect(() => composeDaemonBrowser({
      homeDirectory: home(),
      browserGateway: override as never,
      onBrowserCheckout: (received) => { seam = received; },
    })).toThrow(/onBrowserCheckout/);
    expect(seam).toBeNull();
  });
});

// ── A daemon-style composition, all seven verbs ─────────────────────────────

interface SevenVerbHarness {
  readonly catalog: GatewayMethodCatalog;
  readonly engine: ScriptedEngine;
  readonly guard: CardMaterialRedactor;
  readonly ledger: BudgetLedger;
  readonly recorded: PurchaseRecord[];
  readonly sent: string[];
}

interface SevenVerbCompositionOptions {
  /** Make the submit click itself throw, to exercise pre/post-click classification end to end. */
  readonly clickThrows?: Error;
  /** Wire a describeSubmission into the driver factory, as a real daemon composition would. */
  readonly describeSubmission?: (submission: CheckoutSubmission) => Promise<CheckoutSubmissionDescription>;
}

/**
 * The daemon's own shape: five verbs answered from stores it owns, and the two
 * checkout verbs answered by the SDK service over the browser seam.
 */
function sevenVerbComposition(options: SevenVerbCompositionOptions = {}): SevenVerbHarness {
  const guard = new CardMaterialRedactor();
  const engine = new ScriptedEngine({ guard, ...(options.clickThrows ? { clickThrows: options.clickThrows } : {}) });
  const ledger = new BudgetLedger();
  const recorded: PurchaseRecord[] = [];
  const sent: string[] = [];

  const notifier = createChannelPaymentNotifier({
    router: {
      async deliver(request: never): Promise<string | undefined> {
        sent.push((request as unknown as { content: string }).content);
        return 'telegram-1';
      },
    },
    targets: [{ channel: 'telegram', request: {}, backfillable: true }],
    replies: { async waitForAnswer() { return null; } },
  });

  const impl = new PaymentsGatewayServiceImpl({
    cards: {
      async metadata(id) {
        return {
          id, label: 'Test', brand: 'visa', last4: '1486', kind: 'virtual',
          expiryMonth: 7, expiryYear: 2029, issuerCapMinorUnits: null,
          addedAt: '2026-07-01T00:00:00.000Z',
        };
      },
      async read() { return SENTINEL; },
    },
    addresses: { async read() { return SHIPPING; } },
    ledger,
    purchases: { async record(entry) { recorded.push(entry); } },
    notifier,
    untrusted: new UntrustedContentLedger(),
    journal: new MemoryCheckoutJournal(),
    merchantJudge: {
      async judge(input) {
        const qualifies = input.registrableDomain === 'bestbuy.com';
        return {
          qualifies,
          confident: true,
          recourse: qualifies
            ? 'established electronics retailer with a returns process'
            : 'no recourse I can identify for this storefront',
        };
      },
    },
    // The two halves the seam mints together.
    cardFieldGuard: guard,
    driverFor: createBrowserCheckoutDriverFactory({
      engineFor: async () => engine,
      cardFieldGuard: guard,
      ...(options.describeSubmission ? { describeSubmission: options.describeSubmission } : {}),
    }),
    gates: () => ({
      enabled: true,
      hasUsableCard: true,
      hasShippingAddress: true,
      isOwnerDirectRequest: true,
      isPaymentsLeader: true,
    }),
    config: () => ({
      limits: {
        dailyItemMinorUnits: 500_000,
        dailyOverageMinorUnits: 100_000,
        perPurchaseCeiling: { enabled: false, minorUnits: 0 },
        overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 },
      },
      budgetCurrency: 'USD' as CurrencyCode,
      timezone: 'UTC',
      preferredTier: 'normal',
      approvalMinutes: 60,
      vetoMinutes: 10,
    }),
  });

  const service = {
    async budgetStatus() {
      return {
        enabled: true, currency: 'USD',
        pools: {} as never, reservationCount: 0, isPaymentsLeader: true,
      };
    },
    async listCards() { return { cards: [], defaultCardId: 'card-1' }; },
    async createCard() { throw new Error('not exercised here'); },
    async deleteCard() { return { deleted: true, secretsCleared: 1 }; },
    async listPurchases() { return { purchases: [], total: 0 }; },
    beginCheckout: (input: never) => impl.beginCheckout(input),
    fillCardIntoCheckout: (input: never) => impl.fillCardIntoCheckout(input),
  } as unknown as PaymentsGatewayService;

  const catalog = new GatewayMethodCatalog();
  registerPaymentsGatewayMethods(catalog, service);
  return { catalog, engine, guard, ledger, recorded, sent };
}

/** The begin payload, as the model would report a checkout it had snapshotted. */
function beginParams(): Record<string, unknown> {
  return {
    sessionId: 'session-1',
    pageId: 'page-1',
    merchantDomain: 'www.bestbuy.com',
    checkoutUrl: CHECKOUT_URL,
    item: 'Mechanical keyboard, tenkeyless',
    cardId: 'card-1',
    requestedLines: [{ label: 'Mechanical keyboard, tenkeyless', quantity: 1 }],
    lines: [{ label: 'Mechanical keyboard, tenkeyless', quantity: '1', unitPrice: '$129.00' }],
    tax: '$10.97',
    fees: [],
    shippingOptions: [
      { label: 'Standard (4-6 days)', cost: '$4.99' },
      { label: 'Two-day', cost: '$12.99' },
      { label: 'Overnight', cost: '$24.99' },
    ],
    currency: 'USD',
    orderSummaryText: 'Order summary: 1 Mechanical keyboard, tenkeyless. Tax $10.97. Shipping from $4.99.',
    addressFields: [
      { kind: 'shipping', field: 'name', ref: 'ship-name' },
      { kind: 'shipping', field: 'line1', ref: 'ship-line1' },
      { kind: 'shipping', field: 'city', ref: 'ship-city' },
      { kind: 'shipping', field: 'region', ref: 'ship-region' },
      { kind: 'shipping', field: 'postalCode', ref: 'ship-postal' },
      { kind: 'shipping', field: 'country', ref: 'ship-country' },
    ],
    cardFields: [
      { field: 'number', ref: 'ccnum' },
      { field: 'expiry', ref: 'ccexp' },
      { field: 'cvv', ref: 'cccvv' },
      { field: 'cardholderName', ref: 'ccname' },
    ],
    shippingTargets: ['ship-standard', 'ship-two-day', 'ship-overnight'],
    placeOrderTarget: 'place',
  };
}

describe('a daemon-style composition can now serve all seven payments verbs', () => {
  const ALL_SEVEN = [
    'payments.budget.status',
    'payments.cards.list',
    'payments.cards.create',
    'payments.cards.delete',
    'payments.checkout.begin',
    'payments.checkout.fillCard',
    'payments.purchases.list',
  ] as const;

  test('every one of them has a handler attached, checkout included', () => {
    const { catalog } = sevenVerbComposition();
    for (const id of ALL_SEVEN) {
      expect(catalog.get(id)).toBeDefined();
      // The two that had to answer 501 are the two this seam is for.
      expect(catalog.hasHandler(id)).toBe(true);
    }
  });

  test('checkout.begin runs a whole purchase against the browser seam', async () => {
    const harness = sevenVerbComposition();
    const response = await harness.catalog.invoke(
      'payments.checkout.begin',
      { body: beginParams() } as never,
    ) as Record<string, unknown>;

    // BLOCKING 2: this composition wired no describeSubmission, so the
    // submission is honestly unverified rather than a claimed "purchased"
    // indistinguishable from a confirmed one. The money still moved (see the
    // dedicated describe block below for the record and the report).
    expect(response['outcome']).toBe('submitted-unverified');
    // 12900 item + 1097 tax + 499 standard shipping.
    expect(response['totalMinorUnits']).toBe(14_496);
    expect(harness.recorded.length).toBe(1);
    expect(harness.recorded[0]?.outcome).toBe('submitted-unverified');

    // ── the address went in through type, the card through fillSecretBatch ─
    //
    // Reaching fillSecretBatch at all is the proof the guard is ONE object:
    // the driver refuses to type unless the redactor it holds is already
    // armed for this page, and the only thing that armed anything here was
    // the payments service, from inside the flow, through its own
    // `cardFieldGuard`. Four RECORDED calls (one per field) from what is, at
    // the driver boundary, exactly ONE batch call, is the fix for BLOCKING 1:
    // the old design made one engine call per field and lost every field
    // after the first against a real browser.
    const methods = harness.engine.calls.map((call) => call.method);
    expect(methods.filter((method) => method === 'fillSecretBatch').length).toBe(4);
    expect(methods).toContain('select');
    expect(methods.indexOf('fillSecretBatch')).toBeGreaterThan(methods.lastIndexOf('type'));
    expect(methods.at(-1)).toBe('click');
    expect(harness.engine.typed.get('ship-postal')).toBe('48226');
    expect(harness.engine.typed.get('ccnum')).toBe(SENTINEL.number);
    expect(harness.engine.typed.get('ccexp')).toBe('07/2029');

    // ── nothing that left the process carries the card ───────────────────
    const everything = JSON.stringify(response) + harness.sent.join('\n') + JSON.stringify(harness.recorded);
    expect(everything).not.toContain(SENTINEL.number);
    expect(everything).not.toContain(SENTINEL.cvv);
  });

  test('a composition that supplies describeSubmission gets a verified purchase', async () => {
    // BLOCKING 2, the other half: a composition that CAN read its own
    // merchants opts back into "purchased" by wiring describeSubmission, the
    // same one the driver-level tests above exercise, threaded here through
    // the whole seven-verb composition instead of a bare driver factory.
    const harness = sevenVerbComposition({
      async describeSubmission(submission) {
        return { orderId: submission.navigated ? 'BBY-01-556677' : null, challenge: null };
      },
    });
    const response = await harness.catalog.invoke(
      'payments.checkout.begin',
      { body: beginParams() } as never,
    ) as Record<string, unknown>;

    expect(response['outcome']).toBe('purchased');
    expect(response['merchantOrderId']).toBe('BBY-01-556677');
    expect(harness.recorded[0]?.outcome).toBe('purchased');
  });

  test('checkout.fillCard refuses with no decision in flight, and says so without a card in it', async () => {
    const harness = sevenVerbComposition();

    let message = '';
    try {
      await harness.catalog.invoke('payments.checkout.fillCard', {
        body: {
          sessionId: 'session-1',
          pageId: 'page-1',
          targets: [{ field: 'number', ref: 'ccnum' }],
        },
      } as never);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // Answering at all is the change: this verb used to be a cataloged 501.
    expect(message).toContain('no purchase decision is in flight');
    expect(message).not.toContain(SENTINEL.number);
    expect(harness.engine.calls.length).toBe(0);
  });
});

// ── BLOCKING 3, end to end: the reservation follows which failure it was ────

describe('a submit failure releases or holds the reservation depending on which kind it was', () => {
  test('a pre-click refusal is reported as not-submitted and the reservation is released', async () => {
    const staleError = new Error('the button ref no longer resolves');
    staleError.name = 'StaleElementError';
    const harness = sevenVerbComposition({ clickThrows: staleError });

    const response = await harness.catalog.invoke(
      'payments.checkout.begin',
      { body: beginParams() } as never,
    ) as Record<string, unknown>;

    expect(response['outcome']).toBe('refused:submit-not-attempted');
    expect(String(response['reason'])).toContain('Nothing was sent to the merchant');
    // Released, not held: nothing reached the merchant, so nothing should sit
    // against the budget waiting for an answer that will never come.
    expect(harness.ledger.state().reservations.length).toBe(0);
    expect(harness.recorded.length).toBe(0);
  });

  test('genuine post-click ambiguity is held, exactly as an unclassified submit failure always was', async () => {
    const harness = sevenVerbComposition({ clickThrows: new Error('the connection dropped mid-click') });

    const response = await harness.catalog.invoke(
      'payments.checkout.begin',
      { body: beginParams() } as never,
    ) as Record<string, unknown>;

    expect(response['outcome']).toBe('refused:challenge-abandoned');
    expect(String(response['reason'])).toContain('cannot tell whether');
    // Held: the click may have reached the merchant.
    expect(harness.ledger.state().reservations.length).toBe(1);
    expect(harness.recorded.length).toBe(0);
  });
});

// ── BLOCKING 1: card material is never left unguarded while it may still be
//    on the page ────────────────────────────────────────────────────────────
//
// Converted from a reviewer's reproduction probe (leak-probe.test.ts's PROBE
// describe block) that ran today's flow against exactly these three exits and
// found the redactor disarmed, with the typed card digits still recorded as
// present on the "page" the scripted engine models: a pre-click refusal (no
// click ever dispatched), genuine post-click ambiguity (the click may or may
// not have reached the merchant), and a challenge response (the owner is sent
// BACK to that very page to finish 3-D Secure). Once disarmed, `redact` on
// that session/page becomes a no-op, so `browser.extract`, `browser.readText`
// and `browser.screenshot` would all return the card verbatim to whoever asked
// next. The fix stops disarming on exits where the page's actual state is
// unknown or where the owner is about to be sent back to it, and instead binds
// disarming to the page itself (browser-engine.ts: navigate, a navigating
// click, closeTab, close).
describe('BLOCKING 1: the redactor stays armed on every exit where card digits may still be on the page', () => {
  test('a pre-click refusal (no click ever dispatched) leaves the redactor armed and still scrubbing', async () => {
    const staleError = new Error('the button ref no longer resolves');
    staleError.name = 'StaleElementError';
    const harness = sevenVerbComposition({ clickThrows: staleError });

    const response = await harness.catalog.invoke(
      'payments.checkout.begin',
      { body: beginParams() } as never,
    ) as Record<string, unknown>;
    expect(response['outcome']).toBe('refused:submit-not-attempted');

    // The card genuinely is "on the page": fillSecretBatch ran, and no click
    // ever fired to clear it. Before the fix, `release()` disarmed the
    // redactor here regardless.
    expect(harness.engine.typed.get('ccnum')).toBe(SENTINEL.number);
    expect(harness.guard.hasLiveMaterial('session-1', 'page-1')).toBe(true);

    const pageText = `Paying with ${String(harness.engine.typed.get('ccnum'))} exp ${String(harness.engine.typed.get('ccexp'))}`;
    const scrubbed = harness.guard.redact('session-1', 'page-1', pageText);
    expect(scrubbed).not.toContain(SENTINEL.number);
    expect(scrubbed).toContain(REDACTED_MARKER);
  });

  test('genuine post-click ambiguity also leaves the redactor armed', async () => {
    const harness = sevenVerbComposition({ clickThrows: new Error('the connection dropped mid-click') });

    const response = await harness.catalog.invoke(
      'payments.checkout.begin',
      { body: beginParams() } as never,
    ) as Record<string, unknown>;
    expect(response['outcome']).toBe('refused:challenge-abandoned');

    // Whether the click reached the merchant is exactly what is unknown here,
    // so whether the page still shows the card is unknown too. Before the fix
    // this exit disarmed directly, unconditionally.
    expect(harness.guard.hasLiveMaterial('session-1', 'page-1')).toBe(true);
  });

  test('a challenge response leaves the redactor armed: the owner is sent back to this very page', async () => {
    const harness = sevenVerbComposition({
      async describeSubmission(submission) {
        return {
          orderId: null,
          challenge: { kind: '3d-secure', step: 'Enter the code your bank sent you.', url: submission.url },
        };
      },
    });

    const response = await harness.catalog.invoke(
      'payments.checkout.begin',
      { body: beginParams() } as never,
    ) as Record<string, unknown>;
    expect(String(response['outcome'])).toBe('challenge:3d-secure');

    // Before the fix, this exit disarmed unconditionally right after the
    // click, BEFORE even checking whether a challenge was pending.
    expect(harness.guard.hasLiveMaterial('session-1', 'page-1')).toBe(true);
    const scrubbed = harness.guard.redact('session-1', 'page-1', `Card ${SENTINEL.number} on file`);
    expect(scrubbed).not.toContain(SENTINEL.number);
  });

  test('a clean submission with no pending challenge still disarms once it is truly done', async () => {
    // The control case: the redesign is "don't disarm while it might still be
    // on the page", not "never disarm". A submission that actually completed,
    // with nothing left pending, disarms exactly as before.
    const harness = sevenVerbComposition();

    const response = await harness.catalog.invoke(
      'payments.checkout.begin',
      { body: beginParams() } as never,
    ) as Record<string, unknown>;
    expect(response['outcome']).toBe('submitted-unverified');
    expect(harness.guard.hasLiveMaterial('session-1', 'page-1')).toBe(false);
  });
});

// ── BLOCKING 2: verified is evidence-based ──────────────────────────────────
//
// `describeSubmission` being WIRED used to be enough on its own to mark a
// submission `verified: true`, regardless of what it actually returned. A
// composition that looked at the landing page and found nothing, a declined
// card, an error page, a spinner, still produced outcome `'purchased'` and a
// "Bought it." report. `verified` now requires the description to carry
// something the composition actually found: an order id, a challenge, or an
// explicit `confirmed: true`.
describe('BLOCKING 2: verified requires evidence, not merely a describeSubmission wired', () => {
  test('describeSubmission wired but finding nothing still yields submitted-unverified', async () => {
    const harness = sevenVerbComposition({
      async describeSubmission() {
        return { orderId: null, challenge: null };
      },
    });

    const response = await harness.catalog.invoke(
      'payments.checkout.begin',
      { body: beginParams() } as never,
    ) as Record<string, unknown>;

    // Before the fix: 'purchased', unconditionally, because describeSubmission
    // being called at all set verified: true.
    expect(response['outcome']).toBe('submitted-unverified');
    expect(harness.recorded[0]?.outcome).toBe('submitted-unverified');
  });

  test('an explicit confirmed:true with no order id still verifies', async () => {
    const harness = sevenVerbComposition({
      async describeSubmission() {
        return { orderId: null, challenge: null, confirmed: true };
      },
    });

    const response = await harness.catalog.invoke(
      'payments.checkout.begin',
      { body: beginParams() } as never,
    ) as Record<string, unknown>;
    expect(response['outcome']).toBe('purchased');
    expect(harness.recorded[0]?.outcome).toBe('purchased');
  });

  test('an order id alone is still sufficient evidence, unaffected by the fix', async () => {
    const harness = sevenVerbComposition({
      async describeSubmission(submission) {
        return { orderId: submission.navigated ? 'BBY-01-556677' : null, challenge: null };
      },
    });

    const response = await harness.catalog.invoke(
      'payments.checkout.begin',
      { body: beginParams() } as never,
    ) as Record<string, unknown>;
    expect(response['outcome']).toBe('purchased');
    expect(response['merchantOrderId']).toBe('BBY-01-556677');
  });
});
