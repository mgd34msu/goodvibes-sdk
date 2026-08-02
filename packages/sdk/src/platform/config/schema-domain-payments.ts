/**
 * schema-domain-payments.ts — settings for the daemon's payment capability.
 *
 * Card MATERIAL never appears here: the number, expiry, CVV and cardholder name
 * live in the daemon secret store under keys derived by `daemonSecretKeyFor`,
 * and are write-only across every wire. What lives here is the budget, the
 * windows, the shipping preference and the non-secret card metadata a surface
 * needs in order to show him which card is configured.
 *
 * ── Why every money default is 0 and `enabled` is false ──────────────────
 *
 * Owner's rule for defaults in this capability:
 *
 *   "default to most safe, the user can change affirmatively"
 *
 * Zero is the most safe number. The capability can be fully configured — card
 * entered, addresses set, channels chosen — and still buy nothing at all until
 * he affirmatively names an amount. A refusal against a zero budget reads "the
 * daily item budget is 0 — set one" rather than failing somewhere obscure.
 *
 * The two toggles he ruled on directly keep his values: the per-purchase ceiling
 * defaults ON, overage tolerance defaults OFF.
 *
 * See docs/payments.md for the decision order these numbers feed.
 */
import type { ConfigSetting } from './schema-types.js';
import { intRange } from './schema-shared.js';
import { moneyAmount } from './money-value.js';

export const paymentsConfigDefaults = {
  payments: {
    enabled: false,
    defaultCardId: '',
    currency: 'USD',
    cvvHandling: 'stored' as const,
    budget: {
      dailyItem: 0,
      dailyOverage: 0,
      perPurchaseCeilingEnabled: true,
      perPurchaseCeiling: 0,
      overageToleranceEnabled: false,
      overageToleranceDailyAllowance: 0,
    },
    shipping: {
      preferredTier: 'normal' as const,
    },
    billingAddress: {
      name: '', line1: '', line2: '', city: '', region: '', postalCode: '', country: '',
    },
    shippingAddress: {
      name: '', line1: '', line2: '', city: '', region: '', postalCode: '', country: '',
    },
    windows: {
      vetoMinutes: 10,
      approvalMinutes: 60,
    },
    notifyChannels: '',
    majorRetailersAdditional: '',
    majorRetailersExcluded: '',
    ebayMinSellerFeedbackCount: 100,
    ebayMinSellerPositivePercent: 98,
  },
};

export const paymentsConfigSettings: ConfigSetting[] = [
  {
    key: 'payments.enabled',
    type: 'boolean',
    default: false,
    description:
      'Master switch for the payment capability. Default OFF. While false the daemon will not price, reserve, or charge anything, and the payments operator methods refuse. Turning it on does not by itself allow a purchase — the daily budgets below start at 0, so nothing goes through until you set an amount.',
  },
  {
    key: 'payments.defaultCardId',
    type: 'string',
    default: '',
    description:
      'Which configured card to use when a purchase does not name one. Refers to a card id from payments.cards.list; the card NUMBER, expiry and CVV live in the daemon secret store and never in config.',
  },
  {
    key: 'payments.currency',
    type: 'string',
    default: 'USD',
    description:
      'ISO-4217 code your budgets are denominated in. A checkout priced in any other currency is REFUSED rather than converted — the issuer converts at its own rate on its own date, so any number shown to you before the charge would not be the number you are charged.',
    validate: (value: unknown): boolean => typeof value === 'string' && /^[A-Za-z]{3}$/.test(value),
    validationHint: 'a three-letter ISO-4217 code such as USD, GBP or EUR',
  },
  {
    key: 'payments.cvvHandling',
    type: 'enum',
    default: 'stored',
    enumValues: ['stored', 'prompt'],
    description:
      "How the card verification value is handled at checkout. 'stored' (DEFAULT) keeps it in the daemon secret store beside the card number, encrypted at rest, so a purchase within budget completes while you are away — which is what autonomous action requires. Choosing 'prompt' stores nothing and stops every purchase to ask you for the code, which DISABLES UNATTENDED PURCHASING; surfaces show CVV_PROMPT_TRADEOFF_WARNING at the moment you select it. Provisioning a virtual card with a hard issuer cap bounds what any leak of stored card material could cost; a real card number does not.",
  },

  // ── Budgets ────────────────────────────────────────────────────────────
  {
    key: 'payments.budget.dailyItem',
    type: 'number',
    default: 0,
    description:
      "Most that may be spent on ITEM PRICES in one calendar day, written the way you would say it: 100 is a hundred, 19.99 is nineteen ninety-nine, in whatever payments.currency is set to. The item price alone is checked against this; tax, mandatory fees and delivery draw on the separate overage budget below. Resets at midnight in daemon.timezone (UTC when unset) — the boundary is real, so 100 at 23:59 and 100 at 00:00 both go through. Default 0: nothing is bought until you set this.",
    ...moneyAmount(),
  },
  {
    key: 'payments.budget.dailyOverage',
    type: 'number',
    default: 0,
    description:
      'Daily allowance for charges that CANNOT BE AVOIDED on a purchase you already approved: sales tax, mandatory handling or booking fees, and the delivery option actually used. Written the way you would say it — 25 is twenty-five, 7.50 is seven fifty. Discretionary add-ons — expedited shipping beyond what the ladder picks, insurance, gift wrap, extended warranties — are purchase decisions, not delivery costs, and never draw on this. Default 0.',
    ...moneyAmount(),
  },
  {
    key: 'payments.budget.perPurchaseCeilingEnabled',
    type: 'boolean',
    default: true,
    description:
      'When true (DEFAULT), no single purchase may exceed payments.budget.perPurchaseCeiling no matter how much of the daily budget is left. A separate question from the daily budget: both must pass. Turn it off only if you want one purchase to be able to consume the whole day at once.',
  },
  {
    key: 'payments.budget.perPurchaseCeiling',
    type: 'number',
    default: 0,
    description:
      'The most any single purchase may come to, applied when perPurchaseCeilingEnabled is true. Written the way you would say it — 100 is a hundred, 19.99 is nineteen ninety-nine. Default 0, so with the ceiling on and this unset every purchase needs your explicit approval — the safe direction until you choose a number.',
    ...moneyAmount(),
  },
  {
    key: 'payments.budget.overageToleranceEnabled',
    type: 'boolean',
    default: false,
    description:
      'When true, a purchase whose unavoidable charges cannot fit the overage budget even at the CHEAPEST delivery option may draw the shortfall from the tolerance allowance below instead of being refused. Default FALSE. Enabling it alone changes nothing — the allowance also starts at 0.',
  },
  {
    key: 'payments.budget.overageToleranceDailyAllowance',
    type: 'number',
    default: 0,
    description:
      'Daily tolerance allowance, used only when overageToleranceEnabled is true. Written the way you would say it — 5 is five, 2.50 is two fifty. This is a third pool, drawn on only after the shipping ladder has stepped delivery all the way down and the unavoidable charges still do not fit. Every use is recorded in the purchase audit record.',
    ...moneyAmount(),
  },

  // ── Shipping ───────────────────────────────────────────────────────────
  {
    key: 'payments.shipping.preferredTier',
    type: 'enum',
    default: 'normal',
    enumValues: ['normal', 'fast', 'fastest'],
    description:
      "Preferred delivery tier, ordinal against WHAT THE CHECKOUT ACTUALLY OFFERS rather than delivery-day promises: its options are ranked cheapest-first and this indexes into that ranking. The chosen tier draws on the overage budget; when the budget cannot cover it, delivery steps down ONE tier at a time until it fits, stopping at the cheapest. A step-down needs no approval (it is within budget) but is recorded and shown to you, so you never learn about it from a late package. Default 'normal'.",
  },

  // ── Addresses ──────────────────────────────────────────────────────────
  {
    key: 'payments.billingAddress.name',
    type: 'string',
    default: '',
    description:
      'Full name as it appears on the card statement. Part of the billing address the card issuer checks against (address verification). Stored in daemon-owned config rather than the secret store because surfaces must display and edit it — but note it sits beside stored card material, so anyone holding both has everything a card-not-present charge needs. A virtual card with a hard issuer cap is what bounds that.',
  },
  {
    key: 'payments.billingAddress.line1',
    type: 'string',
    default: '',
    description:
      'Street address, first line. Part of the billing address the card issuer checks against (address verification). Stored in daemon-owned config rather than the secret store because surfaces must display and edit it — but note it sits beside stored card material, so anyone holding both has everything a card-not-present charge needs. A virtual card with a hard issuer cap is what bounds that.',
  },
  {
    key: 'payments.billingAddress.line2',
    type: 'string',
    default: '',
    description:
      'Second address line (apartment, suite); leave empty when unused. Part of the billing address the card issuer checks against (address verification). Stored in daemon-owned config rather than the secret store because surfaces must display and edit it — but note it sits beside stored card material, so anyone holding both has everything a card-not-present charge needs. A virtual card with a hard issuer cap is what bounds that.',
  },
  {
    key: 'payments.billingAddress.city',
    type: 'string',
    default: '',
    description:
      'City or town. Part of the billing address the card issuer checks against (address verification). Stored in daemon-owned config rather than the secret store because surfaces must display and edit it — but note it sits beside stored card material, so anyone holding both has everything a card-not-present charge needs. A virtual card with a hard issuer cap is what bounds that.',
  },
  {
    key: 'payments.billingAddress.region',
    type: 'string',
    default: '',
    description:
      'State, province or region. Part of the billing address the card issuer checks against (address verification). Stored in daemon-owned config rather than the secret store because surfaces must display and edit it — but note it sits beside stored card material, so anyone holding both has everything a card-not-present charge needs. A virtual card with a hard issuer cap is what bounds that.',
  },
  {
    key: 'payments.billingAddress.postalCode',
    type: 'string',
    default: '',
    description:
      'Postal or ZIP code. Part of the billing address the card issuer checks against (address verification). Stored in daemon-owned config rather than the secret store because surfaces must display and edit it — but note it sits beside stored card material, so anyone holding both has everything a card-not-present charge needs. A virtual card with a hard issuer cap is what bounds that.',
  },
  {
    key: 'payments.billingAddress.country',
    type: 'string',
    default: '',
    description:
      'Country, as the checkout expects it (an ISO two-letter code is safest). Part of the billing address the card issuer checks against (address verification). Stored in daemon-owned config rather than the secret store because surfaces must display and edit it — but note it sits beside stored card material, so anyone holding both has everything a card-not-present charge needs. A virtual card with a hard issuer cap is what bounds that.',
  },
  {
    key: 'payments.shippingAddress.name',
    type: 'string',
    default: '',
    description:
      'Recipient name. Where purchases are delivered. A purchase is REFUSED while the shipping address is incomplete — there is nowhere to send it, and guessing an address is not a thing this should do.',
  },
  {
    key: 'payments.shippingAddress.line1',
    type: 'string',
    default: '',
    description:
      'Street address, first line. Where purchases are delivered. A purchase is REFUSED while the shipping address is incomplete — there is nowhere to send it, and guessing an address is not a thing this should do.',
  },
  {
    key: 'payments.shippingAddress.line2',
    type: 'string',
    default: '',
    description:
      'Second address line (apartment, suite); leave empty when unused. Where purchases are delivered. A purchase is REFUSED while the shipping address is incomplete — there is nowhere to send it, and guessing an address is not a thing this should do.',
  },
  {
    key: 'payments.shippingAddress.city',
    type: 'string',
    default: '',
    description:
      'City or town. Where purchases are delivered. A purchase is REFUSED while the shipping address is incomplete — there is nowhere to send it, and guessing an address is not a thing this should do.',
  },
  {
    key: 'payments.shippingAddress.region',
    type: 'string',
    default: '',
    description:
      'State, province or region. Where purchases are delivered. A purchase is REFUSED while the shipping address is incomplete — there is nowhere to send it, and guessing an address is not a thing this should do.',
  },
  {
    key: 'payments.shippingAddress.postalCode',
    type: 'string',
    default: '',
    description:
      'Postal or ZIP code. Where purchases are delivered. A purchase is REFUSED while the shipping address is incomplete — there is nowhere to send it, and guessing an address is not a thing this should do.',
  },
  {
    key: 'payments.shippingAddress.country',
    type: 'string',
    default: '',
    description:
      'Country, as the checkout expects it (an ISO two-letter code is safest). Where purchases are delivered. A purchase is REFUSED while the shipping address is incomplete — there is nowhere to send it, and guessing an address is not a thing this should do.',
  },

  // ── The two windows ────────────────────────────────────────────────────
  {
    key: 'payments.windows.vetoMinutes',
    type: 'number',
    default: 10,
    description:
      'How long you get to STOP an in-budget purchase, in minutes, starting once the final total is known and before payment. This is a VETO, not an approval: if you say nothing, the purchase GOES AHEAD. One word cancels it. The window always runs its full length wherever you are — no presence, focus or activity signal shortens it — and an explicit acknowledgement buys immediately.',
    ...intRange(1, 1_440),
  },
  {
    key: 'payments.windows.approvalMinutes',
    type: 'number',
    default: 60,
    description:
      'How long an ABOVE-BUDGET purchase waits for your explicit approval, in minutes. This is the opposite of the veto window: if you say nothing, the purchase is DENIED. Denial is the recoverable outcome — ask again and it goes through — so a short window costs friction while a long one leaves a cart holding a price that may drift. Default 60, which survives a meeting or a commute; raise it if you are away for long stretches.',
    ...intRange(1, 10_080),
  },

  {
    key: 'payments.majorRetailersAdditional',
    type: 'string',
    default: '',
    description:
      "Comma-separated REGISTRABLE domains (eTLD+1, e.g. 'microcenter.com', not 'www.microcenter.com') to add to the recognised-retailer list. A purchase at a recognised retailer gets the veto window — you are told and it goes ahead unless you object. Everything else asks for your yes. The test is recourse: is there a real path to remedy if it goes wrong. Additions are yours alone — nothing is learned onto this list, inferred from a page, or added by an agent, because a page that could argue itself onto it could buy from itself unattended.",
    validate: (value: unknown): boolean => typeof value === 'string',
    validationHint: 'a comma-separated list of registrable domains',
  },
  {
    key: 'payments.majorRetailersExcluded',
    type: 'string',
    default: '',
    description:
      'Comma-separated registrable domains to REMOVE from the shipped recognised-retailer list, so purchases there ask for your yes instead of proceeding on silence. A domain listed in both this and the additions is kept, since the addition is the more specific instruction.',
    validate: (value: unknown): boolean => typeof value === 'string',
    validationHint: 'a comma-separated list of registrable domains',
  },
  {
    key: 'payments.ebayMinSellerFeedbackCount',
    type: 'number',
    default: 100,
    description:
      "Minimum feedback ratings earned AS A SELLER before an eBay Buy It Now listing proceeds on silence. eBay's headline score combines buying and selling, so an account with a large number can have earned all of it buying — only the seller-side figure counts. Below this, the purchase asks for your yes. Auctions and Best Offer listings are refused outright regardless, because there is no final price to show you before paying.",
    ...intRange(0, 1_000_000),
  },
  {
    key: 'payments.ebayMinSellerPositivePercent',
    type: 'number',
    default: 98,
    description:
      'Minimum positive feedback percentage AS A SELLER before an eBay Buy It Now listing proceeds on silence. Read from eBay\'s own feedback widget, never from the seller\'s listing text — if the figures cannot be attributed to eBay with confidence, the purchase asks for your yes rather than assuming.',
    ...intRange(0, 100),
  },
  {
    key: 'payments.notifyChannels',
    type: 'string',
    default: '',
    description:
      "Comma-separated, ordered list of surfaces that receive approval and veto prompts and may answer them: 'tui', 'agent-terminal', 'telegram'. EMAIL IS NOT AND WILL NEVER BE ACCEPTED HERE — an inbound email is content anyone can write and cannot authorize spending. An unrecognised name is rejected rather than ignored, because a channel you believe will reach you and does not is worse than none. Empty means an above-budget purchase has nowhere to ask and is refused, while an in-budget one proceeds unannounced.",
    validate: (value: unknown): boolean => {
      if (typeof value !== 'string') return false;
      if (value.trim().length === 0) return true;
      const allowed = new Set(['tui', 'agent-terminal', 'telegram']);
      return value
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .every((entry) => allowed.has(entry));
    },
    validationHint: "a comma-separated list drawn from 'tui', 'agent-terminal', 'telegram'",
  },
];
