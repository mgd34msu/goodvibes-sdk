/**
 * method-catalog-payments.ts
 *
 * The `payments.*` operator methods the daemon serves. The daemon is the
 * process that holds the card and charges it, with every surface closed and
 * across restarts, so these are the surfaces' only way to see or change any of
 * it.
 *
 * What is deliberately NOT here: any method that returns card material. The
 * number, expiry, CVV and cardholder name go in through `payments.cards.create`
 * and are never readable back over the control plane, `payments.cards.list`
 * answers with metadata and a `materialComplete` flag so a surface can render
 * "CVV not set" without the daemon ever emitting one. See docs/payments.md §3.1.
 *
 * `payments.checkout.fillCard` is what makes the capability able to buy
 * anything, and it does NOT weaken the rule above. A card that can never reach
 * a checkout field cannot buy anything, so the daemon types it, taking a card
 * id and field targets, and answering with field names and a boolean. The model
 * orchestrates the purchase and never holds the instrument, which was always
 * the property that mattered.
 *
 * Scopes: reads take `read:payments`, writes take `write:payments`. Card
 * creation and deletion are admin-only, because anything that can rewrite the
 * card can redirect where money goes.
 *
 * Handlers: routes/payments.ts.
 */
import { methodDescriptor } from './method-catalog-shared.js';
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  PAYMENTS_BUDGET_STATUS_INPUT_SCHEMA,
  PAYMENTS_BUDGET_STATUS_OUTPUT_SCHEMA,
  PAYMENTS_CARDS_CREATE_INPUT_SCHEMA,
  PAYMENTS_CARDS_CREATE_OUTPUT_SCHEMA,
  PAYMENTS_CARDS_DELETE_INPUT_SCHEMA,
  PAYMENTS_CARDS_DELETE_OUTPUT_SCHEMA,
  PAYMENTS_CARDS_LIST_INPUT_SCHEMA,
  PAYMENTS_CARDS_LIST_OUTPUT_SCHEMA,
  PAYMENTS_CHECKOUT_BEGIN_INPUT_SCHEMA,
  PAYMENTS_CHECKOUT_BEGIN_OUTPUT_SCHEMA,
  PAYMENTS_CHECKOUT_FILL_CARD_INPUT_SCHEMA,
  PAYMENTS_CHECKOUT_FILL_CARD_OUTPUT_SCHEMA,
  PAYMENTS_PURCHASES_LIST_INPUT_SCHEMA,
  PAYMENTS_PURCHASES_LIST_OUTPUT_SCHEMA,
} from './operator-contract-schemas-payments.js';

export const builtinGatewayPaymentsMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'payments.budget.status',
    title: 'Payment Budget Status',
    description:
      "Today's spending pools: the daily item budget, the separate overage budget that covers only unavoidable charges (tax, mandatory fees, and the delivery option actually used), and the tolerance allowance. Each reports its limit, what today has spent, what purchases in flight are holding, and what is left. Includes the calendar day and the timezone it was computed in, the day resets at midnight in daemon.timezone, UTC when unset, and whether this node is the one currently allowed to spend. Totals are recomputed from each spend record's UTC instant rather than counted, so changing the timezone cannot hand back a spent budget.",
    category: 'payments',
    scopes: ['read:payments'],
    http: { method: 'GET', path: '/api/payments/budget' },
    inputSchema: PAYMENTS_BUDGET_STATUS_INPUT_SCHEMA,
    outputSchema: PAYMENTS_BUDGET_STATUS_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'payments.cards.list',
    title: 'List Payment Cards',
    description:
      'Configured cards, as METADATA ONLY: id, label, brand, last four digits, whether it is a virtual or a real card, expiry month and year, and the issuer spend cap the owner declared for a virtual card (declared, unverifiable by us, and never treated as an enforcement layer of ours). materialComplete reports whether every required secret field is present without revealing any of them. The card number, expiry, CVV and cardholder name live in the daemon secret store and there is no method that returns them.',
    category: 'payments',
    scopes: ['read:payments'],
    http: { method: 'GET', path: '/api/payments/cards' },
    inputSchema: PAYMENTS_CARDS_LIST_INPUT_SCHEMA,
    outputSchema: PAYMENTS_CARDS_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'payments.cards.create',
    title: 'Add a Payment Card',
    description:
      'Store a card. The number, expiry, CVV and cardholder name go to the daemon secret store, encrypted at rest, under keys derived from the config path; only the label, brand, last four digits, kind and declared issuer cap are kept as config. The response carries the metadata record and never echoes what was submitted, because an echo would be a read path and no read path exists. A virtual card with a hard issuer cap is the recommended configuration: it bounds what any leak could cost to one killable number, which a real card number does not.',
    category: 'payments',
    scopes: ['write:payments'],
    access: 'admin',
    http: { method: 'POST', path: '/api/payments/cards' },
    inputSchema: PAYMENTS_CARDS_CREATE_INPUT_SCHEMA,
    outputSchema: PAYMENTS_CARDS_CREATE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'payments.cards.delete',
    title: 'Remove a Payment Card',
    description:
      'Delete a card: its config metadata and every secret derived from its config path, reporting how many secret entries were cleared so a partial deletion is visible rather than silent. Deleting the default card leaves payments.defaultCardId empty, which refuses purchases until another card is chosen, the safe direction.',
    category: 'payments',
    scopes: ['write:payments'],
    access: 'admin',
    http: { method: 'DELETE', path: '/api/payments/cards/{id}' },
    inputSchema: PAYMENTS_CARDS_DELETE_INPUT_SCHEMA,
    outputSchema: PAYMENTS_CARDS_DELETE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'payments.checkout.begin',
    title: 'Buy What Is In This Checkout',
    description:
      "Run a purchase against an open browser page, end to end: the caller reports the checkout's line items, tax, fees and delivery options AS STRINGS plus the refs of the card, address, delivery and place-order controls, and the daemon does the rest. It parses every amount into integer minor units with its own parser (refusing anything ambiguous rather than guessing), checks the cart against what was actually asked for, refuses a recurring charge, runs the taint gate, applies the daily item budget, the per-purchase ceiling and the overage pool, walks the shipping ladder down one rung at a time when the pool cannot cover the preferred tier, sends ONE notice to the configured command-authority channels and runs the window, above budget an approval where silence denies, within budget a veto where silence proceeds, then fills the stored shipping and billing addresses, types the stored card, submits once, records the purchase, debits the budget and reports the completed purchase. Nothing here knows any merchant's markup: the caller identifies the controls on whatever page it is looking at. Every number the owner is shown is re-rendered from the integers this daemon parsed, never from merchant text, and no response field can carry card material.",
    category: 'payments',
    scopes: ['write:payments'],
    access: 'admin',
    http: { method: 'POST', path: '/api/payments/checkout/begin' },
    inputSchema: PAYMENTS_CHECKOUT_BEGIN_INPUT_SCHEMA,
    outputSchema: PAYMENTS_CHECKOUT_BEGIN_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'payments.checkout.fillCard',
    title: 'Fill the Card into a Checkout',
    description:
      'Have the daemon type the stored card into the payment fields of an open browser page. Takes the browser session, the page, and a list of {field, ref} targets naming where each part of the card goes, the caller identifies the fields on whatever checkout it is looking at, so the daemon needs no knowledge of any merchant. The response is the list of field NAMES that were filled plus a boolean; it never carries the value, its length, or a masked form, and a failure names the field that did not accept input rather than what was typed into it. Refused unless a purchase decision is already in flight on that exact page and the page is still on the registrable domain the purchase was decided against, so the card is typed as part of an approved checkout or not at all. Also refused when the browser has no card-material redaction installed, because a snapshot taken afterwards would otherwise hand back what was just typed.',
    category: 'payments',
    scopes: ['write:payments'],
    access: 'admin',
    http: { method: 'POST', path: '/api/payments/checkout/fill-card' },
    inputSchema: PAYMENTS_CHECKOUT_FILL_CARD_INPUT_SCHEMA,
    outputSchema: PAYMENTS_CHECKOUT_FILL_CARD_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'payments.purchases.list',
    title: 'List Purchases',
    description:
      'The purchase audit ledger: what was bought, from which merchant registrable domain, how much (item, tax, fees and delivery separately), which budget pool each part drew on, which delivery tier was requested and which was actually used, whether the shipping ladder stepped it down, which window ran and how it ended, which command-authority channel answered, and the outcome. Reconcilable against a card statement. Never contains a card number, expiry or CVV. A refund is recorded here for reconciliation and credits no pool, a refund on day five refilling day five would be permission to buy again that nobody granted.',
    category: 'payments',
    scopes: ['read:payments'],
    http: { method: 'GET', path: '/api/payments/purchases' },
    inputSchema: PAYMENTS_PURCHASES_LIST_INPUT_SCHEMA,
    outputSchema: PAYMENTS_PURCHASES_LIST_OUTPUT_SCHEMA,
  }),
];
