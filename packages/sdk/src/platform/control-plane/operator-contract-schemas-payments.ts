/**
 * operator-contract-schemas-payments.ts
 *
 * Input/output JSON schemas for the `payments.*` operator methods.
 *
 * Note what is absent and must stay absent: no schema here carries a card
 * number, an expiry, a CVV or a cardholder name. Card material is write-only
 * across every wire — it goes to the daemon secret store and nothing reads it
 * back out over the control plane. `last4` is the only thing about the
 * instrument a surface ever sees. See docs/payments.md §3.1 and §9.5.
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
     * Such a node refuses every purchase — today's spend does not replicate,
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
    /** Whether every required secret field is present — never the values. */
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
 * The response is the metadata record only — there is deliberately no echo of
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
    /** approval | veto | none — which window ran, and how it ended. */
    windowKind: STRING_SCHEMA,
    windowOutcome: STRING_SCHEMA,
    /** Which command-authority channel actually answered, when one did. */
    answeredBy: nullableSchema(STRING_SCHEMA),
    outcome: STRING_SCHEMA,
    refusalReason: nullableSchema(STRING_SCHEMA),
    merchantOrderId: nullableSchema(STRING_SCHEMA),
    /** Set when money came back. Recorded for reconciliation; credits no pool. */
    refundedAt: nullableSchema(STRING_SCHEMA),
  },
  [
    'purchaseId', 'atUtc', 'dayKey', 'timezone', 'merchantDomain', 'item', 'currency',
    'itemMinorUnits', 'taxMinorUnits', 'feesMinorUnits', 'shippingMinorUnits', 'totalMinorUnits',
    'shippingTierRequested', 'shippingTierUsed', 'steppedDown',
    'itemPoolDraw', 'overagePoolDraw', 'tolerancePoolDraw', 'cardLast4',
    'windowKind', 'windowOutcome', 'answeredBy', 'outcome', 'refusalReason',
    'merchantOrderId', 'refundedAt',
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
