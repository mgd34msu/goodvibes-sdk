/**
 * payments-gateway-service.ts — the daemon side, so the capability is reachable.
 *
 * ══ What was missing ══════════════════════════════════════════════════════
 *
 * `runCheckout` was complete and had no caller. `routes/payments.ts` declared a
 * `PaymentsGatewayService` interface and nothing implemented it. So every piece
 * worked and the daemon had no way to begin a purchase — the chain broke at the
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
 * constructed per call — which is also what makes "refuse a fill with no
 * decision in flight" enforceable across two independent invocations.
 */
import { BudgetLedger, type BudgetLimits } from './budget.js';
import { CheckoutRegistry, type CheckoutJournal } from './checkout-registry.js';
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
  /** The gate inputs the daemon alone can answer — leadership most of all. */
  readonly gates: () => GateInput;
  readonly config: () => PaymentsServiceConfig;
  readonly now?: (() => number) | undefined;
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
   * string is. Translating here — explicitly, rather than by casting — is what
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
    this.redactor = new CardMaterialRedactor();
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
   * Everything the flow needs that only the daemon knows — the limits, the
   * timezone, the leadership answer — is read HERE, at the moment of the call,
   * rather than captured at construction. A budget raised five minutes ago
   * should apply to this purchase.
   */
  async beginCheckout(input: BeginCheckoutInput): Promise<PaymentBeginResult> {
    const config = this.deps.config();
    const now = this.deps.now ?? Date.now;

    // The item is the OWNER's words. `ownerSuppliedText` refuses anything not
    // from an owner-direct turn, and a null here is a refusal rather than a
    // cast: the branded type is what stops page text reaching his phone.
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
   * Type the stored card into an open checkout.
   *
   * The refusals live in `fillCard`; this only adapts the shapes. A
   * `FillCardRefusal` is rethrown so the route can forward its message — it
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
      outcome: 'purchased',
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
