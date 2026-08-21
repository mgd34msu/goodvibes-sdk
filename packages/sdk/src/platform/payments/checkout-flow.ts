/**
 * checkout-flow.ts, the purchase, start to finish, with nothing merchant-
 * specific in it.
 *
 * ══ The order, and why it is exactly this order ═══════════════════════════
 *
 *   0  GATES              enabled, card, address, owner-direct, leader
 *   0b TAINT              the purchase must be owner-initiated; the item and any
 *                        stated limit must be the owner's. The MERCHANT may be one
 *                        the owner found while browsing, see below.
 *   0c LINK               the checkout url must resolve to a registrable domain
 *   0d RECOURSE           who takes the card, and what silence will mean
 *   1  EXTRACT            page strings → integers WE parsed
 *   2  CART               what is in it is what the owner asked for, nothing added
 *   3  RECURRING          a subscription is refused outright
 *   4  DECIDE             budget, ceiling, overage pool, shipping ladder
 *   5  RESERVE            money is held before any window opens
 *   6  NOTICE + WINDOW    ONE message, sent once, with the final total
 *   7  APPLY SHIPPING     the tier the ladder chose
 *   8  FILL               the daemon types the card
 *   9  SUBMIT             journalled BEFORE the click
 *  10  RECORD             the audit ledger, and the budget is committed
 *
 * Extraction comes before the cart check because the check compares parsed
 * lines; the cart check comes before the decision because a cart containing
 * something the owner did not ask for should never reach a budget question; and the
 * reservation comes before the window because a window is minutes wide and two
 * purchases decided in the same minute would otherwise each fit what remains
 * and together exceed it.
 *
 * ══ The merchant the owner named, and the merchant class ═════════════════
 *
 * The taint gate stands as written: the merchant, the checkout url, the item
 * and any stated limit come from the owner or the purchase is refused. The owner
 * names the merchant, or there is no purchase. Buying "the cheapest X you can find
 * online" is therefore refused, and taint-gate.ts documents that as a designed
 * consequence rather than a gap.
 *
 * What the merchant CLASS does here is separate and strictly narrower: it can
 * make an in-budget purchase stricter. A merchant with no established recourse
 * turns a veto into an approval, so silence stops it instead of allowing it.
 * It never moves in the other direction.
 *
 * ══ ONE notification, and the merchant decides what silence means ═════════
 *
 * Design rule: "show it to me" and "alert me if it is not a major retailer" collapse
 * into a single step. There is one message, sent once, when the item is chosen and
 * the final total is known, before payment. Both modes carry the same content;
 * the merchant only changes the RULE:
 *
 *   recourse established, within budget  ⇒ VETO.     Silence PROCEEDS.
 *   anything else                        ⇒ APPROVAL. Silence DENIES.
 *
 * They compose in the strict direction only, `windowForPurchase` escalates and
 * never downgrades, so a recognised retailer buys no leniency on an over-budget
 * purchase. The two window state machines in windows.ts stay separate, because
 * their silence rules are opposite and must never be unified; this module calls
 * whichever applies and never a shared helper.
 *
 * ══ Nothing here knows a merchant ═════════════════════════════════════════
 *
 * No selector, no host, no page shape, no label vocabulary. The reading arrives
 * as structured values from whoever read the page, and every page operation
 * goes through six port methods whose arguments are opaque targets the caller
 * supplied. A merchant this has never seen works or nothing does.
 */
import { assertCartMatchesRequest, detectRecurringCharge, type RequestedLine } from './cart.js';
import { checkPaymentGates, type GateInput } from './gates.js';
import { decidePurchase, type BudgetDraw } from './decide.js';
import { evaluatePaymentTaint, type OwnerOriginIntent } from './taint-gate.js';
import { extractCheckout, type ExtractedCheckout, type RawCheckoutReading } from './checkout-extraction.js';
import {
  classifyMerchant,
  windowForPurchase,
  type MerchantJudgePort,
  type MerchantPolicy,
  type MerchantVerdict,
} from './merchant-recourse.js';
import type { MarketplaceListing } from './marketplace-listing.js';
import { renderCancellationReport, renderPurchaseNotice, renderPurchaseReport } from './message.js';
import { validateLinkTarget } from '../security/link-validation.js';
import { registrableDomain } from '../security/public-suffix.js';
import {
  advanceApproval,
  advanceVeto,
  windowDeadlineMs,
  type ApprovalState,
  type ChannelDelivery,
  type VetoState,
} from './windows.js';
import { admitApprovedItemOverdraw, BudgetLedger, type BudgetLimits } from './budget.js';
import { fillCard, type CardFieldTarget } from './fill-card.js';
import {
  checkAddress,
  fillAddresses,
  renderDestination,
  type AddressFieldTarget,
  type AddressStore,
} from './address.js';
import type { CardMaterialStore } from './card-material.js';
import type { CardMaterialRedactor } from './card-redaction.js';
import { CheckoutSubmitRefused, type CheckoutChallenge, type CheckoutPageDriver } from './checkout-page.js';
import type { PurchaseRecord } from './purchase-record.js';
import type { CheckoutRegistry } from './checkout-registry.js';
import type { UntrustedContentLedger } from '../security/untrusted-content.js';
import { dayKey } from './day.js';
import type {
  CommandAuthorityChannel,
  CurrencyCode,
  OwnerSuppliedText,
  RefusalCode,
  ShippingStepDown,
  ShippingTier,
} from './types.js';

/** What the owner asked for, in their own words, from an owner-direct turn. */
export interface PurchaseRequest {
  readonly purchaseId: string;
  readonly merchantDomain: string;
  readonly checkoutUrl: string;
  readonly item: OwnerSuppliedText;
  readonly requestedLines: readonly RequestedLine[];
  readonly cardId: string;
  /**
   * Whether the owner NAMED this storefront or we found it while browsing.
   *
   * `false` puts the merchant and the checkout url through the taint check, the owner
   * named them, so they have to be the owner's. `true` skips that check by design and
   * hands the domain to the judge instead, which is the safeguard for a request phrased
   * like: "alert me prior to purchasing if it is not a major retailer".
   */
  readonly merchantDiscovered?: boolean | undefined;
  readonly preferredTier: ShippingTier;
  /** A limit the owner stated in the request, if any. Taint-checked, never page text. */
  readonly requestedMax?: string | undefined;

  /**
   * Where the item was browsed, when the checkout is on a different host.
   *
   * A checkout that leaves the recourse-bearing domain breaks the
   * qualification, and the notification says so rather than staying silent.
   */
  readonly storefrontHost?: string | undefined;
  /** Page-derived, carried for the audit record. Never used to infer majorness. */
  readonly sellerIdentity?: string | undefined;
  readonly saleType?: 'first-party' | 'third-party' | 'unknown' | undefined;
  /**
   * The specific listing, on marketplaces where recourse is per-seller.
   *
   * eBay's ruled behavior: Buy It Now only, and a seller-side selling record.
   * An auction is refused structurally, there is no final total before it ends,
   * so the "show the total, then wait" flow cannot run at all.
   */
  readonly listing?: MarketplaceListing | undefined;
}

export type { PurchaseRecord } from './purchase-record.js';

export interface PurchaseLedger {
  record(entry: PurchaseRecord): Promise<void>;
}

/** Delivering a prompt and hearing back, over channels that carry authority. */
export interface PaymentNotifier {
  /** Send the rendered message. Reports per-channel whether it landed. */
  deliver(input: {
    readonly kind: 'approval' | 'veto';
    readonly message: string;
  }): Promise<readonly ChannelDelivery[]>;
  /**
   * Wait for an answer, or until the deadline.
   *
   * Resolves null on silence. The caller decides what silence MEANS, because
   * the two windows mean opposite things by it and a notifier that decided
   * would be one place where they could be accidentally unified.
   */
  awaitAnswer(input: {
    readonly kind: 'approval' | 'veto';
    readonly deadlineMs: number;
  }): Promise<{
    readonly answer: 'approve' | 'deny' | 'acknowledge' | 'object';
    readonly channel: CommandAuthorityChannel;
  } | null>;
}

export interface CheckoutFlowDeps {
  readonly registry: CheckoutRegistry;
  readonly cards: CardMaterialStore;
  /**
   * The stored shipping and billing addresses.
   *
   * The address on the order comes from here, never from the model's memory of
   * what the owner said and never from anything on the page.
   */
  readonly addresses: AddressStore;
  readonly redactor: CardMaterialRedactor;
  readonly driver: CheckoutPageDriver;
  readonly ledger: BudgetLedger;
  readonly purchases: PurchaseLedger;
  readonly notifier: PaymentNotifier;
  readonly untrusted: UntrustedContentLedger;
  readonly limits: BudgetLimits;
  readonly budgetCurrency: CurrencyCode;
  readonly timezone: string;
  readonly gates: GateInput;
  readonly approvalMinutes: number;
  readonly vetoMinutes: number;
  readonly now: () => number;
  /**
   * The owner's additions and removals to the recognised-retailer list, and the
   * per-listing bar for marketplaces that carry one.
   *
   * Curated data, read at decision time. The judgement about what counts as
   * recourse is exercised when the list is EDITED, never by a model looking at
   * a page, a storefront built to look trustworthy is the easiest thing in the
   * world to produce.
   */
  /** Judges the merchant's recourse from its validated domain alone. */
  readonly merchantJudge: MerchantJudgePort;
  /** Owner-authored overrides from daemon config. */
  readonly merchantPolicy?: MerchantPolicy | undefined;
}

/**
 * Where the card fields are, and where the delivery and submit controls are.
 *
 * Supplied by the caller for the page it is actually looking at. This module
 * has no opinion about any of them, which is what lets it work on a merchant
 * nobody has written anything about.
 */
export interface CheckoutControls {
  readonly cardFields: readonly CardFieldTarget[];
  /**
   * Where each address field goes on this checkout.
   *
   * Empty when the checkout asks for no address, a digital order, or a page
   * that already has one on file. Every KIND named here must be stored in full
   * or the purchase refuses.
   */
  readonly addressFields?: readonly AddressFieldTarget[] | undefined;
  /** Target for each delivery option, in the same order as the reading's list. */
  readonly shippingTargets: readonly string[];
  readonly placeOrderTarget: string;
  readonly expirySeparator?: string | undefined;
  readonly twoDigitYear?: boolean | undefined;
}

/**
 * Refusals this layer can produce that the decision layer has no code for.
 *
 * Kept here rather than added to `RefusalCode` because they are execution-layer
 * facts: a listing format we will not buy, and an approval window that closed
 * for a reason that had nothing to do with the budget. Folding them into the
 * budget codes would make `payments.purchases.list` report "over budget" for a
 * purchase that was well within it and simply happened at a merchant the owner had not
 * vouched for.
 */
export type ExecutionRefusalCode =
  | 'extraction-failed'
  /** An auction, a Best Offer, or a format we could not confirm as fixed-price. */
  | 'listing-not-purchasable'
  | 'merchant-not-recognised-denied'
  | 'merchant-not-recognised-expired'
  | 'merchant-not-recognised-undeliverable';

export type CheckoutOutcome =
  | { readonly kind: 'refused'; readonly code: RefusalCode | ExecutionRefusalCode; readonly reason: string }
  | { readonly kind: 'cancelled'; readonly reason: string; readonly report: string }
  | { readonly kind: 'challenge'; readonly challenge: CheckoutChallenge; readonly reason: string }
  | {
      readonly kind: 'purchased';
      readonly record: PurchaseRecord;
      readonly orderId: string | null;
    };

function refused(code: RefusalCode | ExecutionRefusalCode, reason: string): CheckoutOutcome {
  return { kind: 'refused', code, reason };
}

/**
 * Run a purchase.
 *
 * Every exit either charges nothing and says why, or charges once and records
 * it. There is no path that submits without a journal entry written first, and
 * no path that retries a submit.
 */
export async function runCheckout(
  request: PurchaseRequest,
  reading: RawCheckoutReading,
  controls: CheckoutControls,
  deps: CheckoutFlowDeps,
): Promise<CheckoutOutcome> {
  const { registry, driver, ledger, notifier, now } = deps;

  // ── 0. Terminal gates ───────────────────────────────────────────────────
  const gateRefusal = checkPaymentGates(deps.gates);
  if (gateRefusal !== null) return refused(gateRefusal.code, gateRefusal.reason);

  // ── 0b. Taint: what is named must trace back to the owner ───────────────
  //
  // The merchant, the checkout url, the item and any stated limit are checked
  // against everything untrusted this turn has read. The merchant's own quoted
  // NUMBERS are deliberately not checked, they are read from the merchant by
  // definition, and their defence is the budget. See taint-gate.ts.
  const intent: OwnerOriginIntent = {
    // `runCheckout` is only ever reached from an owner-direct turn, gate 0
    // above refuses anything else, so the origin is 'owner' by construction.
    // A content-initiated purchase cannot build this value at all:
    // ContentOriginIntent has no merchantDiscovered and is refused with no
    // approval path. See taint-gate.ts.
    origin: 'owner',
    merchantDiscovered: request.merchantDiscovered ?? false,
    merchant: request.merchantDomain,
    checkoutUrl: request.checkoutUrl,
    item: request.item,
    requestedMax: request.requestedMax,
  };
  const taint = evaluatePaymentTaint({ intent, ledger: deps.untrusted });
  if (!taint.allowed) {
    return refused('derived-from-untrusted-content', taint.reason ?? 'Refused: this purchase derives from page content.');
  }

  // ── 0c. The checkout url must resolve, and must be the domain claimed ───
  const link = validateLinkTarget(request.checkoutUrl, request.merchantDomain);
  if (!link.ok) return refused('link-validation-failed', link.message);
  // The identity the owner is shown is computed by us from the validated url,
  // never a name the page claimed for itself.
  const merchantDomain = link.registrableDomain;

  // ── 0d. Who takes the card, and what silence will therefore mean ────────
  //
  // Run on the VALIDATED host, before any money math, so a listing we will not
  // buy at all, an auction, a Best Offer, stops here rather than after a
  // budget question that could never have applied to it.
  // Judged on the validated registrable domain ALONE, by an injected judge,
  // never a curated list. Everything else a page says about a merchant is
  // written by that merchant, so a judgement over it is one the attacker
  // writes. See merchant-recourse.ts.
  const merchantVerdict: MerchantVerdict = await classifyMerchant(
    {
      checkoutHost: link.host,
      ...(request.storefrontHost === undefined ? {} : { storefrontHost: request.storefrontHost }),
      ...(request.saleType === undefined ? {} : { saleType: request.saleType }),
      ...(request.listing === undefined ? {} : { listing: request.listing }),
    },
    deps.merchantJudge,
    deps.merchantPolicy ?? {},
  );
  if (merchantVerdict.refused === true) {
    // Terminal, and deliberately not an approval: there is no final total to
    // show the owner, so the flow the owner authorised has nothing to run on.
    return refused('listing-not-purchasable', merchantVerdict.reason);
  }

  // ── 1. Page strings become integers we parsed ───────────────────────────
  const extraction = extractCheckout(reading, deps.budgetCurrency);
  if (!extraction.ok) return refused('extraction-failed', extraction.reason);
  const checkout: ExtractedCheckout = extraction.checkout;

  // ── 2. The cart holds what the owner asked for and nothing else ─────────
  const cartCheck = assertCartMatchesRequest(checkout.lines, request.requestedLines);
  if (!cartCheck.ok) return refused('cart-mismatch', cartCheck.reason ?? 'Refused: the cart does not match the request.');

  // ── 3. A recurring charge is refused outright ───────────────────────────
  const recurring = detectRecurringCharge(checkout.orderSummaryText);
  if (recurring.recurring) {
    return refused('recurring-charge', recurring.reason ?? 'Refused: this checkout sets up a recurring charge.');
  }

  // ── 4. The decision, on OUR integers ────────────────────────────────────
  const pools = ledger.snapshot(deps.limits, now(), deps.timezone);
  const decision = decidePurchase({
    quoted: {
      itemMinorUnits: checkout.itemMinorUnits,
      taxMinorUnits: checkout.taxMinorUnits,
      mandatoryFeesMinorUnits: checkout.feesMinorUnits,
      currency: checkout.currency,
      shippingOptions: checkout.shippingOptions,
    },
    limits: deps.limits,
    pools,
    budgetCurrency: deps.budgetCurrency,
    preferredTier: request.preferredTier,
  });
  if (decision.kind === 'refuse') return refused(decision.code, decision.reason);

  const draw: BudgetDraw = decision.draw;
  const shipping = decision.shipping;
  const stepDown: ShippingStepDown | null = shipping.stepDown;

  // ── 5. Hold the money before any window opens ───────────────────────────
  //
  // An over-budget purchase does not fit the item pool, that is what makes it
  // over budget, so reserving it against the ordinary limits returns null and
  // the purchase dies before the owner is ever asked. That would make the approval
  // window unreachable for the one case it exists for, so the reservation for a
  // needs-approval purchase is taken against a limit raised by exactly this
  // purchase's shortfall, and released in full if the owner says no or says nothing.
  //
  // Narrow on purpose: only the ITEM limit is raised, and only for a purchase
  // the decision layer has already classified as needing the owner's yes. The
  // overage and tolerance allowances are untouched, so `overage-pool-exhausted`
  // still refuses exactly as before rather than being quietly funded by an
  // approval the owner gave for the item price.
  const reservationLimits = decision.kind === 'needs-approval'
    ? admitApprovedItemOverdraw(deps.limits, draw.itemMinorUnits, pools.item.remaining)
    : deps.limits;
  const reservation = ledger.reserve({
    id: request.purchaseId,
    itemMinorUnits: draw.itemMinorUnits,
    overageMinorUnits: draw.overageMinorUnits,
    toleranceMinorUnits: draw.toleranceMinorUnits,
    limits: reservationLimits,
    nowMs: now(),
    timezone: deps.timezone,
  });
  if (reservation === null) {
    return refused(
      'item-budget-exceeded-denied',
      'Refused: another purchase in flight is already holding the budget this one would need.',
    );
  }

  const identity = driver.identity();
  await registry.open({
    purchaseId: request.purchaseId,
    sessionId: identity.sessionId,
    pageId: identity.pageId,
    merchantDomain,
    cardId: request.cardId,
    item: request.item,
    currency: checkout.currency,
    phase: 'deciding',
    startedAtMs: now(),
    updatedAtMs: now(),
    draw,
    reservationId: reservation.id,
    shippingTierRequested: request.preferredTier,
    shippingTierUsed: shipping.tier,
    stepDown,
    totalMinorUnits: draw.totalMinorUnits,
  });

  /**
   * Give the money back and close the record. Used by every non-buying exit.
   *
   * Deliberately does NOT disarm the redactor. Most callers of `release` run
   * before `fillCard` ever arms anything, so there would be nothing to disarm;
   * the callers that run AFTER it (a fill that failed partway, a pre-click
   * submit refusal) are exactly the ones where card digits may still be sitting
   * in the page's DOM with no click having dispatched them anywhere. Disarming
   * there would stop redacting a page that still holds the card. Material
   * lifetime is bound to the PAGE instead: the browser engine disarms on
   * navigate, on a navigating click, and on close (browser-engine.ts), so a
   * guard that is never told the digits are gone stays armed, which is the
   * safe default, until the page itself proves they are.
   */
  const release = async (): Promise<void> => {
    ledger.release(reservation.id);
    await registry.close(request.purchaseId);
  };

  // ── The address goes on the order, and it is the one the owner stored ───
  //
  // Checked BEFORE the window: a purchase that cannot be delivered must not
  // reach the point of asking the owner about it, and a half-filled address form
  // is worse than a refusal because it can succeed.
  const addressFields = controls.addressFields ?? [];
  const addressKinds = [...new Set(addressFields.map((entry) => entry.kind))];
  for (const kind of addressKinds) {
    const stored = await deps.addresses.read(kind);
    const check = checkAddress(stored, kind);
    if (!check.ok) {
      await release();
      return refused(kind === 'shipping' ? 'no-shipping-address' : 'no-card', check.reason ?? 'Refused: the stored address is incomplete.');
    }
  }
  const shippingAddress = addressKinds.includes('shipping')
    ? await deps.addresses.read('shipping')
    : null;

  const metadata = await deps.cards.metadata(request.cardId);
  const cardLast4 = metadata?.last4 ?? '????';
  const poolsAfter = ledger.snapshot(deps.limits, now(), deps.timezone);

  const facts = {
    merchantDomain,
    item: request.item,
    itemMinorUnits: checkout.itemMinorUnits,
    taxMinorUnits: checkout.taxMinorUnits,
    feesMinorUnits: checkout.feesMinorUnits,
    shippingMinorUnits: shipping.costMinorUnits,
    totalMinorUnits: draw.totalMinorUnits,
    currency: checkout.currency,
    cardLast4,
    shippingTier: shipping.tier,
    stepDown,
    poolsAfter,
    destination: renderDestination(shippingAddress),
  };

  // ── 6. ONE notification, and the window its mode implies ────────────────
  //
  // Sent once, here, because this is the first moment both halves of what the
  // owner asked to see are known: WHAT was chosen, and what it will actually
  // cost. Earlier would be a message without a total; a second message later
  // would restore the two-step flow this design deliberately collapsed into one.
  await registry.advance(request.purchaseId, 'awaiting-window', {}, now());

  const aboveBudget = decision.kind === 'needs-approval';
  const windowKind: 'approval' | 'veto' = windowForPurchase({
    aboveBudget,
    merchantIsMajor: merchantVerdict.isMajor,
  });
  let windowOutcome: string;
  let answeredBy: string | null = null;

  if (windowKind === 'approval') {
    // Silence DENIES. Undeliverable DENIES. Either because it is over budget,
    // or because nobody can tell the owner what recourse they would have here.
    const message = renderPurchaseNotice({
      facts,
      mode: 'approval',
      expiresInMinutes: deps.approvalMinutes,
      merchantReason: merchantVerdict.reason,
    });
    const deliveries = await notifier.deliver({ kind: 'approval', message });
    let state: ApprovalState = advanceApproval('pending-dispatch', { kind: 'dispatched', deliveries });
    if (state === 'awaiting-approval') {
      const answer = await notifier.awaitAnswer({
        kind: 'approval',
        deadlineMs: windowDeadlineMs(now(), deps.approvalMinutes),
      });
      if (answer === null) {
        state = advanceApproval(state, { kind: 'deadline' });
      } else {
        answeredBy = answer.channel;
        state = advanceApproval(
          state,
          answer.answer === 'approve'
            ? { kind: 'approve', channel: answer.channel }
            : { kind: 'deny', channel: answer.channel },
        );
      }
    }
    windowOutcome = state;
    if (state !== 'approved') {
      await release();
      // The code says WHY the window was an approval, because the ledger row is
      // the only place the owner can later reconstruct that. "Over budget" on a
      // purchase that was comfortably within it, and merely at a shop nobody
      // could vouch for, is a lie the audit trail would keep repeating.
      const code: RefusalCode | ExecutionRefusalCode = aboveBudget
        ? state === 'denied-undeliverable'
          ? 'item-budget-exceeded-undeliverable'
          : state === 'denied-timeout'
            ? 'item-budget-exceeded-expired'
            : 'item-budget-exceeded-denied'
        : state === 'denied-undeliverable'
          ? 'merchant-not-recognised-undeliverable'
          : state === 'denied-timeout'
            ? 'merchant-not-recognised-expired'
            : 'merchant-not-recognised-denied';
      const why = aboveBudget
        ? state === 'denied-undeliverable'
          ? 'Refused: this is over your daily item budget and I could not reach you to ask. '
            + 'Over-budget purchases do not go through unasked.'
          : state === 'denied-timeout'
            ? 'Refused: this was over your daily item budget and the approval window closed with no answer. '
              + 'Silence on an over-budget purchase means no.'
            : 'Refused: you said no.'
        : state === 'denied-undeliverable'
          ? 'Refused: I could not reach you to ask about this merchant, and a purchase somewhere '
            + 'I cannot point to a way of getting your money back does not go through unasked.'
          : state === 'denied-timeout'
            ? 'Refused: the window closed with no answer. Silence means no when the shop is not one '
              + 'you have vouched for.'
            : 'Refused: you said no.';
      return refused(code, aboveBudget ? why : `${why} ${merchantVerdict.reason}`);
    }
  } else {
    // WITHIN BUDGET AND RECOURSE ESTABLISHED. Silence PROCEEDS. Undeliverable
    // PROCEEDS.
    const message = renderPurchaseNotice({
      facts,
      mode: 'veto',
      expiresInMinutes: deps.vetoMinutes,
      merchantReason: merchantVerdict.reason,
    });
    const deliveries = await notifier.deliver({ kind: 'veto', message });
    let state: VetoState = advanceVeto('pending-dispatch', { kind: 'dispatched', deliveries });
    if (state === 'open') {
      const answer = await notifier.awaitAnswer({
        kind: 'veto',
        deadlineMs: windowDeadlineMs(now(), deps.vetoMinutes),
      });
      if (answer === null) {
        state = advanceVeto(state, { kind: 'deadline' });
      } else {
        answeredBy = answer.channel;
        state = advanceVeto(
          state,
          answer.answer === 'object'
            ? { kind: 'object', channel: answer.channel }
            : { kind: 'acknowledge', channel: answer.channel },
        );
      }
    }
    windowOutcome = state;
    if (state === 'cancelled') {
      await release();
      // An objection stops AND reports. A silently abandoned cart leaves the
      // owner wondering whether something is sitting half-driven somewhere.
      return {
        kind: 'cancelled',
        reason: 'You said stop, so nothing was charged.',
        report: renderCancellationReport(facts),
      };
    }
  }

  // ── 7. Apply the delivery option the ladder chose ───────────────────────
  const chosenIndex = checkout.shippingOptions.findIndex(
    (option) => option.rawLabel === shipping.option.rawLabel
      && option.costMinorUnits === shipping.option.costMinorUnits,
  );
  const shippingTarget = chosenIndex === -1 ? undefined : controls.shippingTargets[chosenIndex];
  if (shippingTarget !== undefined) {
    try {
      await driver.choose(shippingTarget, shipping.option.rawLabel);
    } catch {
      await release();
      return refused('total-changed', 'Refused: the delivery option I chose could not be selected on this checkout.');
    }
  }

  // ── 8. The daemon puts the address and then the card on the page ────────
  //
  // Address first: it is not secret, so it needs no guard, and doing it before
  // the card means a checkout that rejects the address fails before any card
  // material has been typed anywhere.
  if (addressFields.length > 0) {
    const addressFill = await fillAddresses(addressFields, {
      store: deps.addresses,
      fill: (target, value) => driver.fill(target, value),
    });
    if (!addressFill.ok) {
      await release();
      return refused(
        'no-shipping-address',
        `${addressFill.reason ?? 'The address could not be put on this checkout.'} Nothing was submitted.`,
      );
    }
  }

  await registry.advance(request.purchaseId, 'arming-payment', {}, now());
  const fill = await fillCard(
    {
      sessionId: identity.sessionId,
      pageId: identity.pageId,
      targets: controls.cardFields,
      expirySeparator: controls.expirySeparator,
      twoDigitYear: controls.twoDigitYear,
    },
    { registry, cards: deps.cards, redactor: deps.redactor, driver },
  );
  if (!fill.ok) {
    await release();
    return refused(
      'challenge-abandoned',
      `Refused: the payment form could not be completed (${fill.reason ?? 'the card fields did not accept input'}). `
      + 'Nothing was submitted.',
    );
  }

  // ── 9. Journal BEFORE the submit, then submit exactly once ──────────────
  // This flush is what lets a restart tell "not submitted" from "possibly
  // submitted". Everything before it is unambiguously not submitted; from here
  // until a response is seen, we cannot know, and a record in this phase is
  // reported to the owner rather than retried.
  await registry.advance(request.purchaseId, 'submit-pending', {}, now());

  let submission: {
    readonly url: string;
    readonly orderId: string | null;
    readonly challenge?: CheckoutChallenge | null | undefined;
    readonly verified: boolean;
  };
  try {
    submission = await driver.submitOrder(controls.placeOrderTarget);
  } catch (error) {
    if (error instanceof CheckoutSubmitRefused) {
      // Refused BEFORE the click reached the merchant (a typed refusal, the
      // untrusted-effect guard, a stale ref): nothing was sent, so `release`
      // gives the reservation back and closes the journal rather than
      // holding it against a submit that never happened.
      await release();
      return refused(
        'submit-not-attempted',
        `Refused: the order could not be submitted (${error.message}). Nothing was sent to the merchant.`,
      );
    }
    // Any other throw is genuine ambiguity: the click may have reached the
    // merchant. STAYS submit-pending, budget STAYS reserved, never retried.
    // Not disarmed: whether the click reached the merchant is exactly what is
    // unknown here, so whether the page still shows the card is unknown too.
    // The engine disarms on its own once the page actually navigates or closes
    // (browser-engine.ts); nothing here claims to know that already happened.
    return refused(
      'challenge-abandoned',
      'The order was submitted but I did not see a response, so I cannot tell whether it went through. '
      + 'Check your order history at this merchant. I will not try again.',
    );
  }

  if (submission.challenge !== undefined && submission.challenge !== null) {
    // 3-D Secure, a CAPTCHA, a one-time code. Pause cleanly and hand the owner the
    // exact step. The reservation is held, because the order may complete once the
    // owner answers, and the record stays in submit-pending for the same reason. NOT
    // disarmed: the owner is about to be sent back to this very page to complete it,
    // so the redactor must still be watching whatever it shows.
    return {
      kind: 'challenge',
      challenge: submission.challenge,
      reason:
        `The merchant asked for an extra verification step before completing this order. `
        + `Nothing further happens until you do it: ${submission.challenge.step}`,
    };
  }

  // No challenge: the submit ran its course. The card's usefulness to us on
  // this page ends here, whatever the merchant's response actually was.
  deps.redactor.disarm(identity.sessionId, identity.pageId);

  // ── 10. Record it ───────────────────────────────────────────────────────
  await registry.advance(request.purchaseId, 'submitted', {}, now());
  const atMs = now();
  ledger.commit(reservation.id, atMs);

  const record: PurchaseRecord = {
    purchaseId: request.purchaseId,
    atUtc: new Date(atMs).toISOString(),
    dayKey: dayKey(atMs, deps.timezone),
    timezone: deps.timezone,
    merchantDomain,
    item: request.item,
    currency: checkout.currency,
    itemMinorUnits: checkout.itemMinorUnits,
    taxMinorUnits: checkout.taxMinorUnits,
    feesMinorUnits: checkout.feesMinorUnits,
    shippingMinorUnits: shipping.costMinorUnits,
    totalMinorUnits: draw.totalMinorUnits,
    shippingTierRequested: request.preferredTier,
    shippingTierUsed: shipping.tier,
    steppedDown: stepDown !== null,
    itemPoolDraw: draw.itemMinorUnits,
    overagePoolDraw: draw.overageMinorUnits,
    tolerancePoolDraw: draw.toleranceMinorUnits,
    cardLast4,
    windowKind,
    windowOutcome,
    answeredBy,
    // Committed below either way (conservative against a double-spend), but
    // only a composition that read the merchant's own response earns
    // 'purchased'; otherwise the record says so rather than claiming a
    // purchase indistinguishable from a verified one.
    outcome: submission.verified ? 'purchased' : 'submitted-unverified',
    refusalReason: null,
    merchantOrderId: submission.orderId,
    refundedAt: null,
    merchantRecognised: merchantVerdict.isMajor,
    merchantQualifier: merchantVerdict.basis,
    merchantDiscovered: request.merchantDiscovered ?? false,
  };
  await deps.purchases.record(record);
  await registry.close(request.purchaseId);

  // ── 11. Tell the owner it happened ──────────────────────────────────────
  //
  // At charge time, not when the store gets round to emailing. The owner would
  // otherwise get a veto notice, ten minutes of silence, a charge, and nothing,
  // with the store's receipt later landing as mail the owner has to place themself.
  //
  // Sent through the same router as the notice. A delivery failure here is
  // reported and does NOT unwind the purchase: the card has been charged, and
  // an exception thrown after the money moved would leave the ledger and the
  // world disagreeing about whether it did.
  try {
    await notifier.deliver({
      kind: 'veto',
      message: renderPurchaseReport({ facts, merchantOrderId: submission.orderId, verified: submission.verified }),
    });
  } catch {
    // Nothing to unwind and nothing to retry. The purchase is recorded, and
    // `payments.purchases.list` is the durable answer to "what did you buy".
  }

  return { kind: 'purchased', record, orderId: submission.orderId };
}

/** The merchant identity for a url, computed by us. Null when it has none. */
export function merchantIdentity(url: string): string | null {
  try {
    return registrableDomain(new URL(url).hostname);
  } catch {
    return null;
  }
}
