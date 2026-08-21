/**
 * Payment-capability config interfaces. Split out of schema-types.ts so that
 * file stays under its grandfathered line ceiling; re-exported from
 * schema-types.ts so import sites are unchanged.
 *
 * Card MATERIAL is deliberately absent from every type here. The number,
 * expiry, CVV and cardholder name live in the daemon secret store under keys
 * derived by `daemonSecretKeyFor`, never in config, see docs/payments.md §3.
 */

/** Which delivery tier to prefer, ordinal against what a checkout offers. */
export type ShippingTierPreference = 'normal' | 'fast' | 'fastest';

/**
 * How the card verification value is handled.
 *
 * `'stored'` is the default and the owner's ruling: autonomous action requires
 * it, because a purchase that stops to ask for a code is an attended purchase.
 * `'prompt'` disables unattended purchasing, surfaces state that at the moment
 * of selection. See docs/decisions/2026-07-27-the-cvv-is-stored.md.
 */
export type CvvHandling = 'stored' | 'prompt';

export interface PaymentsBudgetConfig {
  dailyItem: number;                    // default: 0
  dailyOverage: number;                 // default: 0
  perPurchaseCeilingEnabled: boolean;   // default: true
  perPurchaseCeiling: number;           // default: 0
  overageToleranceEnabled: boolean;     // default: false
  overageToleranceDailyAllowance: number; // default: 0
}

export interface PaymentsWindowsConfig {
  /** Within budget. Silence PROCEEDS. */
  vetoMinutes: number;      // default: 10
  /** Above budget. Silence DENIES. */
  approvalMinutes: number;  // default: 60
}

/** A postal address, flat so each field is an ordinary config key. */
export interface PaymentsAddressConfig {
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

export interface PaymentsConfig {
  enabled: boolean;                 // default: false — master switch
  defaultCardId: string;            // default: '' — which card a purchase uses when it names none
  currency: string;                 // default: 'USD' — ISO-4217 the budgets are denominated in
  cvvHandling: CvvHandling;         // default: 'stored'
  budget: PaymentsBudgetConfig;
  shipping: { preferredTier: ShippingTierPreference };
  /** Checked by the issuer's address verification. */
  billingAddress: PaymentsAddressConfig;
  /** Where purchases go. A purchase is refused while this is incomplete. */
  shippingAddress: PaymentsAddressConfig;
  /** Ordered command-authority channels. Email is never accepted here. */
  notifyChannels: string;           // default: ''
  /** Registrable domains added to / removed from the recognised-retailer list. */
  majorRetailersAdditional: string; // default: ''
  majorRetailersExcluded: string;   // default: ''
  /** eBay per-listing bar; seller-side figures only. */
  ebayMinSellerFeedbackCount: number;   // default: 100
  ebayMinSellerPositivePercent: number; // default: 98
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
  | 'payments.budget.dailyItem'
  | 'payments.budget.dailyOverage'
  | 'payments.budget.perPurchaseCeilingEnabled'
  | 'payments.budget.perPurchaseCeiling'
  | 'payments.budget.overageToleranceEnabled'
  | 'payments.budget.overageToleranceDailyAllowance'
  | 'payments.shipping.preferredTier'
  | 'payments.windows.vetoMinutes'
  | 'payments.windows.approvalMinutes'
  | 'payments.billingAddress.name'
  | 'payments.billingAddress.line1'
  | 'payments.billingAddress.line2'
  | 'payments.billingAddress.city'
  | 'payments.billingAddress.region'
  | 'payments.billingAddress.postalCode'
  | 'payments.billingAddress.country'
  | 'payments.shippingAddress.name'
  | 'payments.shippingAddress.line1'
  | 'payments.shippingAddress.line2'
  | 'payments.shippingAddress.city'
  | 'payments.shippingAddress.region'
  | 'payments.shippingAddress.postalCode'
  | 'payments.shippingAddress.country'
  | 'payments.majorRetailersAdditional'
  | 'payments.majorRetailersExcluded'
  | 'payments.ebayMinSellerFeedbackCount'
  | 'payments.ebayMinSellerPositivePercent'
  | 'payments.notifyChannels';

/** The value type each payments key carries, for `ConfigValue<K>`. */
export interface PaymentsConfigValueMap {
  'payments.enabled': boolean;
  'payments.defaultCardId': string;
  'payments.currency': string;
  'payments.cvvHandling': CvvHandling;
  'payments.budget.dailyItem': number;
  'payments.budget.dailyOverage': number;
  'payments.budget.perPurchaseCeilingEnabled': boolean;
  'payments.budget.perPurchaseCeiling': number;
  'payments.budget.overageToleranceEnabled': boolean;
  'payments.budget.overageToleranceDailyAllowance': number;
  'payments.shipping.preferredTier': ShippingTierPreference;
  'payments.windows.vetoMinutes': number;
  'payments.windows.approvalMinutes': number;
  'payments.billingAddress.name': string;
  'payments.billingAddress.line1': string;
  'payments.billingAddress.line2': string;
  'payments.billingAddress.city': string;
  'payments.billingAddress.region': string;
  'payments.billingAddress.postalCode': string;
  'payments.billingAddress.country': string;
  'payments.shippingAddress.name': string;
  'payments.shippingAddress.line1': string;
  'payments.shippingAddress.line2': string;
  'payments.shippingAddress.city': string;
  'payments.shippingAddress.region': string;
  'payments.shippingAddress.postalCode': string;
  'payments.shippingAddress.country': string;
  'payments.majorRetailersAdditional': string;
  'payments.majorRetailersExcluded': string;
  'payments.ebayMinSellerFeedbackCount': number;
  'payments.ebayMinSellerPositivePercent': number;
  'payments.notifyChannels': string;
}
