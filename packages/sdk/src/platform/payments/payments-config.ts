/**
 * payments-config.ts — the daemon's live settings, read at the moment of use.
 *
 * ══ Why this is a function and not a captured object ══════════════════════
 *
 * `PaymentsServiceDeps.config` is called once per purchase, not once at
 * construction, and that is deliberate. A budget the owner raised five minutes
 * ago has to apply to the purchase happening now; a timezone he corrected has
 * to move the daily reset before the next order, not after a restart. Capturing
 * these at startup would mean the settings UI wrote values that quietly did
 * nothing until the daemon was bounced — which is the failure that makes a
 * settings screen untrustworthy.
 *
 * So every field below is read through `configManager.get` on each call.
 *
 * ══ The timezone comes from config, which the profile feeds ═══════════════
 *
 * `daemon.timezone` is the key, and it is not a second source of truth: the
 * owner profile maps `location.timezone` onto it (owner-profile/consumers.ts),
 * so setting his location updates the key this reads. Reading the KEY rather
 * than reaching into the profile keeps one consumer and means a machine with no
 * profile still has a working daily reset.
 *
 * Unset resolves to UTC, matching `resolveTimezone` in day.ts. A daily budget
 * needs a definite day boundary, and refusing to have one would be worse than
 * picking the one everything else already defaults to.
 *
 * ══ Cents in config, minor units in code ══════════════════════════════════
 *
 * The config keys are named `...Cents` because that is what the owner types.
 * Everything past this module is `MinorUnits`, which for a two-decimal currency
 * is the same integer and for JPY or BHD is not. The conversion happens here,
 * once, so no other module has to know which of the two it is holding.
 */
import { minorUnitExponent } from './money-parsing.js';
import { merchantPolicyFromConfig, type MerchantPolicy } from './merchant-recourse.js';
import { parseCurrencyCode, type CurrencyCode, type ShippingTier } from './types.js';
import type { BudgetLimits } from './budget.js';
import type { PaymentsServiceConfig } from './payments-gateway-service.js';

/** The narrow slice of the config manager this needs. Injectable for tests. */
export interface PaymentsConfigReader {
  get(key: string): unknown;
}

function readString(config: PaymentsConfigReader, key: string, fallback: string): string {
  const value = config.get(key);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function readInteger(config: PaymentsConfigReader, key: string, fallback: number): number {
  const value = config.get(key);
  // A non-integer or negative setting is treated as absent rather than coerced.
  // Rounding someone's budget silently is how a limit stops meaning what the
  // person who typed it believes it means.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function readBoolean(config: PaymentsConfigReader, key: string, fallback: boolean): boolean {
  const value = config.get(key);
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Convert a cents-denominated setting into this currency's minor units.
 *
 * For USD, EUR, GBP and most others this is the identity. For JPY (no minor
 * unit) 500 "cents" is 5 yen, and for BHD (three decimals) it is 5000 fils.
 * Getting this wrong is a factor-of-ten or -hundred error on a spending limit,
 * so it is done in one place with the exponent table the parser and the
 * renderer already share.
 */
function centsToMinorUnits(cents: number, currency: string): number {
  const exponent = minorUnitExponent(currency);
  if (exponent === 2) return cents;
  return Math.round((cents / 100) * 10 ** exponent);
}

/** `payments.shipping.preferredTier`, defaulting to the cheapest rung. */
function readTier(config: PaymentsConfigReader): ShippingTier {
  const raw = readString(config, 'payments.shipping.preferredTier', 'normal').toLowerCase();
  return raw === 'fast' || raw === 'fastest' ? raw : 'normal';
}

/**
 * Whether the CVV is stored, which decides whether purchasing can be
 * unattended at all.
 *
 * `'prompt'` means every purchase stops and waits for a human to type it — the
 * veto window still runs, but nothing completes while he is away. Exposed here
 * so the daemon can report that honestly rather than a purchase mysteriously
 * hanging.
 */
export function readCvvHandling(config: PaymentsConfigReader): 'stored' | 'prompt' {
  return readString(config, 'payments.cvvHandling', 'stored') === 'prompt' ? 'prompt' : 'stored';
}

/** `payments.enabled` and the configured card, for the terminal gates. */
export function readPaymentsEnabled(config: PaymentsConfigReader): boolean {
  return readBoolean(config, 'payments.enabled', false);
}

export function readDefaultCardId(config: PaymentsConfigReader): string {
  return readString(config, 'payments.defaultCardId', '');
}

/** The channels a payment notice is delivered to. */
export function readNotifyChannels(config: PaymentsConfigReader): readonly string[] {
  const raw = readString(config, 'payments.notifyChannels', '');
  return raw.split(',').map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
}

/**
 * The budgets, in this currency's minor units.
 *
 * Defaults are all zero and all off. A daemon that has never been configured
 * refuses every purchase with "the daily item budget is 0" rather than
 * inheriting a number nobody chose — see `decidePurchase`, which treats a zero
 * item budget as a terminal refusal.
 */
export function readBudgetLimits(config: PaymentsConfigReader, currency: string): BudgetLimits {
  return {
    dailyItemMinorUnits: centsToMinorUnits(readInteger(config, 'payments.budget.dailyItemCents', 0), currency),
    dailyOverageMinorUnits: centsToMinorUnits(readInteger(config, 'payments.budget.dailyOverageCents', 0), currency),
    perPurchaseCeiling: {
      // ON by default: the owner's "default to most safe, the user can change
      // affirmatively" ruling. A ceiling that defaults off is a ceiling nobody
      // notices is missing.
      enabled: readBoolean(config, 'payments.budget.perPurchaseCeilingEnabled', true),
      minorUnits: centsToMinorUnits(readInteger(config, 'payments.budget.perPurchaseCeilingCents', 0), currency),
    },
    overageTolerance: {
      // OFF by default, with a zero allowance, so enabling it without setting
      // an amount changes nothing.
      enabled: readBoolean(config, 'payments.budget.overageToleranceEnabled', false),
      dailyAllowanceMinorUnits: centsToMinorUnits(
        readInteger(config, 'payments.budget.overageToleranceDailyAllowanceCents', 0),
        currency,
      ),
    },
  };
}

/**
 * Build the whole service configuration from live config.
 *
 * Called per purchase. Nothing here is cached, and nothing here throws: an
 * unreadable setting falls back to the safe default rather than taking down a
 * purchase with a type error, because the budget check downstream is a better
 * place to stop than a crash in a config reader.
 */
export function readPaymentsServiceConfig(config: PaymentsConfigReader): PaymentsServiceConfig {
  const currencyRaw = readString(config, 'payments.currency', 'USD');
  const currency = parseCurrencyCode(currencyRaw) ?? (parseCurrencyCode('USD') as CurrencyCode);

  return {
    limits: readBudgetLimits(config, currency),
    budgetCurrency: currency,
    // Unset resolves to UTC, matching day.ts. The owner profile maps
    // location.timezone onto this key, so his location drives the daily reset.
    timezone: readString(config, 'daemon.timezone', 'UTC'),
    preferredTier: readTier(config),
    // An hour survives a meeting; denial is the recoverable outcome, so
    // too-short costs friction and too-long holds a cart against a drifting
    // price.
    approvalMinutes: readInteger(config, 'payments.windows.approvalMinutes', 60),
    // His number: "say 10 minutes, to say so".
    vetoMinutes: readInteger(config, 'payments.windows.vetoMinutes', 10),
  };
}

/**
 * The owner's merchant overrides, which win in both directions.
 *
 * An excluded domain is never major however the judge answers, and an included
 * one is major without asking. Both are owner-authored, which is what makes
 * them safe to let override a judgement.
 */
export function readMerchantPolicy(config: PaymentsConfigReader): MerchantPolicy {
  return merchantPolicyFromConfig({
    majorRetailersAdditional: readString(config, 'payments.majorRetailersAdditional', ''),
    majorRetailersExcluded: readString(config, 'payments.majorRetailersExcluded', ''),
    ebayMinSellerFeedbackCount: readInteger(config, 'payments.ebayMinSellerFeedbackCount', 0),
    ebayMinSellerPositivePercent: readInteger(config, 'payments.ebayMinSellerPositivePercent', 0),
  });
}
