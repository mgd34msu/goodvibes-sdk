import { logger } from '../utils/logger.js';
import { normalizeSecretRef, resolveSecretRef, describeSecretRef } from './secret-refs.js';
import type { SecretRefResolutionOptions } from './secret-refs.js';
import { summarizeError } from '../utils/error-display.js';

/**
 * secret-ref-refusal.ts, telling a malformed reference from a literal secret.
 *
 * `resolveSecretInput` asked `normalizeSecretRef` whether a value was a valid
 * reference and, on `null`, concluded it must be a literal secret. That is a
 * rule that succeeds by convention: it is right for every string that was never
 * meant to be a reference, and catastrophically wrong for the one case it
 * cannot distinguish, a reference with a typo in it.
 *
 * The consequence was not subtle. A mistyped `goodvibes://secrets/...` in a
 * config file became the credential: the reference TEXT was handed to a
 * transport as an auth token, sent to a third party, and written into their
 * logs. The response was a 401, which sends whoever debugs it looking for a
 * wrong token rather than a malformed reference.
 *
 * So the question is split in two. "Does this parse as a reference" is
 * `normalizeSecretRef`. "Was this MEANT to be a reference" is
 * `looksLikeSecretRef`, and a value that was meant to be one and is not a valid
 * one is refused rather than used.
 */

/**
 * The URI schemes this module treats as a secret REFERENCE.
 *
 * Read straight off the parser's own accept list, so a scheme added there is
 * recognised here without anyone remembering.
 */
export const GOODVIBES_URI_PREFIX = 'goodvibes://';

const REFERENCE_SCHEME_PREFIXES: readonly string[] = [
  GOODVIBES_URI_PREFIX,
  'op://',
  'bw://',
  'vaultwarden://',
  'bws://',
];

/**
 * True when this text is SHAPED like a secret reference, whether or not it
 * parses as one.
 *
 * The distinction is the whole point. `normalizeSecretRef` answers "is this a
 * valid reference", and `resolveSecretInput` used to read a `null` from it as
 * "then it must be a literal secret", a rule that succeeds by convention. A
 * typo in a config reference therefore became the credential: the reference
 * TEXT was handed to a transport as an auth token, sent to a third party, and
 * logged there. What came back was a 401, which sends whoever debugs it hunting
 * for a wrong token rather than a malformed reference.
 */
export function looksLikeSecretRef(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  const value = input.trim().toLowerCase();
  return REFERENCE_SCHEME_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * Describe a malformed reference by SHAPE alone, for a diagnostic.
 *
 * Never returns the value. A malformed reference is usually not a credential,
 * but "usually" is not a property to log on, and the text may contain whatever
 * the operator meant to paste. Scheme and structure are enough to fix a typo.
 */
export function describeMalformedSecretRef(input: string): string {
  const value = input.trim();
  const scheme = REFERENCE_SCHEME_PREFIXES.find((prefix) => value.toLowerCase().startsWith(prefix)) ?? 'unknown';
  let host = '';
  let segmentCount = 0;
  try {
    const url = new URL(value);
    host = url.hostname;
    segmentCount = url.pathname.split('/').filter(Boolean).length;
  } catch {
    return `${scheme}… (not a parseable URI, ${value.length} characters)`;
  }
  return `${scheme}${host || '<no host>'}/… (${segmentCount} path segment${segmentCount === 1 ? '' : 's'})`;
}

/** Raised when a value shaped like a reference cannot be parsed as one. */
export class MalformedSecretRefError extends Error {
  readonly shape: string;
  readonly configKey: string | undefined;
  constructor(shape: string, configKey?: string) {
    super(
      configKey === undefined
        ? `A secret reference could not be parsed and was refused: ${shape}`
        : `${configKey} holds a secret reference that could not be parsed and was refused: ${shape}`,
    );
    this.name = 'MalformedSecretRefError';
    this.shape = shape;
    this.configKey = configKey;
  }
}


/**
 * Decide what to do with a value that is reference-shaped and did not parse.
 *
 * Returns true only when the caller has explicitly asserted the value is a
 * literal secret that merely looks like a reference. Either way the outcome is
 * disclosed: a refusal names the setting and the shape so an operator is told
 * WHICH reference is malformed, instead of being handed an authentication error
 * to chase. Neither branch ever logs the value.
 */
export function acceptRefShapedLiteral(
  value: string,
  options: { readonly configKey?: string | undefined; readonly treatUnparseableRefAsLiteral?: boolean | undefined },
): boolean {
  const named = options.configKey === undefined ? {} : { configKey: options.configKey };
  const shape = describeMalformedSecretRef(value);
  if (options.treatUnparseableRefAsLiteral !== true) {
    logger.error('Refusing a malformed secret reference: it will not be used as a credential', {
      ...named,
      shape,
      action: 'fix the reference; nothing was sent',
    });
    return false;
  }
  logger.warn('Using a reference-shaped value as a literal secret, because the caller asked for that explicitly', {
    ...named,
    shape,
  });
  return true;
}

export async function resolveSecretInput(
  input: unknown,
  options: SecretRefResolutionOptions = {},
): Promise<string | null> {
  const ref = normalizeSecretRef(input);
  if (ref) {
    try {
      return (await resolveSecretRef(ref, options)).value;
    } catch (error) {
      logger.warn('Secret reference resolution failed', {
        source: ref.source,
        ref: describeSecretRef(ref),
        error: summarizeError(error),
      });
      return null;
    }
  }
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  // Reference-shaped and unparseable: refuse. See secret-ref-refusal.ts.
  if (looksLikeSecretRef(trimmed) && !acceptRefShapedLiteral(trimmed, options)) return null;
  return trimmed.length > 0 ? trimmed : null;
}
