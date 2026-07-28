/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

const REDACT_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\b(sk-[A-Za-z0-9_-]{20,})/g, replacement: '[REDACTED_API_KEY]' },
  { pattern: /\b(key-[A-Za-z0-9_-]{16,})/g, replacement: '[REDACTED_API_KEY]' },
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, replacement: '$1[REDACTED_TOKEN]' },
  { pattern: /\b(ghp_[A-Za-z0-9]{36,})/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { pattern: /\b(gho_[A-Za-z0-9]{36,})/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { pattern: /\b(github_pat_[A-Za-z0-9_]{36,})/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { pattern: /\b(glpat-[A-Za-z0-9_-]{20,})/g, replacement: '[REDACTED_GITLAB_TOKEN]' },
  { pattern: /\b(xoxb-[A-Za-z0-9-]{24,})/g, replacement: '[REDACTED_SLACK_TOKEN]' },
  { pattern: /\b(xoxp-[A-Za-z0-9-]{24,})/g, replacement: '[REDACTED_SLACK_TOKEN]' },
  { pattern: /\b(AKIA[A-Z0-9]{16})\b/g, replacement: '[REDACTED_AWS_KEY]' },
  { pattern: /\/home\/[A-Za-z0-9_.-]+/g, replacement: '/home/[REDACTED]' },
  { pattern: /\/Users\/[A-Za-z0-9_.-]+/g, replacement: '/Users/[REDACTED]' },
  { pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+/g, replacement: 'C:\\Users\\[REDACTED]' },
];

const SECRET_KEY_PATTERN = /(^|[_-])(authorization|token|secret|password|passwd|cookie|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?(id|token)?)([_-]|$)/i;
const CONTENT_KEY_PATTERN = /(^|[_-])(prompt|response|content|accumulated|body|text|stdout|stderr|output|input|reasoning|transcript|command|arguments|query|detail|summary|message)([_-]|$)/i;

// ---------------------------------------------------------------------------
// Owner-profile containment (docs/owner-profile.md §11.3)
// ---------------------------------------------------------------------------

/**
 * Object keys that name closed-tier owner-profile content.
 *
 * Written out here rather than derived from `platform/owner-profile`, on
 * purpose: this module is imported by session export, at-rest persistence,
 * telemetry helpers and error display, and every one of those has to keep
 * working in a process where no profile was ever loaded. The values arrive
 * through {@link registerProfileRedactionValues}; the key names are a fixed
 * vocabulary and do not need a live profile to be recognised.
 *
 * Mirrors SECRET_KEY_PATTERN's boundary shape, so it matches `shippingAddress`,
 * `shipping_address` and `shipping-address` alike.
 */
const PROFILE_KEY_PATTERN = /(^|[_-])(shipping[_-]?address|billing[_-]?address|home[_-]?address|postal[_-]?address|street[_-]?address|mailing[_-]?address|agent[_-]?alias|quiet[_-]?hours|owner[_-]?profile|profile[_-]?field)([_-]|$)/i;

/**
 * The shortest value that may become a redaction pattern.
 *
 * A short profile value is a footgun, not a secret: `currency: USD` and
 * `shipping tier: standard` are closed-tier fields whose values are ordinary
 * English, and turning them into patterns would blank the word "standard" out
 * of every unrelated log line and stack trace this module touches. Redacting
 * too much is not the safe direction — it destroys the diagnostic the export
 * exists to carry, and it does it silently.
 */
const MIN_PROFILE_VALUE_LENGTH = 8;

/**
 * Values distinctive enough to match on: long enough, and carrying a digit, an
 * `@`, or internal whitespace.
 *
 * That test admits every value that is genuinely identifying — an address, an
 * email, a phone number, a full name, a `22:00-07:00` range — and rejects the
 * single common words (`telegram`, `standard`, `imperial`) that would otherwise
 * become a pattern matching half the corpus.
 */
function isDistinctiveProfileValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < MIN_PROFILE_VALUE_LENGTH) return false;
  return /[0-9@]/.test(trimmed) || /\s/.test(trimmed);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The closed-tier strings a loaded profile wants kept out of anything written
 * out, in two classes.
 *
 * The split exists because §10 (third-party personal data) and the
 * distinctiveness floor genuinely conflict, and the conflict was reproduced: a
 * `People` line reading `- Bob Lee` is seven characters, fell under the floor,
 * and left a session export in the clear. The floor's reasoning is still right
 * for ordinary values — `currency: USD` must not blank the word USD everywhere —
 * so the resolution is to key third-party data on its SECTION rather than on
 * the shape of its value.
 */
export interface ProfileRedactionValues {
  /** Ordinary closed-tier values. Subject to the distinctiveness floor. */
  readonly guarded: readonly string[];
  /**
   * Third-party personal data (`People`). Redacted regardless of length or
   * shape, because §10 is absolute. Matched on word boundaries so a two-letter
   * name cannot blank the middle of unrelated words.
   */
  readonly absolute: readonly string[];
}

/** Supplies the closed-tier values present in the loaded profile, if any. */
export type ProfileRedactionValueReader = () => ProfileRedactionValues;

let profileValueReader: ProfileRedactionValueReader | null = null;
let profilePatternCacheKey: string | null = null;
let profilePatterns: readonly RegExp[] = [];

/**
 * Register (or clear, with `null`) the reader that supplies the loaded
 * profile's closed-tier values.
 *
 * A registered reader rather than an import: `redaction.ts` must stay usable
 * where no profile exists — a browser bundle, a surface with no daemon, a test
 * that never built a store. With nothing registered this module behaves exactly
 * as it did before the profile existed.
 */
export function registerProfileRedactionValues(reader: ProfileRedactionValueReader | null): void {
  profileValueReader = reader;
  profilePatternCacheKey = null;
  profilePatterns = [];
}

/**
 * Compiled patterns for the current profile values.
 *
 * Recompiled only when the set of values actually changes, because this runs on
 * every at-rest write and every exported message, not once per process — the
 * profile is reloaded whenever the owner edits the file, so a
 * compile-once-at-startup cache would go stale the first time he did.
 */
function currentProfilePatterns(): readonly RegExp[] {
  if (profileValueReader === null) return [];
  const { guarded, absolute } = profileValueReader();
  const guardedValues = guarded.map((value) => value.trim()).filter(isDistinctiveProfileValue);
  // Third-party data skips the floor entirely; only genuinely empty is dropped.
  const absoluteValues = absolute.map((value) => value.trim()).filter((value) => value.length > 0);
  const cacheKey = `${guardedValues.join('\u0000')}\u0001${absoluteValues.join('\u0000')}`;
  if (cacheKey !== profilePatternCacheKey) {
    profilePatternCacheKey = cacheKey;
    // Longest first, so a value contained inside another is not left as a
    // half-redacted fragment of the longer one.
    const sortByLength = (a: { value: string }, b: { value: string }): number =>
      b.value.length - a.value.length;
    profilePatterns = [
      ...guardedValues.map((value) => ({ value, boundary: false })),
      ...absoluteValues.map((value) => ({ value, boundary: true })),
    ]
      .sort(sortByLength)
      .map(({ value, boundary }) => (boundary ? boundedPattern(value) : new RegExp(escapeRegExp(value), 'gi')));
  }
  return profilePatterns;
}

/**
 * A pattern that only matches the value as a whole token.
 *
 * `- Al` as a bare substring pattern would blank the "Al" out of "Also" and
 * "Already". The lookarounds are on letters and digits only, so a value that
 * starts or ends with punctuation still matches where it should.
 */
function boundedPattern(value: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, 'giu');
}

function redactTextValue(value: string, key?: string): string {
  if (key && SECRET_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (key && PROFILE_KEY_PATTERN.test(key)) return '[REDACTED_PROFILE]';
  if (key && CONTENT_KEY_PATTERN.test(key)) return `[REDACTED_TEXT length=${value.length}]`;
  if (value.length > 160 || value.includes('\n')) return `[REDACTED_TEXT length=${value.length}]`;
  return redactSensitiveData(value);
}

export function redactSensitiveData(text: string): string {
  let result = text;
  // Profile values first: they are whole values, and replacing them before the
  // generic patterns means an address containing a home path is redacted as a
  // profile value rather than left as a partially-rewritten address.
  for (const pattern of currentProfilePatterns()) {
    result = result.replace(pattern, '[REDACTED_PROFILE]');
  }
  for (const { pattern, replacement } of REDACT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function redactStructuredData(value: unknown): unknown {
  return redactStructuredDataInternal(value, undefined, new WeakSet<object>());
}

function redactStructuredDataInternal(
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') {
    return redactTextValue(value, key);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactStructuredDataInternal(item, key, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(entryKey) && typeof entryValue !== 'object') {
        output[entryKey] = '[REDACTED]';
        continue;
      }
      // A profile-shaped key is redacted whatever it holds, including an object:
      // a structured postal address is exactly the shape whose parts would
      // otherwise each be walked and each pass the string checks individually.
      if (PROFILE_KEY_PATTERN.test(entryKey)) {
        output[entryKey] = '[REDACTED_PROFILE]';
        continue;
      }
      output[entryKey] = redactStructuredDataInternal(entryValue, entryKey, seen);
    }
    seen.delete(value);
    return output;
  }
  return String(value);
}

export function isSensitiveTelemetryKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) || CONTENT_KEY_PATTERN.test(key);
}
