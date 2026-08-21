/**
 * payments-gateway-service.ts, the daemon side, so the capability is reachable.
 *
 * ══ What was missing ══════════════════════════════════════════════════════
 *
 * `runCheckout` was complete and had no caller. `routes/payments.ts` declared a
 * `PaymentsGatewayService` interface and nothing implemented it. So every piece
 * worked and the daemon had no way to begin a purchase, the chain broke at the
 * point where a request turns into a checkout.
 *
 * This is that link: one service, constructed from the daemon's own managers,
 * behind the `payments.checkout.*` verbs.
 *
 * ══ Everything it needs is injected ═══════════════════════════════════════
 *
 * No manager is reached for from inside. The card store, the address store, the
 * budget ledger, the notifier, the browser driver factory and the clock all
 * arrive through the constructor, for the reason the rest of this capability
 * does the same: the containment assertions have to be able to drive a whole
 * purchase with a sentinel card and then search every output for it, and a
 * service that resolved its own dependencies could only be tested against a
 * real daemon or not at all.
 *
 * ══ The service holds the registry, not the caller ════════════════════════
 *
 * `begin` opens a checkout and `fillCard` completes one, and they are separate
 * verbs arriving as separate control-plane calls. The in-flight registry has to
 * outlive both, so it lives here for the life of the service rather than being
 * constructed per call, which is also what makes "refuse a fill with no
 * decision in flight" enforceable across two independent invocations.
 */
import { BudgetLedger, type BudgetLimits } from './budget.js';
import { CheckoutRegistry, describeInterruption, type CheckoutJournal, type InFlightCheckout, type InterruptedVerdict } from './checkout-registry.js';
import { recoverInterruptedWindow, type WindowRecovery } from './windows.js';
import { CardMaterialRedactor } from './card-redaction.js';
import { fillCard, FillCardRefusal, type CardFieldTarget } from './fill-card.js';
import { runCheckout, type CheckoutControls, type CheckoutOutcome, type PurchaseLedger, type PurchaseRequest } from './checkout-flow.js';
import { extractCheckout, type RawCheckoutReading } from './checkout-extraction.js';
import { isCardFieldName } from './card-material.js';
import { ownerSuppliedText } from './types.js';
import type { AddressFieldName, AddressFieldTarget, AddressStore } from './address.js';

/** The address fields this daemon stores, for validating a wire request. */
const ADDRESS_FIELDS: readonly AddressFieldName[] = [
  'name', 'line1', 'line2', 'city', 'region', 'postalCode', 'country',
];
import type { CardMaterialStore } from './card-material.js';
import type { CheckoutPageDriver } from './checkout-page.js';
import type { GateInput } from './gates.js';
import type { MerchantJudgePort } from './merchant-recourse.js';
import type { PaymentNotifier } from './checkout-flow.js';
import type { UntrustedContentLedger } from '../security/untrusted-content.js';
import type { CurrencyCode, ShippingTier } from './types.js';

/**
 * Ceiling on each composition-supplied I/O call the recovery sweep makes
 * (notifier delivery, the purchases lookup, the arming-page cleanup hook).
 * Ten seconds is deliberate: long enough for a channel router doing a real
 * network send, short enough that even a journal full of records cannot make
 * verb attachment hang on one wedged dependency. A call that exceeds it is
 * reported through the audit path and the sweep continues.
 */
export const RECOVERY_IO_TIMEOUT_MS = 10_000;

function withRecoveryTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`${label} did not settle within ${ms}ms during checkout recovery.`));
    }, ms);
    work.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error: unknown) => { clearTimeout(timer); rejectPromise(error); },
    );
  });
}

/** What one boot's recovery sweep did, for the composition's audit log. */
export interface CheckoutRecoverySweep {
  /** False when the sweep did not run at all (see `skipped`). */
  readonly swept: boolean;
  /** Why a non-swept boot skipped: this daemon is not the payments leader. */
  readonly skipped?: 'not-leader' | undefined;
  readonly settlements: readonly InterruptedCheckoutRecovery[];
}

/** One interrupted checkout settled (or deliberately held) by boot recovery. */
export interface InterruptedCheckoutRecovery {
  readonly purchaseId: string;
  readonly merchantDomain: string;
  readonly verdict: InterruptedVerdict;
  /**
   * `released`: nothing was submitted, the budget hold is released and the
   * record closed. `held`: the record is kept, either because the submit
   * outcome is unknowable or because a `submitted` entry's purchase record
   * could not be verified on the ledger. `closed`: the order was submitted,
   * its purchase record was verified, and only the journal entry needed
   * closing. `failed`: settling this one record threw; the message carries
   * the error and the rest of the sweep continued.
   */
  readonly action: 'released' | 'held' | 'closed' | 'failed';
  readonly reservationReleased: boolean;
  readonly notified: boolean;
  /**
   * What happened with the owner's notice for this record: `delivered` on a
   * confirmed landing, `failed` when delivery errored, timed out, or landed
   * nowhere, and `already-notified` when an earlier boot's stamped notice
   * made a repeat unnecessary.
   */
  readonly notice: 'delivered' | 'failed' | 'already-notified';
  readonly message: string;
  /**
   * Present when the record carried a persisted delivery report and the
   * delivery-keyed window rules were applied; the audit record for which
   * rule governed and which channels it named.
   */
  readonly windowRecovery?: WindowRecovery | undefined;
  /** Present only for records interrupted while arming the payment. */
  readonly armingPageCleanup?: 'done' | 'failed' | 'unavailable' | undefined;
}

/** What a `payments.checkout.fillCard` call reports. Field names and a boolean. */
export interface PaymentFillCardResult {
  readonly ok: boolean;
  readonly filled: readonly string[];
  readonly failedField: string | null;
  readonly reason: string | null;
}

/** What a `payments.checkout.begin` call reports. */
export interface PaymentBeginResult {
  readonly outcome: string;
  readonly purchaseId: string | null;
  readonly reason: string | null;
  readonly merchantOrderId: string | null;
  readonly totalMinorUnits: number | null;
  readonly currency: string | null;
  readonly shippingTierUsed: string | null;
  readonly steppedDown: boolean;
  /** Set when the merchant interrupted with 3-D Secure, a CAPTCHA or an OTP. */
  readonly challengeStep: string | null;
}

export interface PaymentsServiceConfig {
  readonly limits: BudgetLimits;
  readonly budgetCurrency: CurrencyCode;
  readonly timezone: string;
  readonly preferredTier: ShippingTier;
  readonly approvalMinutes: number;
  readonly vetoMinutes: number;
}

export interface PaymentsServiceDeps {
  readonly cards: CardMaterialStore;
  readonly addresses: AddressStore;
  readonly ledger: BudgetLedger;
  readonly purchases: PurchaseLedger;
  readonly notifier: PaymentNotifier;
  readonly untrusted: UntrustedContentLedger;
  readonly journal: CheckoutJournal;
  /** Judges merchant recourse from the validated domain alone. */
  readonly merchantJudge: MerchantJudgePort;
  /** Resolves the driver for an open browser session and page. */
  readonly driverFor: (sessionId: string, pageId: string) => CheckoutPageDriver;
  /**
   * Composition-supplied cleanup for a page that outlived the process while a
   * checkout was arming the payment. Receives record identity only, never a
   * driver: the composition holds the browser authority and decides whether
   * it can still reach the page (same discipline as the checkout seam, so
   * payments code cannot mint browser access recovery was not given).
   * Resolves true when the card fields were cleared. Absent, recovery keeps
   * the documented posture of refusing to claim a cleanup it cannot perform.
   */
  readonly armingPageCleanup?: ((record: {
    readonly purchaseId: string;
    readonly sessionId: string;
    readonly pageId: string;
  }) => Promise<boolean>) | undefined;
  /** The gate inputs the daemon alone can answer, leadership most of all. */
  readonly gates: () => GateInput;
  readonly config: () => PaymentsServiceConfig;
  readonly now?: (() => number) | undefined;
  /**
   * Override for `RECOVERY_IO_TIMEOUT_MS`, the per-call ceiling on the
   * sweep's composition I/O. Tests use it; compositions normally do not.
   */
  readonly recoveryIoTimeoutMs?: number | undefined;
  /**
   * The redactor this service arms, supplied rather than minted.
   *
   * Absent, one is constructed here and the service is self-contained, which is
   * what every existing caller and every containment test does. Present, it is
   * the guard the browser engine was built with, and passing the SAME object is
   * the whole point: the engine scrubs page output against what this service
   * armed, and two instances would leave the engine scrubbing an empty set
   * while a card sat on the page. The browser-backed driver refuses rather than
   * types if the two ever come apart (see browser-checkout-driver.ts).
   */
  readonly cardFieldGuard?: CardMaterialRedactor | undefined;
}

/** The input a `begin` call carries, already shape-checked by the route. */
export interface BeginCheckoutInput {
  readonly sessionId: string;
  readonly pageId: string;
  readonly merchantDomain: string;
  readonly checkoutUrl: string;
  readonly item: string;
  readonly cardId: string;
  readonly requestedLines: readonly { readonly label: string; readonly quantity: number }[];
  readonly reading: RawCheckoutReading;
  /**
   * The page controls, in the WIRE shape (`ref`), translated below.
   *
   * The wire says `ref` because that is what a snapshot calls an element; the
   * flow says `target` because it has no opinion about what an addressing
   * string is. Translating here, explicitly, rather than by casting, is what
   * keeps a mismatch a compile error instead of a runtime refusal that reads
   * like a missing address.
   */
  readonly controls: {
    readonly cardFields: readonly { readonly field: string; readonly ref: string }[];
    readonly addressFields?: readonly { readonly kind: string; readonly field: string; readonly ref: string }[] | undefined;
    readonly shippingTargets?: readonly string[] | undefined;
    readonly placeOrderTarget: string;
    readonly expirySeparator?: string | undefined;
    readonly twoDigitYear?: boolean | undefined;
  };
  readonly preferredTier?: ShippingTier | undefined;
  readonly requestedMax?: string | undefined;
  /** True when the storefront was found while browsing rather than named. */
  readonly merchantDiscovered?: boolean | undefined;
}

export class PaymentsGatewayServiceImpl {
  private readonly registry: CheckoutRegistry;
  private readonly redactor: CardMaterialRedactor;

  constructor(private readonly deps: PaymentsServiceDeps) {
    this.registry = new CheckoutRegistry(deps.journal);
    this.redactor = deps.cardFieldGuard ?? new CardMaterialRedactor();
  }

  /**
   * The redactor this service types cards through.
   *
   * Exposed so the daemon can hand the SAME instance to the browser engine as
   * its `cardFieldGuard`. They must be one object: the engine scrubs against
   * what this service armed, and two instances would mean the engine scrubbing
   * against an empty set while a card sat on the page.
   */
  cardFieldGuard(): CardMaterialRedactor {
    return this.redactor;
  }

  /**
   * Begin and run a checkout.
   *
   * Everything the flow needs that only the daemon knows, the limits, the
   * timezone, the leadership answer, is read HERE, at the moment of the call,
   * rather than captured at construction. A budget raised five minutes ago
   * should apply to this purchase.
   */
  async beginCheckout(input: BeginCheckoutInput): Promise<PaymentBeginResult> {
    const config = this.deps.config();
    const now = this.deps.now ?? Date.now;

    // The item is the OWNER's words. `ownerSuppliedText` refuses anything not
    // from an owner-direct turn, and a null here is a refusal rather than a
    // cast: the branded type is what stops page text reaching their phone.
    const item = ownerSuppliedText(input.item, 'owner-direct');
    if (item === null) {
      return this.refused('The item has to be described in your own words, from your own request.');
    }

    const driver = this.deps.driverFor(input.sessionId, input.pageId);
    const request: PurchaseRequest = {
      purchaseId: `pur-${String(now())}-${Math.random().toString(36).slice(2, 10)}`,
      merchantDomain: input.merchantDomain,
      checkoutUrl: input.checkoutUrl,
      item,
      requestedLines: input.requestedLines,
      cardId: input.cardId,
      preferredTier: input.preferredTier ?? config.preferredTier,
      requestedMax: input.requestedMax,
      merchantDiscovered: input.merchantDiscovered ?? false,
    };

    const cardFields: CardFieldTarget[] = [];
    for (const entry of input.controls.cardFields) {
      if (!isCardFieldName(entry.field)) {
        return this.refused(`"${entry.field}" is not a card field I can fill.`);
      }
      cardFields.push({ field: entry.field, target: entry.ref });
    }

    const addressFields: AddressFieldTarget[] = [];
    for (const entry of input.controls.addressFields ?? []) {
      if (entry.kind !== 'shipping' && entry.kind !== 'billing') {
        return this.refused(`"${entry.kind}" is not an address I hold. Use shipping or billing.`);
      }
      if (!ADDRESS_FIELDS.includes(entry.field as AddressFieldName)) {
        return this.refused(`"${entry.field}" is not part of an address I store.`);
      }
      addressFields.push({ kind: entry.kind, field: entry.field as AddressFieldName, target: entry.ref });
    }

    const controls: CheckoutControls = {
      cardFields,
      addressFields,
      shippingTargets: input.controls.shippingTargets ?? [],
      placeOrderTarget: input.controls.placeOrderTarget,
      expirySeparator: input.controls.expirySeparator,
      twoDigitYear: input.controls.twoDigitYear,
    };

    const outcome = await runCheckout(request, input.reading, controls, {
      registry: this.registry,
      cards: this.deps.cards,
      addresses: this.deps.addresses,
      redactor: this.redactor,
      driver,
      ledger: this.deps.ledger,
      purchases: this.deps.purchases,
      notifier: this.deps.notifier,
      untrusted: this.deps.untrusted,
      merchantJudge: this.deps.merchantJudge,
      limits: config.limits,
      budgetCurrency: config.budgetCurrency,
      timezone: config.timezone,
      gates: this.deps.gates(),
      approvalMinutes: config.approvalMinutes,
      vetoMinutes: config.vetoMinutes,
      now,
    });

    return this.describe(outcome, request.purchaseId);
  }

  /**
   * Settle every checkout a restart interrupted, before new checkouts run.
   *
   * The journal is the restart's only witness, and records live in this
   * process are running, not interrupted; the registry filters them out.
   * Each record settles by its phase verdict. Nothing submitted releases its
   * budget hold and closes, and the owner's message follows the actual
   * release result. An unknowable submit keeps its hold and its record. A
   * `submitted` record is closed only after the purchase record is verified
   * on the ledger; when it is missing, or this composition cannot look, the
   * record is kept and the owner is told exactly what is and is not known.
   * A record interrupted inside a window settles conservatively by refusal,
   * because delivery of the window's notice cannot be verified after a
   * restart; the delivery-keyed rules in `recoverInterruptedWindow` apply
   * once deliveries are persisted.
   *
   * A kept record notifies the owner at most once, ever: the first delivered
   * notice stamps `recoveryNotifiedAtMs` back through the journal. One
   * record's failure never abandons the rest; it is reported in the results
   * as `action: 'failed'`. Recovery also cannot clear card material from a
   * browser page that outlived the process (attach-based compositions): the
   * composition that owns the page owns that cleanup, including for records
   * interrupted in the arming phase.
   */
  async recoverInterruptedCheckouts(): Promise<CheckoutRecoverySweep> {
    // Leadership gates the sweep exactly as it gates every verb: a non-leader
    // daemon must not settle records, release holds, or message the owner
    // about checkouts another instance owns. The skip is reported, not
    // silent, so the audit log shows which boot deferred and why.
    if (!this.deps.gates().isPaymentsLeader) {
      return { swept: false, skipped: 'not-leader', settlements: [] };
    }
    const interrupted = await this.registry.interrupted();
    const results: InterruptedCheckoutRecovery[] = [];
    for (const { record, verdict } of interrupted) {
      try {
        results.push(await this.settleInterrupted(record, verdict));
      } catch (error) {
        results.push({
          purchaseId: record.purchaseId,
          merchantDomain: record.merchantDomain,
          verdict,
          action: 'failed',
          reservationReleased: false,
          notified: false,
          notice: 'failed',
          message: error instanceof Error ? error.message : 'Recovery failed for this record.',
        });
      }
    }
    return { swept: true, settlements: results };
  }

  private async settleInterrupted(
    record: InFlightCheckout,
    verdict: InterruptedVerdict,
  ): Promise<InterruptedCheckoutRecovery> {
    const now = this.deps.now ?? Date.now;
    const ioTimeoutMs = this.deps.recoveryIoTimeoutMs ?? RECOVERY_IO_TIMEOUT_MS;
    let action: InterruptedCheckoutRecovery['action'];
    let reservationReleased = false;
    let message: string;
    let windowRecovery: WindowRecovery | undefined;
    let armingPageCleanup: InterruptedCheckoutRecovery['armingPageCleanup'];

    if (verdict === 'not-submitted') {
      if (record.reservationId !== null) {
        // In-memory reservations do not survive the restart; releasing is the
        // honest no-op then, and the real release when recovery runs in-process.
        reservationReleased = this.deps.ledger.release(record.reservationId);
      }
      message = describeInterruption(record, verdict, { reservationReleased });
      if (record.phase === 'awaiting-window') {
        message += ` ${this.settleWindowSentence(record, now, (recovery) => { windowRecovery = recovery; })}`;
      }
      if (record.phase === 'arming-payment') {
        armingPageCleanup = await this.runArmingPageCleanup(record, ioTimeoutMs);
        message += armingPageCleanup === 'done'
          ? ' The card fields this checkout had started filling were cleared from the page.'
          : ' This checkout was typing card details when it stopped; I cannot reach that page from'
            + ' here, so if the browser window is still open, close it or clear the form yourself.';
      }
      await this.registry.close(record.purchaseId);
      action = 'released';
    } else if (verdict === 'possibly-submitted') {
      // The crash-between-record-and-flush case: the purchase record may
      // already be on the ledger even though the journal never saw the
      // submitted flush. When the lookup proves it, the order completed;
      // close honestly instead of holding forever. Anything less certain
      // stays deliberately untouched, because releasing the hold or the
      // record is what makes a restart buy the thing twice.
      const verified = await this.verifyPurchaseRecord(record.purchaseId, ioTimeoutMs);
      message = describeInterruption(record, verdict, { recordVerified: verified });
      if (verified === true) {
        await this.registry.close(record.purchaseId);
        action = 'closed';
      } else {
        action = 'held';
      }
    } else {
      // `submitted` is only closed once the purchase record is verified on
      // the ledger. Journals written under the old flush ordering can carry
      // `submitted` entries whose crash landed before the record was written.
      const verified = await this.verifyPurchaseRecord(record.purchaseId, ioTimeoutMs);
      message = describeInterruption(record, verdict, { recordVerified: verified });
      if (verified === true) {
        await this.registry.close(record.purchaseId);
        action = 'closed';
      } else {
        action = 'held';
      }
    }

    let notified = false;
    let notice: InterruptedCheckoutRecovery['notice'];
    if (record.recoveryNotifiedAtMs !== undefined) {
      notice = 'already-notified';
    } else {
      try {
        const deliveries = await withRecoveryTimeout(
          this.deps.notifier.deliver({ kind: 'notice', message }),
          ioTimeoutMs,
          'The recovery notice delivery',
        );
        notified = deliveries.some((delivery) => delivery.delivered);
      } catch {
        notified = false;
      }
      notice = notified ? 'delivered' : 'failed';
      if (notified && action === 'held') {
        // Stamp kept records so the next boot does not repeat the notice.
        await this.deps.journal.put({ ...record, recoveryNotifiedAtMs: now() });
      }
    }
    return {
      purchaseId: record.purchaseId,
      merchantDomain: record.merchantDomain,
      verdict,
      action,
      reservationReleased,
      notified,
      notice,
      message,
      ...(windowRecovery !== undefined ? { windowRecovery } : {}),
      ...(armingPageCleanup !== undefined ? { armingPageCleanup } : {}),
    };
  }

  /**
   * The window sentence for an interrupted-window record, keyed on the
   * PERSISTED delivery report when one exists. The purchase itself can never
   * resume after a restart (the page and the in-flight call are gone), so
   * every branch settles with the hold released and nothing charged; what the
   * delivery-keyed rules decide is what the owner is told about the notice
   * and which channels still owe a read.
   */
  private async verifyPurchaseRecord(
    purchaseId: string,
    ioTimeoutMs: number,
  ): Promise<boolean | undefined> {
    if (this.deps.purchases.has === undefined) return undefined;
    return withRecoveryTimeout(
      this.deps.purchases.has(purchaseId),
      ioTimeoutMs,
      'The purchases lookup',
    );
  }

  private settleWindowSentence(
    record: InFlightCheckout,
    now: () => number,
    report: (recovery: WindowRecovery) => void,
  ): string {
    const deliveries = record.windowDeliveries ?? [];
    if (deliveries.length === 0) {
      // Genuinely no delivery report: honest and narrow, settle by refusal.
      return 'It stopped inside its approval or veto window, and I could not verify that the'
        + ' window notice ever reached you, so it settles as refused rather than charged.';
    }
    const recovery = recoverInterruptedWindow({
      deliveries,
      deadlinePassed: record.windowDeadlineMs === undefined ? true : now() > record.windowDeadlineMs,
    });
    report(recovery);
    const windowName = record.windowKind === 'approval'
      ? 'approval window'
      : record.windowKind === 'veto' ? 'veto window' : 'approval or veto window';
    if (recovery.outcome === 'undeliverable-rule') {
      return `Its ${windowName} notice never reached you on any channel, so it settles as refused rather than charged.`;
    }
    if (recovery.outcome === 'reopen') {
      const channels = recovery.reopenChannels.join(', ');
      return `Its ${windowName} notice reached you, but I cannot re-read ${channels} for the span I was down, `
        + 'so a reply there may have been missed. The purchase could not resume after the restart, nothing '
        + 'was charged, and it will not be retried; start it again if you still want it.';
    }
    const backfill = recovery.backfillChannels.length > 0
      ? ` Any reply you sent on ${recovery.backfillChannels.join(', ')} while I was down can still be read there.`
      : '';
    return `Its ${windowName} notice reached you before the restart. The purchase could not resume `
      + `afterwards, so nothing was charged and it will not be retried; start it again if you still want it.${backfill}`;
  }

  private async runArmingPageCleanup(
    record: InFlightCheckout,
    ioTimeoutMs: number,
  ): Promise<'done' | 'failed' | 'unavailable'> {
    const cleanup = this.deps.armingPageCleanup;
    if (cleanup === undefined) return 'unavailable';
    try {
      const cleared = await withRecoveryTimeout(
        cleanup({
          purchaseId: record.purchaseId,
          sessionId: record.sessionId,
          pageId: record.pageId,
        }),
        ioTimeoutMs,
        'The arming-page cleanup hook',
      );
      return cleared ? 'done' : 'failed';
    } catch {
      return 'failed';
    }
  }

  /**
   * Type the stored card into an open checkout.
   *
   * The refusals live in `fillCard`; this only adapts the shapes. A
   * `FillCardRefusal` is rethrown so the route can forward its message, it
   * carries no card material and it is the owner's business why the fill was
   * refused.
   */
  async fillCardIntoCheckout(input: {
    readonly sessionId: string;
    readonly pageId: string;
    readonly targets: readonly { readonly field: string; readonly ref: string }[];
    readonly expirySeparator: string | undefined;
    readonly twoDigitYear: boolean | undefined;
  }): Promise<PaymentFillCardResult> {
    const targets: CardFieldTarget[] = [];
    for (const entry of input.targets) {
      if (!isCardFieldName(entry.field)) {
        throw new FillCardRefusal(
          `"${entry.field}" is not a card field I can fill.`,
          'Name one of: number, expiry, expiryMonth, expiryYear, cvv, cardholderName.',
        );
      }
      targets.push({ field: entry.field, target: entry.ref });
    }

    const result = await fillCard(
      {
        sessionId: input.sessionId,
        pageId: input.pageId,
        targets,
        expirySeparator: input.expirySeparator,
        twoDigitYear: input.twoDigitYear,
      },
      {
        registry: this.registry,
        cards: this.deps.cards,
        redactor: this.redactor,
        driver: this.deps.driverFor(input.sessionId, input.pageId),
      },
    );
    return {
      ok: result.ok,
      filled: [...result.filled],
      failedField: result.failedField,
      reason: result.reason,
    };
  }

  /** Validate a reading without buying anything, so a caller can check its parse. */
  previewReading(reading: RawCheckoutReading): { ok: boolean; reason: string | null } {
    const config = this.deps.config();
    const extraction = extractCheckout(reading, config.budgetCurrency);
    return extraction.ok ? { ok: true, reason: null } : { ok: false, reason: extraction.reason };
  }

  private refused(reason: string): PaymentBeginResult {
    return {
      outcome: 'refused',
      purchaseId: null,
      reason,
      merchantOrderId: null,
      totalMinorUnits: null,
      currency: null,
      shippingTierUsed: null,
      steppedDown: false,
      challengeStep: null,
    };
  }

  private describe(outcome: CheckoutOutcome, purchaseId: string): PaymentBeginResult {
    if (outcome.kind === 'refused') {
      return { ...this.refused(outcome.reason), outcome: `refused:${outcome.code}` };
    }
    if (outcome.kind === 'cancelled') {
      return { ...this.refused(outcome.reason), outcome: 'cancelled' };
    }
    if (outcome.kind === 'challenge') {
      return {
        outcome: `challenge:${outcome.challenge.kind}`,
        purchaseId,
        reason: outcome.reason,
        merchantOrderId: null,
        totalMinorUnits: null,
        currency: null,
        shippingTierUsed: null,
        steppedDown: false,
        challengeStep: outcome.challenge.step,
      };
    }
    return {
      // The record's own outcome carries the verified/unverified truth
      // (checkout-flow.ts); forwarded rather than hardcoded so a caller with
      // no describeSubmission wired sees "submitted-unverified" instead of a
      // claim indistinguishable from a confirmed purchase.
      outcome: outcome.record.outcome,
      purchaseId: outcome.record.purchaseId,
      reason: null,
      merchantOrderId: outcome.record.merchantOrderId,
      totalMinorUnits: outcome.record.totalMinorUnits,
      currency: outcome.record.currency,
      shippingTierUsed: outcome.record.shippingTierUsed,
      steppedDown: outcome.record.steppedDown,
      challengeStep: null,
    };
  }
}
