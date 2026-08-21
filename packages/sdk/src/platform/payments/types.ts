/**
 * types.ts, the vocabulary of the payment capability.
 *
 * Two things in here are load-bearing rather than descriptive, and both exist to
 * make a class of mistake impossible instead of merely discouraged:
 *
 *  - `OwnerSuppliedText` is a branded string that can only be constructed from
 *    an owner-direct turn. Every human-readable field that reaches an approval
 *    or veto message is typed as one, so assigning text that came off a merchant
 *    page is a COMPILE error rather than a review finding. See docs/payments.md
 *    §9.3 for what goes wrong without it: an attacker who can write page text
 *    can otherwise write what the owner reads on his phone.
 *
 *  - `CommandAuthorityChannel` has no `'email'` member. Approval and veto answers
 *    arrive over the TUI, the agent terminal, or a channel like Telegram, and
 *    never over email, permanently. Expressing that as a union means routing a
 *    payment prompt to email does not typecheck.
 *
 * Money is integer minor units everywhere. There is no floating-point arithmetic
 * anywhere in this capability; `0.1 + 0.2` is the wrong tool for a budget.
 */

/** Money, in the currency's smallest unit. Always an integer. */
export type MinorUnits = number;

/** ISO-4217 alphabetic code, validated on the way in. */
export type CurrencyCode = string & { readonly __currency: unique symbol };

const ISO_4217 = /^[A-Z]{3}$/;

export function parseCurrencyCode(raw: string): CurrencyCode | null {
  const upper = raw.trim().toUpperCase();
  return ISO_4217.test(upper) ? (upper as CurrencyCode) : null;
}

declare const OWNER_TEXT: unique symbol;

/**
 * Text the OWNER wrote, as opposed to text a page or a message wrote.
 *
 * Deliberately unconstructible from a plain string: the only factory checks the
 * authority surface. A merchant page's product title cannot become one of these
 * no matter how convenient that would be at the call site.
 */
export type OwnerSuppliedText = string & { readonly [OWNER_TEXT]: 'owner-direct' };

/**
 * Build owner text, or refuse.
 *
 * Returns null for any surface other than `owner-direct`, so a caller that
 * threads through the wrong provenance gets a null it has to handle rather than
 * a value it can render.
 */
export function ownerSuppliedText(value: string, surface: string): OwnerSuppliedText | null {
  if (surface !== 'owner-direct') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed as OwnerSuppliedText;
}

/** Test seam. Named so it cannot be mistaken for the production factory. */
export function unsafeOwnerSuppliedTextForTests(value: string): OwnerSuppliedText {
  return value as OwnerSuppliedText;
}

/**
 * Surfaces that may deliver a payment prompt and accept its answer.
 *
 * Email is not a member and must never become one. It is already structurally
 * absent from the platform, not a `ChannelSurface`, not a `SurfaceKind`, no
 * delivery strategy, and this union is the second lock. See docs/payments.md
 * §8.2.
 */
export type CommandAuthorityChannel = 'tui' | 'agent-terminal' | 'telegram';

const COMMAND_AUTHORITY_CHANNELS: readonly string[] = ['tui', 'agent-terminal', 'telegram'];

/**
 * Parse a configured channel name, rejecting anything unknown.
 *
 * Rejects rather than ignores: a config that names a channel we do not
 * understand is a config the owner believes will reach him, and silently
 * dropping it produces an undeliverable prompt he was never told about.
 */
export function parseCommandAuthorityChannel(raw: string): CommandAuthorityChannel | null {
  const value = raw.trim().toLowerCase();
  return COMMAND_AUTHORITY_CHANNELS.includes(value) ? (value as CommandAuthorityChannel) : null;
}

/** Ordinal against what the checkout actually offers, never a delivery-day promise. */
export type ShippingTier = 'normal' | 'fast' | 'fastest';

export const SHIPPING_TIERS: readonly ShippingTier[] = ['normal', 'fast', 'fastest'];

/** One delivery option as the checkout presented it. */
export interface ShippingOption {
  /** The checkout's own label, retained for the audit record only, never rendered in a prompt. */
  readonly rawLabel: string;
  readonly costMinorUnits: MinorUnits;
}

export interface ShippingStepDown {
  readonly from: ShippingTier;
  readonly to: ShippingTier;
  readonly savedMinorUnits: MinorUnits;
  readonly reason: 'overage-pool-insufficient';
}

/** A card, as everything outside the secret store sees it. */
export interface CardMetadata {
  readonly id: string;
  readonly label: string;
  readonly brand: string;
  readonly last4: string;
  readonly kind: 'virtual' | 'real';
  readonly expiryMonth: number;
  readonly expiryYear: number;
  /** Declared by the owner, unverifiable by us. Never treated as enforcement. */
  readonly issuerCapMinorUnits: MinorUnits | null;
  readonly addedAt: string;
}

export interface PostalAddress {
  readonly name: string;
  readonly line1: string;
  readonly line2: string;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly country: string;
}

/** Which pool a draw came out of. */
export type BudgetPool = 'item' | 'overage' | 'tolerance';

/** Every way this capability can say no, each with its own name. */
export type RefusalCode =
  | 'disabled'
  | 'no-card'
  | 'no-shipping-address'
  | 'not-owner-request'
  | 'derived-from-untrusted-content'
  | 'link-validation-failed'
  | 'currency-mismatch'
  | 'recurring-charge'
  | 'item-budget-exceeded-undeliverable'
  | 'item-budget-exceeded-denied'
  | 'item-budget-exceeded-expired'
  | 'per-purchase-ceiling-exceeded'
  | 'overage-pool-exhausted'
  | 'zero-budget'
  | 'total-changed'
  | 'challenge-abandoned'
  | 'cart-mismatch';
