/**
 * consumers.ts — every place that used to hold or guess a fact about the owner,
 * reading it from here instead.
 *
 * docs/owner-profile.md §13. One declared map from a CONSUMER CONFIG KEY to a
 * profile field, installed as a read fallback in `ConfigManager`. Not a set of
 * call-site edits, for two reasons that are both about not breaking things:
 *
 *  - **Direction.** An explicitly configured value still wins; the profile fills
 *    only the gap where the key is unset. A profile that overrode a value the
 *    owner deliberately configured would be the drift class this design removes,
 *    running backwards.
 *  - **Contention.** The payments capability and `daemon.timezone` live on an
 *    unmerged branch a live round owns. A map keyed by config path wires those
 *    consumers the moment their keys exist, with no change to their code and no
 *    edit to a file another round is holding. Rows for keys absent from today's
 *    schema are inert and cost nothing — `ConfigManager.get()` never reaches the
 *    fallback for a key whose section does not exist, because `resolvePath()`
 *    throws first, and {@link profileFallbackStatus} catches that throw so a
 *    report over the map cannot fail on the same rows.
 *
 * ## Where the fallback applies
 *
 * `ConfigManager.get()` only. Never a bulk listing, category read, dump or
 * export — see `config/profile-fallback.ts` for the rule and the reasoning:
 * a config dump resolving through the profile would hand a caller
 * `commerce.shippingAddress` when it asked for "the settings", without ever
 * passing the closed-tier disclosure rule.
 *
 * ## Deliberately NOT wired: `security/owner-identity.ts`
 *
 * `resolveOwnerAddresses()` decides which addresses count as "the owner's own",
 * and that set gates the single exemption to the content-taint rule. Its own
 * module header says the exemption is safe precisely because spoofing it needs
 * an authenticated write to daemon config — a strictly stronger capability than
 * sending mail. A profile written autonomously from conversation is a WEAKER
 * input than daemon config, so feeding it into that gate would lower a bar the
 * module documents as high. Recorded here as a decision, not an oversight.
 */
import { registerProfileRedactionValues } from '../utils/redaction.js';
import { registerOpenTierContextBlock, renderOpenTierBlock } from './context-block.js';
import { registerSignupBaseAddressFallback } from '../google/account-registry.js';
import { canonicalProfileSection, profileFieldById, PROFILE_FIELDS } from './fields.js';
import type { OwnerProfileStore } from './store.js';

/**
 * One declared consumer wiring: which config key falls back to which profile
 * field, and — for a structured destination — which part of that value.
 */
export interface ConsumerFallbackRow {
  /** The consumer's config dot-path, e.g. `checkin.quietHours`. */
  readonly configKey: string;
  /** The profile field id it falls back to, e.g. `contactMe.quietHours`. */
  readonly fieldId: string;
  /**
   * For a config key that holds one PART of a postal address, which part.
   * Absent means the whole field value is the value.
   */
  readonly addressPart?: PostalAddressPart | undefined;
  /** Why this row exists, in the words of §13's table. */
  readonly note: string;
}

/** The seven parts a structured postal address is decomposed into. */
export type PostalAddressPart =
  | 'name'
  | 'line1'
  | 'line2'
  | 'city'
  | 'region'
  | 'postalCode'
  | 'country';

const POSTAL_ADDRESS_PARTS: readonly PostalAddressPart[] = [
  'name',
  'line1',
  'line2',
  'city',
  'region',
  'postalCode',
  'country',
];

/** The address rows for one `payments.<which>Address.*` group. */
function postalAddressRows(configPrefix: string, fieldId: string, note: string): ConsumerFallbackRow[] {
  return POSTAL_ADDRESS_PARTS.map((addressPart) => ({
    configKey: `${configPrefix}.${addressPart}`,
    fieldId,
    addressPart,
    note,
  }));
}

const PAYMENTS_NOTE =
  'on the unmerged payments branch; the row is declared now so the wiring exists the moment the key does, with no edit to that branch from here';

/**
 * The whole map, exactly §13.1's table.
 *
 * Rows whose config key does not exist on this branch are inert: nothing calls
 * `get()` for a key that is not in the schema, so the row simply never fires.
 */
export const CONSUMER_FALLBACKS: readonly ConsumerFallbackRow[] = [
  {
    configKey: 'checkin.quietHours',
    fieldId: 'contactMe.quietHours',
    note: 'the hours he does not want to be pinged are a fact about him, not a property of the check-in feature',
  },
  {
    configKey: 'checkin.deliveryChannel',
    fieldId: 'contactMe.channel',
    note: 'how he prefers to be reached is the same fact whether a check-in, an alert or a question is doing the reaching',
  },
  {
    configKey: 'daemon.timezone',
    fieldId: 'location.timezone',
    note: PAYMENTS_NOTE,
  },
  {
    configKey: 'payments.currency',
    fieldId: 'commerce.currency',
    note: PAYMENTS_NOTE,
  },
  ...postalAddressRows('payments.billingAddress', 'commerce.billingAddress', PAYMENTS_NOTE),
  ...postalAddressRows('payments.shippingAddress', 'commerce.shippingAddress', PAYMENTS_NOTE),
];

const ROW_BY_CONFIG_KEY = new Map(CONSUMER_FALLBACKS.map((row) => [row.configKey, row]));

// ---------------------------------------------------------------------------
// Postal address decomposition
// ---------------------------------------------------------------------------

/**
 * Split a one-line address into its parts, best-effort, by comma.
 *
 * `200 Office Way, Lansing, MI 48933, US` → line1 / city / region+postalCode /
 * country. A shape this cannot read confidently yields `undefined` for the
 * parts it could not determine, and an undefined part means the consumer key
 * stays unset and falls back exactly as before. That is the correct failure
 * direction for an address: a key left unset is visible and fixable, while a
 * confidently-wrong `region` is a parcel delivered to the wrong state.
 *
 * `name` is never inferred — a profile line holds an address, not an addressee,
 * and guessing a recipient name out of a street line would be invention.
 */
export function splitPostalAddress(value: string): Partial<Record<PostalAddressPart, string>> {
  const parts = value.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length < 3) return {};

  const country = parts[parts.length - 1]!;
  const regionAndPostal = parts[parts.length - 2]!;
  const city = parts[parts.length - 3]!;
  const streetLines = parts.slice(0, Math.max(0, parts.length - 3));

  // `MI 48933`, a bare `48933`, or a region with no postal code at all. The
  // trailing token becomes the postal code only when it actually looks like
  // one — carries a digit and is postal-code shaped — so `Nordrhein Westfalen`
  // stays one region rather than losing its last word to a postal field.
  const tokens = regionAndPostal.split(/\s+/).filter((token) => token.length > 0);
  const last = tokens[tokens.length - 1] ?? '';
  const postalShaped = /\d/.test(last) && /^[A-Za-z0-9][A-Za-z0-9-]{2,9}$/.test(last);
  const region = postalShaped ? tokens.slice(0, -1).join(' ') : regionAndPostal;
  const postalCode = postalShaped ? last : '';

  const result: Partial<Record<PostalAddressPart, string>> = { country, city };
  if (region.length > 0) result.region = region;
  if (postalCode.length > 0) result.postalCode = postalCode;
  if (streetLines[0] !== undefined) result.line1 = streetLines[0];
  if (streetLines.length > 1) result.line2 = streetLines.slice(1).join(', ');
  return result;
}

// ---------------------------------------------------------------------------
// The reader ConfigManager holds
// ---------------------------------------------------------------------------

/** The store reads the resolver needs. */
export type ConsumerProfileSource = Pick<OwnerProfileStore, 'get' | 'read' | 'section' | 'status'>;

/** Whether the fallback is switched on right now (`profile.consumerFallback`). */
export type FallbackEnabledPredicate = () => boolean;

/**
 * The reader installed into `ConfigManager.attachProfileFallback`.
 *
 * Answers `undefined` for everything it has no declared row for, for a field
 * the owner has not recorded, and for a value the parser marked invalid — §4.3
 * says an invalid mechanical value's consumer falls back exactly as if the
 * field were unset, and this is the place that promise is kept.
 */
export function createConsumerFallbackReader(
  source: ConsumerProfileSource,
  isEnabled: FallbackEnabledPredicate,
): (key: string) => unknown {
  return (key: string): unknown => {
    if (!isEnabled()) return undefined;
    const row = ROW_BY_CONFIG_KEY.get(key);
    if (row === undefined) return undefined;
    const field = source.get(row.fieldId);
    if (field === undefined || !field.valid) return undefined;
    const value = field.value.trim();
    if (value.length === 0) return undefined;
    if (row.addressPart === undefined) return value;
    const part = splitPostalAddress(value)[row.addressPart];
    return part === undefined || part.length === 0 ? undefined : part;
  };
}

/** One row's live state, for a settings surface that wants to show provenance. */
export interface ConsumerFallbackStatus {
  readonly configKey: string;
  readonly fieldId: string;
  /** True when the config key exists in this build's schema at all. */
  readonly keyExists: boolean;
  /** True when the key is unset AND the profile has something for it. */
  readonly resolvesFromProfile: boolean;
}

/**
 * Report which consumer keys currently resolve from the profile.
 *
 * §13.1: a listing may show THAT a key resolves from the profile; it does not
 * show the value, and nothing here returns one. The `get` call is wrapped
 * because `ConfigManager.resolvePath()` throws for a section that does not
 * exist, which is exactly the state of every `payments.*` row on this branch —
 * a report that threw on them would be a report nobody could run.
 */
export function profileFallbackStatus(
  source: ConsumerProfileSource,
  get: (key: string) => unknown,
): readonly ConsumerFallbackStatus[] {
  const reader = createConsumerFallbackReader(source, () => true);
  return CONSUMER_FALLBACKS.map((row) => {
    let keyExists = true;
    try {
      get(row.configKey);
    } catch {
      keyExists = false;
    }
    return {
      configKey: row.configKey,
      fieldId: row.fieldId,
      keyExists,
      resolvesFromProfile: keyExists && reader(row.configKey) !== undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Containment: what redaction must never let out
// ---------------------------------------------------------------------------

/**
 * The closed-tier strings a redactor should recognise.
 *
 * Two groups, and the boundary between them is deliberate:
 *
 *  - Every closed-tier MECHANICAL FIELD value — §11.3's "closed-tier values".
 *  - The prose of the four sections §11.2 names as closed in their entirety:
 *    `People`, `Places`, `Work`, `Notes`. `People` in particular holds facts
 *    about people who never agreed to be in a database, and §10 bars that from
 *    logs, exports, diagnostics and telemetry outright.
 *
 * What is NOT included: prose under a heading the owner invented. Those lines
 * are ordinary sentences of his, and turning "the build is broken" into a
 * global redaction pattern would blank that phrase out of unrelated logs — an
 * over-redaction that destroys the diagnostic the export exists to carry, and
 * does it silently. The registered reader in `utils/redaction.ts` applies its
 * own length and distinctiveness floor on top of this list.
 */
const CLOSED_PROSE_SECTIONS = new Set(['People', 'Places', 'Work', 'Notes']);

export function closedTierRedactionValues(source: ConsumerProfileSource): readonly string[] {
  const document = source.read();
  if (document.state.kind !== 'loaded') return [];
  const values: string[] = [];
  for (const field of PROFILE_FIELDS) {
    if (field.tier !== 'closed') continue;
    const value = source.get(field.id);
    if (value !== undefined && value.value.trim().length > 0) values.push(value.value.trim());
  }
  // Through `read()`, not `section()`: the store's generic section accessor
  // refuses the closed tier on purpose, so that no consumer assembling
  // something can enumerate `People`. Redaction is the opposite kind of caller —
  // it is deciding what must NOT leave — and `read()` is the disclosure path
  // that returns the whole document.
  for (const section of document.sections) {
    const canonical = canonicalProfileSection(section.heading);
    if (canonical === null || !CLOSED_PROSE_SECTIONS.has(canonical)) continue;
    for (const line of section.prose) {
      const text = line.text.replace(/^\s*[-*+]\s+/, '').trim();
      if (text.length > 0) values.push(text);
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/** The seams a live profile is plugged into. All injectable, none imported back. */
export interface OwnerProfileConsumerHost {
  /** `ConfigManager.attachProfileFallback`. */
  readonly attachProfileFallback: (reader: ((key: string) => unknown) | null) => void;
  /** Reads `profile.consumerFallback`, live, so the toggle is not a restart. */
  readonly consumerFallbackEnabled: FallbackEnabledPredicate;
  /** Reads `profile.injectOpenTier`, live, for the same reason. */
  readonly injectOpenTierEnabled: FallbackEnabledPredicate;
}

/**
 * Plug a loaded profile into every consumer seam, and return the undo.
 *
 * Four registrations, all reader-shaped so no consumer module gains an import
 * of this one: the `ConfigManager.get()` fallback, the redaction value source,
 * the signup base address, and the open-tier context block. Calling the returned
 * function clears all four, which is what a disposal scope needs in order to tear
 * a daemon down without leaving a dead closure holding the owner's addresses.
 *
 * Both live toggles are read through predicates rather than snapshotted, so
 * `profile.consumerFallback` and `profile.injectOpenTier` take effect on the
 * next read instead of on the next restart — they ship as real settings, and a
 * setting that needs a restart to mean anything is not one.
 */
export function installOwnerProfileConsumers(
  source: ConsumerProfileSource,
  host: OwnerProfileConsumerHost,
): () => void {
  host.attachProfileFallback(createConsumerFallbackReader(source, host.consumerFallbackEnabled));
  registerProfileRedactionValues(() => closedTierRedactionValues(source));
  registerSignupBaseAddressFallback(() => {
    const email = source.get('contact.email');
    return email !== undefined && email.valid && email.value.trim().length > 0
      ? email.value.trim()
      : undefined;
  });
  registerOpenTierContextBlock(() => (
    host.injectOpenTierEnabled() ? renderOpenTierBlock(source) : ''
  ));
  return (): void => {
    host.attachProfileFallback(null);
    registerProfileRedactionValues(null);
    registerSignupBaseAddressFallback(null);
    registerOpenTierContextBlock(null);
  };
}

/** Re-exported so a caller holding a config key can name its field in one import. */
export { profileFieldById };
