/**
 * fields.ts, the mechanical field registry.
 *
 * These are the ONLY lines parsed into typed values (docs/owner-profile.md §4.3).
 * Everything else in the document is prose: preserved verbatim, served as prose.
 * `People` and `Places` have no mechanical fields at all, the owner asked for
 * notes, and notes are what they are.
 *
 * A validator NEVER rejects a line. It answers "does this value look like what
 * it claims to be", and a `false` answer is recorded alongside the value with a
 * reason. Deleting or rewriting a line because the parser disliked it would be
 * the worst possible behaviour in a file the owner owns.
 */
import type { ProfileTier } from './types.js';

/** The canonical section headings, in document order. */
export const PROFILE_SECTIONS = [
  'Identity',
  'Contact',
  'Location',
  'Commerce',
  'Preferences',
  'Contacting me',
  'Style',
  'Defaults',
  'People',
  'Places',
  'Work',
  'Important dates',
  'Plans',
  'Notes',
] as const;

export type ProfileSectionName = (typeof PROFILE_SECTIONS)[number];

/**
 * Sections that hold notes rather than records. An autonomous write into one of
 * these appends a bullet; nothing turns them into records.
 *
 * `Important dates` and `Plans` are here for a reason worth stating, because at
 * a glance they look like the most record-shaped sections in the document. A
 * birthday is a REPEATED record and the field registry maps one section-plus-
 * label to one value, it can hold `commerce.shippingAddress` and cannot hold
 * twenty birthdays. So each occasion is a prose line, preserved verbatim by
 * this parser exactly like any other bullet, and typed by a reader layered on
 * top of it (`platform/occasions/grammar.ts`). The profile's guarantee that a
 * validator never rewrites a line he wrote survives unchanged, and a date line
 * this parser cannot make sense of is reported with a reason rather than
 * corrected.
 */
export const PROSE_ONLY_SECTIONS: readonly ProfileSectionName[] = [
  'Style',
  'People',
  'Places',
  'Work',
  'Important dates',
  'Plans',
  'Notes',
];

/** Field names and headings match case-insensitively with whitespace collapsed. */
export function normalizeProfileKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

const SECTION_BY_NORMALIZED = new Map<string, ProfileSectionName>(
  PROFILE_SECTIONS.map((name) => [normalizeProfileKey(name), name]),
);

/** The canonical section a heading names, or `null` when it is one of his own. */
export function canonicalProfileSection(heading: string): ProfileSectionName | null {
  return SECTION_BY_NORMALIZED.get(normalizeProfileKey(heading)) ?? null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A validator's answer. `reason` is present exactly when `valid` is false. */
export interface ProfileFieldValidation {
  readonly valid: boolean;
  readonly reason?: string | undefined;
}

export type ProfileFieldValidator = (value: string) => ProfileFieldValidation;

const VALID: ProfileFieldValidation = { valid: true };

function invalid(reason: string): ProfileFieldValidation {
  return { valid: false, reason };
}

/** Anything the owner typed is a valid string. */
const freeString: ProfileFieldValidator = () => VALID;

function oneOf(allowed: readonly string[]): ProfileFieldValidator {
  const set = new Set(allowed);
  return (value) =>
    set.has(value.trim().toLowerCase())
      ? VALID
      : invalid(`expected one of ${allowed.join(', ')}`);
}

function matching(pattern: RegExp, reason: string): ProfileFieldValidator {
  return (value) => (pattern.test(value.trim()) ? VALID : invalid(reason));
}

/**
 * `Intl.supportedValuesOf` is ES2022 and present on every runtime this platform
 * targets, but it is reached through a narrow structural type rather than a
 * `lib` assumption so a host missing it degrades to "cannot check" instead of
 * throwing while parsing the owner's file.
 */
interface IntlSupportedValues {
  readonly supportedValuesOf?: (key: string) => readonly string[];
}

let timeZoneSets: { readonly exact: Set<string>; readonly lower: Set<string> } | null = null;

function loadTimeZones(): { readonly exact: Set<string>; readonly lower: Set<string> } | null {
  if (timeZoneSets !== null) return timeZoneSets;
  const intl = Intl as unknown as IntlSupportedValues;
  if (typeof intl.supportedValuesOf !== 'function') return null;
  let zones: readonly string[];
  try {
    zones = intl.supportedValuesOf('timeZone');
  } catch {
    return null;
  }
  timeZoneSets = {
    exact: new Set(zones),
    lower: new Set(zones.map((zone) => zone.toLowerCase())),
  };
  return timeZoneSets;
}

/**
 * An IANA zone, checked against the runtime's own list.
 *
 * Case-insensitive as a second attempt: `america/detroit` is the owner typing
 * the right zone in the wrong case, and flagging it invalid would send him
 * looking for a mistake he did not make.
 */
const ianaTimeZone: ProfileFieldValidator = (value) => {
  const zones = loadTimeZones();
  if (zones === null) return VALID;
  const trimmed = value.trim();
  if (zones.exact.has(trimmed) || zones.lower.has(trimmed.toLowerCase())) return VALID;
  return invalid('not an IANA time zone name');
};

/** ISO-4217 is three letters; the code list itself is not shipped. */
const currencyCode = matching(/^[A-Za-z]{3}$/, 'expected a 3-letter ISO-4217 currency code');

/** BCP-47 shape: a language subtag plus any number of dash-joined subtags. */
const bcp47 = matching(
  /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
  'expected a BCP-47 language tag such as en-US',
);

const quietHoursRange = matching(
  /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/,
  'expected HH:MM-HH:MM',
);

/**
 * Address-SHAPED, not address-verified. The question is "did a line that claims
 * to be an email address get a value that looks like one"; deliverability is not
 * knowable here and pretending otherwise would produce confident wrong answers.
 */
const addressShaped = matching(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'expected an email address');

const integerMinutes = matching(/^\d+$/, 'expected a whole number of minutes');

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface ProfileFieldDef {
  /** Stable id used by every caller, e.g. `location.timezone`. */
  readonly id: string;
  readonly section: ProfileSectionName;
  /** The label written in the file, e.g. `shipping address`. */
  readonly label: string;
  /** Open tier is injectable as context; closed tier needs a named call. */
  readonly tier: ProfileTier;
  readonly validate: ProfileFieldValidator;
}

/**
 * Every mechanical field, with its tier from §11.2.
 *
 * `location.city` is open deliberately and `location.homeAddress` is closed: the
 * failure that prompted this work was an agent guessing a metro area, and a city
 * is not a doorstep.
 */
export const PROFILE_FIELDS: readonly ProfileFieldDef[] = [
  { id: 'identity.name', section: 'Identity', label: 'name', tier: 'closed', validate: freeString },
  { id: 'identity.goesBy', section: 'Identity', label: 'goes by', tier: 'open', validate: freeString },
  { id: 'identity.pronouns', section: 'Identity', label: 'pronouns', tier: 'open', validate: freeString },

  { id: 'contact.email', section: 'Contact', label: 'email', tier: 'closed', validate: addressShaped },
  { id: 'contact.phone', section: 'Contact', label: 'phone', tier: 'closed', validate: freeString },
  { id: 'contact.agentAlias', section: 'Contact', label: 'agent alias', tier: 'closed', validate: addressShaped },

  { id: 'location.timezone', section: 'Location', label: 'timezone', tier: 'open', validate: ianaTimeZone },
  { id: 'location.city', section: 'Location', label: 'city', tier: 'open', validate: freeString },
  { id: 'location.homeAddress', section: 'Location', label: 'home address', tier: 'closed', validate: freeString },

  { id: 'commerce.shippingAddress', section: 'Commerce', label: 'shipping address', tier: 'closed', validate: freeString },
  { id: 'commerce.billingAddress', section: 'Commerce', label: 'billing address', tier: 'closed', validate: freeString },
  { id: 'commerce.currency', section: 'Commerce', label: 'currency', tier: 'closed', validate: currencyCode },
  { id: 'commerce.shippingTier', section: 'Commerce', label: 'shipping tier', tier: 'closed', validate: freeString },

  { id: 'preferences.units', section: 'Preferences', label: 'units', tier: 'open', validate: oneOf(['metric', 'imperial']) },
  { id: 'preferences.dateFormat', section: 'Preferences', label: 'date format', tier: 'open', validate: oneOf(['iso', 'us', 'eu']) },
  { id: 'preferences.locale', section: 'Preferences', label: 'locale', tier: 'open', validate: bcp47 },

  { id: 'contactMe.channel', section: 'Contacting me', label: 'channel', tier: 'closed', validate: freeString },
  { id: 'contactMe.quietHours', section: 'Contacting me', label: 'quiet hours', tier: 'closed', validate: quietHoursRange },

  { id: 'style.verbosity', section: 'Style', label: 'verbosity', tier: 'open', validate: oneOf(['brief', 'normal', 'detailed']) },
  { id: 'style.formality', section: 'Style', label: 'formality', tier: 'open', validate: oneOf(['casual', 'neutral', 'formal']) },

  { id: 'defaults.approvalWindow', section: 'Defaults', label: 'approval window', tier: 'closed', validate: integerMinutes },
];

const FIELD_BY_ID = new Map(PROFILE_FIELDS.map((field) => [field.id, field]));

/** `<canonical section> <normalized label>` → field. */
const FIELD_BY_SECTION_LABEL = new Map(
  PROFILE_FIELDS.map((field) => [`${field.section} ${normalizeProfileKey(field.label)}`, field]),
);

export function profileFieldById(fieldId: string): ProfileFieldDef | undefined {
  return FIELD_BY_ID.get(fieldId);
}

/**
 * The refusal text for an unrecognised field id.
 *
 * Names every valid id compactly instead of pointing at docs/owner-profile.md
 * §4.3, a doc citation reads fine to a person but is useless to a model at
 * runtime, which cannot open the file and retry. One formatter, used by every
 * "not a profile field" refusal in the gateway route and the writer, so the
 * enumerated list can never drift between call sites.
 */
export function unknownProfileFieldMessage(fieldId: string): string {
  return `"${fieldId}" is not a profile field. Valid: ${PROFILE_FIELDS.map((field) => field.id).join(', ')}.`;
}

/** The field a `key:` names under a canonical section, or `undefined` for prose. */
export function profileFieldForLabel(
  section: ProfileSectionName,
  label: string,
): ProfileFieldDef | undefined {
  return FIELD_BY_SECTION_LABEL.get(`${section} ${normalizeProfileKey(label)}`);
}

export function profileFieldsForSection(section: ProfileSectionName): readonly ProfileFieldDef[] {
  return PROFILE_FIELDS.filter((field) => field.section === section);
}

/**
 * The tier of a whole section's PROSE.
 *
 * §11.2 puts "all `Style` content" in the open tier and names no other section's
 * prose, so every other section's prose is closed. That is the safest reading:
 * `Notes` holds "allergic to shellfish" and `People` holds facts about people
 * who never agreed to be in a database.
 */
export function profileSectionTier(heading: string): ProfileTier {
  return canonicalProfileSection(heading) === 'Style' ? 'open' : 'closed';
}

/** Open-tier field ids, for the short system-context block. */
export function openTierFieldIds(): readonly string[] {
  return PROFILE_FIELDS.filter((field) => field.tier === 'open').map((field) => field.id);
}

/** Closed-tier field ids, reachable only by an explicit named call. */
export function closedTierFieldIds(): readonly string[] {
  return PROFILE_FIELDS.filter((field) => field.tier === 'closed').map((field) => field.id);
}
