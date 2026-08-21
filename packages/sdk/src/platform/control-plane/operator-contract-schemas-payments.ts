/**
 * operator-contract-schemas-payments.ts
 *
 * Input/output JSON schemas for the `payments.*` operator methods.
 *
 * Note what is absent and must stay absent: no schema here carries a card
 * number, an expiry, a CVV or a cardholder name, in EITHER direction. Card
 * material goes to the daemon secret store through `payments.cards.create` and
 * nothing reads it back out over the control plane. `last4` is the only thing
 * about the instrument a surface ever sees. See docs/payments.md §3.1 and §9.5.
 *
 * `payments.checkout.fillCard` is the one verb that causes a card to be typed,
 * and it is the sharpest illustration of the rule rather than an exception to
 * it: its INPUT is a card id and a list of field targets, and its OUTPUT is a
 * list of field NAMES and a boolean. The daemon reads the material in-process
 * and types it. There is no property on either schema that could hold a value,
 * which is the point, the containment is a shape, not a promise.
 *
 * Handlers: routes/payments.ts.
 */
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  enumSchema,
  nullableSchema,
  objectSchema,
} from './operator-contract-schemas-shared.js';

/** One daily pool: its limit, what today has spent, what is held, what is left. */
const POOL_SCHEMA = objectSchema(
  {
    limit: NUMBER_SCHEMA,
    spent: NUMBER_SCHEMA,
    reserved: NUMBER_SCHEMA,
    remaining: NUMBER_SCHEMA,
  },
  ['limit', 'spent', 'reserved', 'remaining'],
);

export const PAYMENTS_BUDGET_STATUS_INPUT_SCHEMA = objectSchema({}, []);

export const PAYMENTS_BUDGET_STATUS_OUTPUT_SCHEMA = objectSchema(
  {
    enabled: BOOLEAN_SCHEMA,
    /** The calendar day these totals belong to, in the daemon's timezone. */
    dayKey: STRING_SCHEMA,
    /** Resolved zone: the configured `daemon.timezone`, or 'UTC' when unset. */
    timezone: STRING_SCHEMA,
    currency: STRING_SCHEMA,
    item: POOL_SCHEMA,
    overage: POOL_SCHEMA,
    tolerance: POOL_SCHEMA,
    /** How many purchases are holding budget right now. */
    reservationCount: NUMBER_SCHEMA,
    /**
     * False on a clustered node that is not the elected payments leader.
     * Such a node refuses every purchase, today's spend does not replicate,
     * so a second spender would start from a clean daily budget.
     */
    isPaymentsLeader: BOOLEAN_SCHEMA,
  },
  ['enabled', 'dayKey', 'timezone', 'currency', 'item', 'overage', 'tolerance', 'reservationCount', 'isPaymentsLeader'],
);

/** A card as every surface sees it. Metadata only, by construction. */
const CARD_METADATA_SCHEMA = objectSchema(
  {
    id: STRING_SCHEMA,
    label: STRING_SCHEMA,
    brand: STRING_SCHEMA,
    last4: STRING_SCHEMA,
    kind: enumSchema(['virtual', 'real']),
    expiryMonth: NUMBER_SCHEMA,
    expiryYear: NUMBER_SCHEMA,
    /** Declared by the owner and unverifiable by us; never treated as enforcement. */
    issuerCapMinorUnits: nullableSchema(NUMBER_SCHEMA),
    addedAt: STRING_SCHEMA,
    /** Whether every required secret field is present, never the values. */
    materialComplete: BOOLEAN_SCHEMA,
  },
  ['id', 'label', 'brand', 'last4', 'kind', 'expiryMonth', 'expiryYear', 'issuerCapMinorUnits', 'addedAt', 'materialComplete'],
);

export const PAYMENTS_CARDS_LIST_INPUT_SCHEMA = objectSchema({}, []);

export const PAYMENTS_CARDS_LIST_OUTPUT_SCHEMA = objectSchema(
  { cards: arraySchema(CARD_METADATA_SCHEMA), defaultCardId: STRING_SCHEMA },
  ['cards', 'defaultCardId'],
);

/**
 * Adding a card. Card material goes IN and never comes back out.
 *
 * The response is the metadata record only, there is deliberately no echo of
 * what was submitted, because an echo is a read path and the whole point is
 * that no read path exists.
 */
export const PAYMENTS_CARDS_CREATE_INPUT_SCHEMA = objectSchema(
  {
    label: STRING_SCHEMA,
    kind: enumSchema(['virtual', 'real']),
    number: STRING_SCHEMA,
    expiryMonth: NUMBER_SCHEMA,
    expiryYear: NUMBER_SCHEMA,
    cvv: STRING_SCHEMA,
    cardholderName: STRING_SCHEMA,
    issuerCapMinorUnits: nullableSchema(NUMBER_SCHEMA),
  },
  ['label', 'kind', 'number', 'expiryMonth', 'expiryYear', 'cvv', 'cardholderName'],
);

export const PAYMENTS_CARDS_CREATE_OUTPUT_SCHEMA = objectSchema(
  { card: CARD_METADATA_SCHEMA },
  ['card'],
);

export const PAYMENTS_CARDS_DELETE_INPUT_SCHEMA = objectSchema({ id: STRING_SCHEMA }, ['id']);

export const PAYMENTS_CARDS_DELETE_OUTPUT_SCHEMA = objectSchema(
  { id: STRING_SCHEMA, deleted: BOOLEAN_SCHEMA, secretsCleared: NUMBER_SCHEMA },
  ['id', 'deleted', 'secretsCleared'],
);

/** One purchase, as the audit ledger recorded it. */
const PURCHASE_RECORD_SCHEMA = objectSchema(
  {
    purchaseId: STRING_SCHEMA,
    atUtc: STRING_SCHEMA,
    dayKey: STRING_SCHEMA,
    timezone: STRING_SCHEMA,
    merchantDomain: STRING_SCHEMA,
    item: STRING_SCHEMA,
    currency: STRING_SCHEMA,
    itemMinorUnits: NUMBER_SCHEMA,
    taxMinorUnits: NUMBER_SCHEMA,
    feesMinorUnits: NUMBER_SCHEMA,
    shippingMinorUnits: NUMBER_SCHEMA,
    totalMinorUnits: NUMBER_SCHEMA,
    shippingTierRequested: STRING_SCHEMA,
    shippingTierUsed: STRING_SCHEMA,
    /** Present when the ladder stepped delivery down to fit the overage pool. */
    steppedDown: BOOLEAN_SCHEMA,
    itemPoolDraw: NUMBER_SCHEMA,
    overagePoolDraw: NUMBER_SCHEMA,
    tolerancePoolDraw: NUMBER_SCHEMA,
    cardLast4: STRING_SCHEMA,
    /** approval | veto | none, which window ran, and how it ended. */
    windowKind: STRING_SCHEMA,
    windowOutcome: STRING_SCHEMA,
    /** Which command-authority channel actually answered, when one did. */
    answeredBy: nullableSchema(STRING_SCHEMA),
    outcome: STRING_SCHEMA,
    refusalReason: nullableSchema(STRING_SCHEMA),
    merchantOrderId: nullableSchema(STRING_SCHEMA),
    /** Set when money came back. Recorded for reconciliation; credits no pool. */
    refundedAt: nullableSchema(STRING_SCHEMA),
    /**
     * Whether the merchant carried established recourse, and on what grounds.
     *
     * This is the fact that decided what SILENCE meant on this purchase, so it
     * belongs in the row beside the outcome. Without it a reader can see that
     * one purchase asked and another did not, and cannot see why.
     */
    merchantRecognised: BOOLEAN_SCHEMA,
    merchantQualifier: nullableSchema(STRING_SCHEMA),
    /** Whether the owner named the storefront or it was found while browsing. */
    merchantDiscovered: BOOLEAN_SCHEMA,
  },
  [
    'purchaseId', 'atUtc', 'dayKey', 'timezone', 'merchantDomain', 'item', 'currency',
    'itemMinorUnits', 'taxMinorUnits', 'feesMinorUnits', 'shippingMinorUnits', 'totalMinorUnits',
    'shippingTierRequested', 'shippingTierUsed', 'steppedDown',
    'itemPoolDraw', 'overagePoolDraw', 'tolerancePoolDraw', 'cardLast4',
    'windowKind', 'windowOutcome', 'answeredBy', 'outcome', 'refusalReason',
    'merchantOrderId', 'refundedAt',
    'merchantRecognised', 'merchantQualifier', 'merchantDiscovered',
  ],
);

export const PAYMENTS_PURCHASES_LIST_INPUT_SCHEMA = objectSchema(
  { limit: NUMBER_SCHEMA, dayKey: STRING_SCHEMA },
  [],
);

export const PAYMENTS_PURCHASES_LIST_OUTPUT_SCHEMA = objectSchema(
  { purchases: arraySchema(PURCHASE_RECORD_SCHEMA), total: NUMBER_SCHEMA },
  ['purchases', 'total'],
);


// ---------------------------------------------------------------------------
// payments.checkout.fillCard
// ---------------------------------------------------------------------------

/**
 * Which card field goes where.
 *
 * `ref` is a snapshot ref from the page the model is looking at, so the daemon
 * needs no knowledge of any merchant's markup. The model finds the fields; the
 * daemon does the typing.
 */
const CARD_FIELD_TARGET_SCHEMA = objectSchema(
  {
    field: enumSchema(['number', 'expiry', 'expiryMonth', 'expiryYear', 'cvv', 'cardholderName']),
    ref: STRING_SCHEMA,
  },
  ['field', 'ref'],
);

export const PAYMENTS_CHECKOUT_FILL_CARD_INPUT_SCHEMA = objectSchema(
  {
    sessionId: STRING_SCHEMA,
    pageId: STRING_SCHEMA,
    // `minItems` is declared because the HANDLER rejects an empty list. A
    // handler stricter than its published contract is a 400 no consumer could
    // have predicted from the schema, and no build step can catch the gap.
    targets: { ...arraySchema(CARD_FIELD_TARGET_SCHEMA), minItems: 1 },
    /** Some checkouts want `07/2029`, some want `07 / 29`. The caller saw the field. */
    expirySeparator: STRING_SCHEMA,
    twoDigitYear: BOOLEAN_SCHEMA,
  },
  ['sessionId', 'pageId', 'targets'],
);

/**
 * What comes back: which fields were filled, and nothing else.
 *
 * `filled` is a list of field NAMES. `failedField` names the one that did not
 * work. There is deliberately no property here that could carry a value, a
 * length, a prefix or a masked form, an echo is a read path, and the whole
 * design rests on no read path existing.
 */
export const PAYMENTS_CHECKOUT_FILL_CARD_OUTPUT_SCHEMA = objectSchema(
  {
    ok: BOOLEAN_SCHEMA,
    filled: arraySchema(STRING_SCHEMA),
    failedField: nullableSchema(STRING_SCHEMA),
    reason: nullableSchema(STRING_SCHEMA),
  },
  ['ok', 'filled', 'failedField', 'reason'],
);


// ---------------------------------------------------------------------------
// payments.checkout.begin
// ---------------------------------------------------------------------------

/**
 * One line item, as the caller read it off the page.
 *
 * Every amount is a STRING here on purpose. The daemon parses these to integer
 * minor units with its own parser, which refuses anything ambiguous; accepting
 * a number would mean trusting whoever did the reading to have parsed
 * "1.299,00" the same way we would, and that is the exact mistake that costs a
 * factor of a thousand.
 */
const CHECKOUT_LINE_SCHEMA = objectSchema(
  { label: STRING_SCHEMA, quantity: STRING_SCHEMA, unitPrice: STRING_SCHEMA },
  ['label', 'quantity', 'unitPrice'],
);

const CHECKOUT_FEE_SCHEMA = objectSchema(
  { label: STRING_SCHEMA, amount: STRING_SCHEMA },
  ['label', 'amount'],
);

const CHECKOUT_SHIPPING_OPTION_SCHEMA = objectSchema(
  { label: STRING_SCHEMA, cost: STRING_SCHEMA },
  ['label', 'cost'],
);

/** What the owner asked for, so the cart can be checked against it. */
const REQUESTED_LINE_SCHEMA = objectSchema(
  { label: STRING_SCHEMA, quantity: NUMBER_SCHEMA },
  ['label', 'quantity'],
);

const ADDRESS_FIELD_TARGET_SCHEMA = objectSchema(
  {
    kind: enumSchema(['shipping', 'billing']),
    field: enumSchema(['name', 'line1', 'line2', 'city', 'region', 'postalCode', 'country']),
    ref: STRING_SCHEMA,
  },
  ['kind', 'field', 'ref'],
);

const CARD_TARGET_SCHEMA = objectSchema(
  {
    field: enumSchema(['number', 'expiry', 'expiryMonth', 'expiryYear', 'cvv', 'cardholderName']),
    ref: STRING_SCHEMA,
  },
  ['field', 'ref'],
);

/**
 * Beginning a checkout.
 *
 * Note which `required` entries are present. The handler refuses without every
 * one of them, and a catalog that declared fewer would produce a 400 no
 * consumer could have predicted from the schema, the omission found in
 * method-catalog-email.ts, where the handler enforces `uid` and the descriptor
 * declares nothing.
 */
export const PAYMENTS_CHECKOUT_BEGIN_INPUT_SCHEMA = objectSchema(
  {
    sessionId: STRING_SCHEMA,
    pageId: STRING_SCHEMA,
    merchantDomain: STRING_SCHEMA,
    checkoutUrl: STRING_SCHEMA,
    /** The owner's own words for what he asked to buy. Never a page title. */
    item: STRING_SCHEMA,
    cardId: STRING_SCHEMA,
    requestedLines: { ...arraySchema(REQUESTED_LINE_SCHEMA), minItems: 1 },
    lines: { ...arraySchema(CHECKOUT_LINE_SCHEMA), minItems: 1 },
    tax: STRING_SCHEMA,
    fees: arraySchema(CHECKOUT_FEE_SCHEMA),
    shippingOptions: { ...arraySchema(CHECKOUT_SHIPPING_OPTION_SCHEMA), minItems: 1 },
    statedTotal: STRING_SCHEMA,
    currency: STRING_SCHEMA,
    orderSummaryText: STRING_SCHEMA,
    cardFields: { ...arraySchema(CARD_TARGET_SCHEMA), minItems: 1 },
    addressFields: arraySchema(ADDRESS_FIELD_TARGET_SCHEMA),
    shippingTargets: arraySchema(STRING_SCHEMA),
    placeOrderTarget: STRING_SCHEMA,
    preferredTier: enumSchema(['normal', 'fast', 'fastest']),
    expirySeparator: STRING_SCHEMA,
    twoDigitYear: BOOLEAN_SCHEMA,
    requestedMax: STRING_SCHEMA,
  },
  [
    'sessionId', 'pageId', 'merchantDomain', 'checkoutUrl', 'item', 'cardId',
    'requestedLines', 'lines', 'shippingOptions', 'cardFields', 'placeOrderTarget',
  ],
);

/**
 * What comes back.
 *
 * Amounts are integers WE computed, never the merchant's text, and there is no
 * field here that could carry card material.
 */
export const PAYMENTS_CHECKOUT_BEGIN_OUTPUT_SCHEMA = objectSchema(
  {
    outcome: STRING_SCHEMA,
    purchaseId: nullableSchema(STRING_SCHEMA),
    reason: nullableSchema(STRING_SCHEMA),
    merchantOrderId: nullableSchema(STRING_SCHEMA),
    totalMinorUnits: nullableSchema(NUMBER_SCHEMA),
    currency: nullableSchema(STRING_SCHEMA),
    shippingTierUsed: nullableSchema(STRING_SCHEMA),
    steppedDown: BOOLEAN_SCHEMA,
    /** Set when 3-D Secure, a CAPTCHA or an OTP interrupted the submit. */
    challengeStep: nullableSchema(STRING_SCHEMA),
  },
  ['outcome', 'purchaseId', 'reason', 'merchantOrderId', 'totalMinorUnits', 'currency', 'shippingTierUsed', 'steppedDown', 'challengeStep'],
);
