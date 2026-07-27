/**
 * Payment-capability config interfaces. Split out of schema-types.ts so that
 * file stays under its grandfathered line ceiling; re-exported from
 * schema-types.ts so import sites are unchanged.
 *
 * Card MATERIAL is deliberately absent from every type here. The number,
 * expiry, CVV and cardholder name live in the daemon secret store under keys
 * derived by `daemonSecretKeyFor`, never in config — see docs/payments.md §3.
 */

/** Which delivery tier to prefer, ordinal against what a checkout offers. */
export type ShippingTierPreference = 'normal' | 'fast' | 'fastest';

/**
 * How the card verification value is handled.
 *
 * `'stored'` is the default and the owner's ruling: autonomous action requires
 * it, because a purchase that stops to ask for a code is an attended purchase.
 * `'prompt'` disables unattended purchasing — surfaces state that at the moment
 * of selection. See docs/decisions/2026-07-27-the-cvv-is-stored.md.
 */
export type CvvHandling = 'stored' | 'prompt';

export interface PaymentsBudgetConfig {
  dailyItemCents: number;                        // default: 0
  dailyOverageCents: number;                     // default: 0
  perPurchaseCeilingEnabled: boolean;            // default: true
  perPurchaseCeilingCents: number;               // default: 0
  overageToleranceEnabled: boolean;              // default: false
  overageToleranceDailyAllowanceCents: number;   // default: 0
}

export interface PaymentsWindowsConfig {
  /** Within budget. Silence PROCEEDS. */
  vetoMinutes: number;      // default: 10
  /** Above budget. Silence DENIES. */
  approvalMinutes: number;  // default: 60
}

export interface PaymentsConfig {
  enabled: boolean;                 // default: false — master switch
  defaultCardId: string;            // default: '' — which card a purchase uses when it names none
  currency: string;                 // default: 'USD' — ISO-4217 the budgets are denominated in
  cvvHandling: CvvHandling;         // default: 'stored'
  budget: PaymentsBudgetConfig;
  shipping: { preferredTier: ShippingTierPreference };
  /** Ordered command-authority channels. Email is never accepted here. */
  notifyChannels: string;           // default: ''
  windows: PaymentsWindowsConfig;
}

/**
 * Every `payments.*` config key, as one named union.
 *
 * Named rather than spelled inline in `ConfigKey` so the payment surface can
 * grow without pushing schema-types.ts past its line ceiling, and so a reader
 * looking for "what can be configured about payments" finds it in one place.
 */
export type PaymentsConfigKey =
  | 'payments.enabled'
  | 'payments.defaultCardId'
  | 'payments.currency'
  | 'payments.cvvHandling'
  | 'payments.budget.dailyItemCents'
  | 'payments.budget.dailyOverageCents'
  | 'payments.budget.perPurchaseCeilingEnabled'
  | 'payments.budget.perPurchaseCeilingCents'
  | 'payments.budget.overageToleranceEnabled'
  | 'payments.budget.overageToleranceDailyAllowanceCents'
  | 'payments.shipping.preferredTier'
  | 'payments.windows.vetoMinutes'
  | 'payments.windows.approvalMinutes'
  | 'payments.notifyChannels';

/** The value type each payments key carries, for `ConfigValue<K>`. */
export interface PaymentsConfigValueMap {
  'payments.enabled': boolean;
  'payments.defaultCardId': string;
  'payments.currency': string;
  'payments.cvvHandling': CvvHandling;
  'payments.budget.dailyItemCents': number;
  'payments.budget.dailyOverageCents': number;
  'payments.budget.perPurchaseCeilingEnabled': boolean;
  'payments.budget.perPurchaseCeilingCents': number;
  'payments.budget.overageToleranceEnabled': boolean;
  'payments.budget.overageToleranceDailyAllowanceCents': number;
  'payments.shipping.preferredTier': ShippingTierPreference;
  'payments.windows.vetoMinutes': number;
  'payments.windows.approvalMinutes': number;
  'payments.notifyChannels': string;
}
