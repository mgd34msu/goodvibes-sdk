/**
 * address.ts, the address on the order is the one he stored.
 *
 * ══ The defect this closes ════════════════════════════════════════════════
 *
 * The profile stores a shipping and a billing address and maps them into
 * config, and nothing in the checkout path read either. The card got typed into
 * the page and the delivery address did not, which made the profile
 * write-only for the exact purpose it was built for, the same shape of defect
 * as a card store nothing could read.
 *
 * ══ Why the DAEMON supplies the value ═════════════════════════════════════
 *
 * Not for concealment. An address is not a PAN and there is nothing to hide
 * from the model here, it is about the value being AUTHORITATIVE rather than
 * recalled. A model retyping a postcode from its memory of a conversation three
 * turns ago is a model that can drop a digit, and the failure is silent: the
 * order goes through, the notice looks right, and a parcel goes to a house
 * number that does not exist.
 *
 * So the split is the same as the card's: the model identifies which field on
 * the page wants what, and the daemon supplies every character.
 *
 * ══ Missing is a refusal, never a guess ═══════════════════════════════════
 *
 * No stored shipping address means stop and say which field is missing and how
 * to set it. Not: infer one from a previous order, from the billing address,
 * from a channel message, or from anything on the page. A half-filled address
 * form is worse than a refusal, because it can succeed.
 *
 * ══ Billing is INDEPENDENT of shipping ════════════════════════════════════
 *
 * There is no `payments.billingSameAsShipping` setting in the schema, checked,
 * not assumed. Absent an explicit instruction from the owner that they are the
 * same, they are two addresses, and a checkout asking for both requires both to
 * be stored. Defaulting billing to shipping would be this module inventing a
 * preference he never expressed, and on a card payment a wrong billing address
 * is a declined transaction at best and a fraud flag at worst.
 */
import { sanitizeOwnerNoticeField } from '../security/notice-text.js';
import type { PostalAddress } from './types.js';

export type AddressKind = 'shipping' | 'billing';

export type AddressFieldName =
  | 'name'
  | 'line1'
  | 'line2'
  | 'city'
  | 'region'
  | 'postalCode'
  | 'country';

/**
 * Every field except `line2`, which is genuinely optional, plenty of addresses
 * have no second line, and requiring one would refuse a valid address.
 */
const REQUIRED_FIELDS: readonly AddressFieldName[] = [
  'name',
  'line1',
  'city',
  'region',
  'postalCode',
  'country',
];

/** Where one address field goes on the page the model is looking at. */
export interface AddressFieldTarget {
  readonly kind: AddressKind;
  readonly field: AddressFieldName;
  /** Opaque to this module: a snapshot ref, resolved by the driver. */
  readonly target: string;
}

/**
 * The daemon's read path to the stored addresses.
 *
 * A port for the same reason `CardMaterialStore` is one: the checkout flow must
 * be drivable end to end without a config tree, and the assertion that the
 * order carries the STORED value needs a store a test can control.
 */
export interface AddressStore {
  read(kind: AddressKind): Promise<PostalAddress | null>;
}

export interface AddressCheck {
  readonly ok: boolean;
  readonly missing: readonly AddressFieldName[];
  readonly reason: string | null;
}

/** One field's stored value. `line2` is the only one allowed to be empty. */
export function addressFieldValue(address: PostalAddress, field: AddressFieldName): string {
  return address[field] ?? '';
}

/**
 * Whether a stored address is complete enough to put on an order.
 *
 * Names every missing field rather than the first, so one refusal tells him
 * everything he has to go and set.
 */
export function checkAddress(address: PostalAddress | null, kind: AddressKind): AddressCheck {
  if (address === null) {
    return {
      ok: false,
      missing: [...REQUIRED_FIELDS],
      reason:
        `Refused: no ${kind} address is stored, so I have nowhere to send this. `
        + `Set it in the TUI, the agent or the webui under payments.${kind}Address before asking me to buy something.`,
    };
  }
  const missing = REQUIRED_FIELDS.filter((field) => addressFieldValue(address, field).trim().length === 0);
  if (missing.length === 0) return { ok: true, missing: [], reason: null };
  return {
    ok: false,
    missing,
    reason:
      `Refused: the stored ${kind} address is missing ${missing.join(', ')}. `
      + 'I will not guess at an address or fill part of one, set the missing fields and ask me again.',
  };
}

export interface AddressFillDeps {
  readonly store: AddressStore;
  readonly fill: (target: string, value: string) => Promise<void>;
}

export interface AddressFillResult {
  readonly ok: boolean;
  readonly filled: number;
  readonly failedField: string | null;
  readonly reason: string | null;
}

/**
 * Put the stored addresses on the page.
 *
 * Every kind the targets mention is read and checked BEFORE anything is typed,
 * so a checkout wanting both addresses with only one stored refuses without
 * having half-filled the form.
 */
export async function fillAddresses(
  targets: readonly AddressFieldTarget[],
  deps: AddressFillDeps,
): Promise<AddressFillResult> {
  const kinds = [...new Set(targets.map((entry) => entry.kind))];
  const resolved = new Map<AddressKind, PostalAddress>();

  for (const kind of kinds) {
    const address = await deps.store.read(kind);
    const check = checkAddress(address, kind);
    if (!check.ok || address === null) {
      return { ok: false, filled: 0, failedField: `${kind}.${check.missing[0] ?? 'address'}`, reason: check.reason };
    }
    resolved.set(kind, address);
  }

  let filled = 0;
  for (const entry of targets) {
    const address = resolved.get(entry.kind);
    if (address === undefined) continue;
    const value = addressFieldValue(address, entry.field);
    // line2 is the one field allowed to be empty, and an empty fill would
    // clear whatever the page had rather than leaving it alone.
    if (value.trim().length === 0 && entry.field === 'line2') continue;
    try {
      await deps.fill(entry.target, value);
    } catch {
      return {
        ok: false,
        filled,
        failedField: `${entry.kind}.${entry.field}`,
        reason: `The ${entry.kind} ${entry.field} field could not be filled on this checkout.`,
      };
    }
    filled += 1;
  }
  return { ok: true, filled, failedField: null, reason: null };
}

/**
 * The destination, for the message he is being asked to veto.
 *
 * He should be able to see WHERE it is going in the notice, not only what it
 * costs, a correct total to the wrong address is still a wrong order, and this
 * is the last point at which he can catch it.
 *
 * Rendered from the STORED value and sanitized like every other notice field.
 * The address is his own text, so it goes through the owner-field sanitize
 * which keeps underscores, but it is still neutralised rather than trusted:
 * a guarantee that holds only while every call site threads provenance
 * correctly is not a guarantee.
 */
export function renderDestination(address: PostalAddress | null): string | null {
  if (address === null) return null;
  const parts = [
    addressFieldValue(address, 'name'),
    addressFieldValue(address, 'line1'),
    addressFieldValue(address, 'city'),
    addressFieldValue(address, 'region'),
    addressFieldValue(address, 'postalCode'),
    addressFieldValue(address, 'country'),
  ].filter((part) => part.trim().length > 0);
  if (parts.length === 0) return null;
  return sanitizeOwnerNoticeField(parts.join(', '), 160);
}
