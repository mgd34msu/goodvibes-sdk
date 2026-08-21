/**
 * public-suffix.ts, the registrable domain (eTLD+1) of a host.
 *
 * ── Why this exists rather than a string comparison ───────────────────────
 *
 * Every naive host check fails to a real attack:
 *
 *   `endsWith('google.com')`      passes `google.com.evil.example`
 *   `includes('google.com')`      passes `google.com.evil.example`
 *   split on the last two labels  gets `co.uk` wrong for `bbc.co.uk`
 *
 * The only correct comparison is on the REGISTRABLE domain, the label
 * immediately below the public suffix, because that is the unit somebody had
 * to buy. `google.com.evil.example` is registrable-domain `evil.example`, and
 * so it fails against `google.com` for the right reason rather than by luck.
 *
 * ── The data, and how it stays current ────────────────────────────────────
 *
 * This is a BUNDLED SNAPSHOT of the ICANN section of Mozilla's Public Suffix
 * List, reduced to the rules that matter for the comparison this module
 * performs: the multi-label suffixes. A single-label suffix (`com`, `dev`,
 * `app`, any new gTLD) needs no rule, the fallback treats one label as the
 * suffix, which is correct for all of them.
 *
 * That fallback is what makes the snapshot safe to be slightly stale: an
 * unknown NEW suffix degrades to the single-label rule. The failure that
 * matters is the opposite direction, a multi-label suffix we do not know
 * about, e.g. a newly delegated `something.xx`, would make two distinct
 * registrants compare equal. So the list must be refreshed, and refreshing it
 * is a data change with no code change:
 *
 *   curl -s https://publicsuffix.org/list/public_suffix_list.dat
 *
 * take the ICANN DOMAINS section, keep the rules containing a dot plus the
 * wildcard and exception rules, and replace the tables below. A test pins the
 * cases that motivated each group, so a bad refresh fails rather than silently
 * widening what compares equal.
 */

import {
  PUBLIC_SUFFIX_MULTI_LABEL,
  PUBLIC_SUFFIX_WILDCARD_PARENTS,
  PUBLIC_SUFFIX_EXCEPTIONS,
} from './generated/public-suffix-data.js';

/**
 * The bundled tables, generated from upstream.
 *
 * The first version of this file carried a HAND-CURATED 174 suffixes out of
 * upstream's 5,484. That left 5,332 multi-label suffixes under which two
 * different registrants reduced to the same registrable domain, a link check
 * would have accepted a stranger's domain as the authorized one. The drift
 * check caught it on its first run. Curation by hand is how that happens, so
 * the data is generated now and the tables below are not edited directly.
 */
const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set(PUBLIC_SUFFIX_MULTI_LABEL);

/**
 * `*.parent` rules: every label directly under one of these is itself a
 * suffix, so two instances under it are different registrants.
 */
const WILDCARD_SUFFIX_PARENTS: readonly string[] = PUBLIC_SUFFIX_WILDCARD_PARENTS;

/**
 * `!exception` rules: registrable despite matching a wildcard above.
 *
 * Checked before the wildcard rules, which is the order the PSL algorithm
 * requires, an exception that lost to its own wildcard would do nothing.
 */
const SUFFIX_EXCEPTIONS: ReadonlySet<string> = new Set(PUBLIC_SUFFIX_EXCEPTIONS);

/**
 * The bundled snapshot, for the drift check.
 *
 * Exported so `scripts/check-public-suffix-drift.ts` compares against the data
 * this module actually uses, a drift check holding its own copy of what it is
 * checking would pass forever.
 */
export function bundledMultiLabelSuffixes(): ReadonlySet<string> {
  return MULTI_LABEL_SUFFIXES;
}

/** The wildcard-parent rules in the snapshot. See the header. */
export function bundledWildcardSuffixParents(): readonly string[] {
  return WILDCARD_SUFFIX_PARENTS;
}

/** True when `host` is itself exactly a public suffix (so it has no registrant). */
export function isPublicSuffix(host: string): boolean {
  const labels = host.split('.');
  if (labels.length <= 1) return true;
  if (MULTI_LABEL_SUFFIXES.has(host)) return true;
  return WILDCARD_SUFFIX_PARENTS.some((parent) => {
    const rest = labels.slice(1).join('.');
    return rest === parent;
  });
}

/**
 * The registrable domain of `host`, the label immediately below its public
 * suffix, or `null` when the host has none (it IS a suffix, or is a single
 * label, or is malformed).
 *
 * `null` is a refusal, never a fallback to the whole host: a caller that
 * treated an unparseable host as its own registrable domain would compare
 * equal to itself and let a malformed host through.
 */
export function registrableDomain(host: string): string | null {
  const normalized = host.trim().toLowerCase().replace(/\.+$/, '');
  if (normalized.length === 0) return null;
  const labels = normalized.split('.');
  if (labels.length < 2 || labels.some((label) => label.length === 0)) return null;

  // PSL order: an exception rule wins over the wildcard it contradicts.
  for (const exception of SUFFIX_EXCEPTIONS) {
    if (normalized === exception || normalized.endsWith(`.${exception}`)) {
      const exceptionLabels = exception.split('.');
      return exceptionLabels.slice(exceptionLabels.length - 2).join('.');
    }
  }

  for (const parent of WILDCARD_SUFFIX_PARENTS) {
    const parentLabels = parent.split('.');
    // `*.compute.amazonaws.com`: the suffix is one label plus the parent.
    if (labels.length >= parentLabels.length + 2
      && labels.slice(labels.length - parentLabels.length).join('.') === parent) {
      return labels.slice(labels.length - parentLabels.length - 2).join('.');
    }
  }

  // Longest known multi-label suffix wins, so `co.uk` beats `uk`.
  for (let start = 0; start < labels.length - 1; start += 1) {
    const candidate = labels.slice(start).join('.');
    if (MULTI_LABEL_SUFFIXES.has(candidate)) {
      if (start === 0) return null; // the host IS the suffix
      return labels.slice(start - 1).join('.');
    }
  }

  // Fallback: a single-label suffix. Correct for com, dev, app and every new
  // gTLD, and the reason an out-of-date snapshot degrades safely.
  return labels.slice(-2).join('.');
}

/** True when both hosts sit under the same registrable domain. */
export function sameRegistrableDomain(left: string, right: string): boolean {
  const a = registrableDomain(left);
  const b = registrableDomain(right);
  return a !== null && b !== null && a === b;
}
