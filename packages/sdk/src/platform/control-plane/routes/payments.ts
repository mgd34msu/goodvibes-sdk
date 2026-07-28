/**
 * routes/payments.ts — the daemon actually serving `payments.*`.
 *
 * The daemon is the process that holds the card and charges it, with every
 * surface closed and across restarts, so these handlers are the only way a
 * surface sees or changes any of it. This module is deliberately thin: it maps
 * the descriptors' declared shapes onto a narrow service slice, performs no
 * I/O, holds no credential, and never touches a card number.
 *
 * Two properties are enforced HERE rather than merely advertised, so neither
 * rests on schema validation being reached by every transport:
 *
 *  - **Card material is write-only.** `cards.create` takes the number, expiry,
 *    CVV and cardholder name and returns the METADATA record. Nothing in this
 *    module can return a stored secret, and `sanitizeCardMetadata` strips any
 *    field a future service might mistakenly hand back — a service bug becomes
 *    a missing field rather than a leaked card.
 *  - **Card material never reaches an error.** Failures report the stage and a
 *    plain reason; what was submitted is never part of a diagnostic, because
 *    an error string is a read path like any other.
 *
 * ── `payments.checkout.fillCard` and why the header above still holds ─────
 *
 * The capability has to be able to type the card into a checkout or it cannot
 * buy anything, and the original write-only wording forbade exactly that. The
 * correction keeps every property this module actually enforces:
 *
 *   - This module still performs no I/O, holds no credential, and never touches
 *     a card number. `fillCard`'s handler reads a session, a page, a card id and
 *     a list of field targets, hands them to the service, and returns the
 *     service's field names and boolean.
 *   - Nothing is echoed. The output has no property that could hold a value,
 *     and `sanitizeFillResult` rebuilds the response from an allowlist for the
 *     same reason `sanitizeCardMetadata` does — a service bug becomes a missing
 *     field rather than a leaked card.
 *   - A failure names the FIELD, never the value. The service's own error is
 *     discarded rather than forwarded.
 *
 * What changed is only who does the typing: the DAEMON reads the material in
 * its own process and puts it in the field. The model orchestrates the purchase
 * and never holds the instrument, which was the property worth having.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import type { CardMetadata } from '../../payments/types.js';
import type { PoolSnapshot } from '../../payments/budget.js';

/** What a purchase looks like once the audit ledger has recorded it. */
export interface PaymentPurchaseView {
  readonly purchaseId: string;
  readonly atUtc: string;
  readonly dayKey: string;
  readonly timezone: string;
  readonly merchantDomain: string;
  readonly item: string;
  readonly currency: string;
  readonly itemMinorUnits: number;
  readonly taxMinorUnits: number;
  readonly feesMinorUnits: number;
  readonly shippingMinorUnits: number;
  readonly totalMinorUnits: number;
  readonly shippingTierRequested: string;
  readonly shippingTierUsed: string;
  readonly steppedDown: boolean;
  readonly itemPoolDraw: number;
  readonly overagePoolDraw: number;
  readonly tolerancePoolDraw: number;
  readonly cardLast4: string;
  readonly windowKind: string;
  readonly windowOutcome: string;
  readonly answeredBy: string | null;
  readonly outcome: string;
  readonly refusalReason: string | null;
  readonly merchantOrderId: string | null;
  readonly refundedAt: string | null;
  /** Whether the merchant carried established recourse, and on what grounds. */
  readonly merchantRecognised: boolean;
  readonly merchantQualifier: string | null;
  /** Whether the owner named the storefront or it was found while browsing. */
  readonly merchantDiscovered: boolean;
}

export interface PaymentsBudgetView {
  readonly enabled: boolean;
  readonly currency: string;
  readonly pools: PoolSnapshot;
  readonly reservationCount: number;
  readonly isPaymentsLeader: boolean;
}

/** Card metadata plus whether the secret store holds every required field. */
export interface PaymentCardView extends CardMetadata {
  readonly materialComplete: boolean;
}

/** The narrow slice of the capability these handlers need. */
export interface PaymentsGatewayService {
  budgetStatus(): Promise<PaymentsBudgetView>;
  listCards(): Promise<{ cards: readonly PaymentCardView[]; defaultCardId: string }>;
  /**
   * Store a card. Implementations write the material to the daemon secret
   * store and MUST NOT return any of it.
   */
  createCard(input: {
    readonly label: string;
    readonly kind: 'virtual' | 'real';
    readonly number: string;
    readonly expiryMonth: number;
    readonly expiryYear: number;
    readonly cvv: string;
    readonly cardholderName: string;
    readonly issuerCapMinorUnits: number | null;
  }): Promise<PaymentCardView>;
  deleteCard(id: string): Promise<{ deleted: boolean; secretsCleared: number }>;
  /**
   * Type the stored card into an open checkout page.
   *
   * The implementation reads the material from the daemon secret store, checks
   * that a purchase is in flight on that page and that the page is still on the
   * merchant it was decided against, and types. It MUST NOT return any part of
   * the material, and MUST NOT include any of it in a thrown error.
   */
  fillCardIntoCheckout(input: {
    readonly sessionId: string;
    readonly pageId: string;
    readonly targets: readonly { readonly field: string; readonly ref: string }[];
    readonly expirySeparator: string | undefined;
    readonly twoDigitYear: boolean | undefined;
  }): Promise<PaymentFillCardResult>;
  listPurchases(input: { readonly limit: number; readonly dayKey: string | undefined }):
    Promise<{ purchases: readonly PaymentPurchaseView[]; total: number }>;
}

/** What a fill reports. Field names and a boolean — nothing that holds a value. */
export interface PaymentFillCardResult {
  readonly ok: boolean;
  readonly filled: readonly string[];
  readonly failedField: string | null;
  readonly reason: string | null;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`${field} is required.`, 'VALIDATION_FAILED', 400);
  }
  return value.trim();
}

function readInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new GatewayVerbError(`${field} must be a whole number.`, 'VALIDATION_FAILED', 400);
  }
  return value;
}

/**
 * The exact set of card fields that may leave this process.
 *
 * Built by naming what is ALLOWED rather than by deleting what is forbidden.
 * A denylist silently ships whatever field a later change adds; an allowlist
 * silently drops it, and for card material that is the correct direction to
 * fail.
 */
function sanitizeCardMetadata(card: PaymentCardView): PaymentCardView {
  return {
    id: card.id,
    label: card.label,
    brand: card.brand,
    last4: card.last4,
    kind: card.kind,
    expiryMonth: card.expiryMonth,
    expiryYear: card.expiryYear,
    issuerCapMinorUnits: card.issuerCapMinorUnits,
    addedAt: card.addedAt,
    materialComplete: card.materialComplete,
  };
}

export function createPaymentsBudgetStatusHandler(service: PaymentsGatewayService): GatewayMethodHandler {
  return async () => {
    const view = await service.budgetStatus();
    return {
      enabled: view.enabled,
      dayKey: view.pools.dayKey,
      timezone: view.pools.timezone,
      currency: view.currency,
      item: view.pools.item,
      overage: view.pools.overage,
      tolerance: view.pools.tolerance,
      reservationCount: view.reservationCount,
      isPaymentsLeader: view.isPaymentsLeader,
    };
  };
}

export function createPaymentsCardsListHandler(service: PaymentsGatewayService): GatewayMethodHandler {
  return async () => {
    const { cards, defaultCardId } = await service.listCards();
    return { cards: cards.map(sanitizeCardMetadata), defaultCardId };
  };
}

export function createPaymentsCardsCreateHandler(service: PaymentsGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const kind = readString(params['kind'], 'kind');
    if (kind !== 'virtual' && kind !== 'real') {
      throw new GatewayVerbError("kind must be 'virtual' or 'real'.", 'VALIDATION_FAILED', 400);
    }
    const issuerCap = params['issuerCapMinorUnits'];
    let card: PaymentCardView;
    try {
      card = await service.createCard({
        label: readString(params['label'], 'label'),
        kind,
        number: readString(params['number'], 'number'),
        expiryMonth: readInteger(params['expiryMonth'], 'expiryMonth'),
        expiryYear: readInteger(params['expiryYear'], 'expiryYear'),
        cvv: readString(params['cvv'], 'cvv'),
        cardholderName: readString(params['cardholderName'], 'cardholderName'),
        issuerCapMinorUnits: typeof issuerCap === 'number' ? issuerCap : null,
      });
    } catch (error) {
      // Deliberately does not forward the underlying message: the failing call
      // had the card in its arguments, and an error string is a read path like
      // any other.
      void error;
      throw new GatewayVerbError(
        'Storing the card failed. Nothing was saved.',
        'INTERNAL_ERROR',
        500,
      );
    }
    return { card: sanitizeCardMetadata(card) };
  };
}

export function createPaymentsCardsDeleteHandler(service: PaymentsGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const id = readString(params['id'], 'id');
    const result = await service.deleteCard(id);
    return { id, deleted: result.deleted, secretsCleared: result.secretsCleared };
  };
}

/**
 * The exact set of fill-result fields that may leave this process.
 *
 * An allowlist for the same reason `sanitizeCardMetadata` is one: a denylist
 * silently ships whatever a later change adds, and for anything on the card's
 * code path that is the wrong direction to fail. `filled` is rebuilt as strings
 * so a service that returned richer objects — with, say, the value it typed —
 * loses everything but the names.
 */
function sanitizeFillResult(result: PaymentFillCardResult): PaymentFillCardResult {
  return {
    ok: result.ok === true,
    filled: (result.filled ?? []).map((field) => String(field)),
    failedField: result.failedField === null || result.failedField === undefined
      ? null
      : String(result.failedField),
    reason: result.reason === null || result.reason === undefined ? null : String(result.reason),
  };
}

export function createPaymentsCheckoutFillCardHandler(service: PaymentsGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const rawTargets = params['targets'];
    if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
      throw new GatewayVerbError(
        'targets is required: name each card field you found and the ref to type it into.',
        'VALIDATION_FAILED',
        400,
      );
    }
    const targets = rawTargets.map((entry, index) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new GatewayVerbError(`targets[${String(index)}] must be an object.`, 'VALIDATION_FAILED', 400);
      }
      const record = entry as Record<string, unknown>;
      return {
        field: readString(record['field'], `targets[${String(index)}].field`),
        ref: readString(record['ref'], `targets[${String(index)}].ref`),
      };
    });

    const separator = params['expirySeparator'];
    const twoDigit = params['twoDigitYear'];

    let result: PaymentFillCardResult;
    try {
      result = await service.fillCardIntoCheckout({
        sessionId: readString(params['sessionId'], 'sessionId'),
        pageId: readString(params['pageId'], 'pageId'),
        targets,
        expirySeparator: typeof separator === 'string' ? separator : undefined,
        twoDigitYear: typeof twoDigit === 'boolean' ? twoDigit : undefined,
      });
    } catch (error) {
      // A refusal is the owner's business and carries no material, so its
      // message is forwarded. Anything else is replaced: the failing call had
      // the card in its stack, and an error string is a read path like any
      // other.
      const refusal = error instanceof Error && error.name === 'FillCardRefusal' ? error.message : null;
      if (refusal !== null) throw new GatewayVerbError(refusal, 'VALIDATION_FAILED', 400);
      throw new GatewayVerbError(
        'Filling the card into this checkout failed. Nothing was submitted.',
        'INTERNAL_ERROR',
        500,
      );
    }
    return { ...sanitizeFillResult(result) };
  };
}

export function createPaymentsPurchasesListHandler(service: PaymentsGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const rawLimit = params['limit'];
    const limit = typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 500)
      : 100;
    const rawDay = params['dayKey'];
    const result = await service.listPurchases({
      limit,
      dayKey: typeof rawDay === 'string' && rawDay.trim().length > 0 ? rawDay.trim() : undefined,
    });
    return { purchases: result.purchases, total: result.total };
  };
}

/** Attach the payment handlers to their registered descriptors (missing = no-op). */
export function registerPaymentsGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: PaymentsGatewayService,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('payments.budget.status', createPaymentsBudgetStatusHandler(service));
  attach('payments.cards.list', createPaymentsCardsListHandler(service));
  attach('payments.cards.create', createPaymentsCardsCreateHandler(service));
  attach('payments.cards.delete', createPaymentsCardsDeleteHandler(service));
  attach('payments.checkout.fillCard', createPaymentsCheckoutFillCardHandler(service));
  attach('payments.purchases.list', createPaymentsPurchasesListHandler(service));
}
