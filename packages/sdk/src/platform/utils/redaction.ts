/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Secrets: strings that are dangerous to hold ANYWHERE, the owner's own disk
 * included. A leaked key is a leaked key whether the file it sits in ever
 * leaves the machine or not, so these apply to every caller.
 */
const CREDENTIAL_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
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
];

/**
 * Identity: the owner's account name, as it appears inside a home path.
 *
 * This is ANONYMISATION, not secret-hiding, and it only earns its keep on text
 * that is about to leave the machine — a session export he hands to someone, a
 * telemetry payload. Applied to a file that lives on his own disk it destroys
 * information he needs (which directory the work happened in) in order to hide
 * his username from himself, and the substitution cannot be undone.
 *
 * Kept as a separate list rather than folded in with the credential patterns
 * because the two answer different questions and therefore have different
 * correct call sites. See `redactCredentialsOnly` below.
 */
const IDENTITY_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\/home\/[A-Za-z0-9_.-]+/g, replacement: '/home/[REDACTED]' },
  { pattern: /\/Users\/[A-Za-z0-9_.-]+/g, replacement: '/Users/[REDACTED]' },
  { pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+/g, replacement: 'C:\\Users\\[REDACTED]' },
];

/** Credentials + identity. What egress wants. */
const REDACT_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  ...CREDENTIAL_PATTERNS,
  ...IDENTITY_PATTERNS,
];

const SECRET_KEY_PATTERN = /(^|[_-])(authorization|token|secret|password|passwd|cookie|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?(id|token)?)([_-]|$)/i;
const CONTENT_KEY_PATTERN = /(^|[_-])(prompt|response|content|accumulated|body|text|stdout|stderr|output|input|reasoning|transcript|command|arguments|query|detail|summary|message)([_-]|$)/i;

function redactTextValue(value: string, key?: string): string {
  if (key && SECRET_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (key && CONTENT_KEY_PATTERN.test(key)) return `[REDACTED_TEXT length=${value.length}]`;
  if (value.length > 160 || value.includes('\n')) return `[REDACTED_TEXT length=${value.length}]`;
  return redactSensitiveData(value);
}

function applyPatterns(
  text: string,
  patterns: ReadonlyArray<{ pattern: RegExp; replacement: string }>,
): string {
  let result = text;
  for (const { pattern, replacement } of patterns) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Credentials AND home-path anonymisation.
 *
 * For text that is LEAVING the machine — session exports, telemetry. Both
 * halves are wanted there: the reader is not the owner, so his username is
 * not theirs to have.
 */
export function redactSensitiveData(text: string): string {
  return applyPatterns(text, REDACT_PATTERNS);
}

/**
 * Credentials only, leaving paths intact.
 *
 * For text that STAYS on the owner's machine — the at-rest journal, whose file
 * lives inside the very directory the identity patterns would rewrite. There
 * is no one to anonymise him from in his own files, and `/home/[REDACTED]/…`
 * makes a journal entry unusable for the debugging it exists for.
 */
export function redactCredentialsOnly(text: string): string {
  return applyPatterns(text, CREDENTIAL_PATTERNS);
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
