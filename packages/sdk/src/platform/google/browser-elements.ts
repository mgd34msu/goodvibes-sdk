/**
 * Matching controls on Google's own pages by accessible role and name.
 *
 * Google's pages carry no stable test ids, so every browser-driven step in
 * this module matches controls by accessible role and name. This is the single
 * most brittle part of the whole integration, so a miss is designed to fail
 * loudly and specifically — "looked for a button named X, the page showed
 * these N controls instead" — rather than silently clicking the wrong thing.
 *
 * Nothing here drives a browser. The flows are written against
 * `GoogleBrowserPort` (see `types.ts`), a six-method surface a product
 * implements over whatever automation it actually has: one product supplies a
 * Playwright-backed implementation, a test supplies a fake page, and neither
 * is visible from here. That is what makes the console walkthrough, the
 * app-password page and the calendar-settings page all runnable with no
 * browser at all.
 *
 * One honest limitation carried over from the first implementation: an
 * accessibility snapshot does not always report the DOM tag name of an
 * element, so `tag` on a `GoogleBrowserElement` may be a best-effort guess
 * derived from the accessible role (see `deriveTagFromRole`). Every flow
 * matches by role and name; `tag` in a `GoogleElementQuery` is an optional
 * extra filter, never load-bearing.
 */

import type { GoogleBrowserElement } from './types.js';

export interface GoogleElementQuery {
  readonly role?: string;
  readonly nameIncludes?: string;
  readonly namePattern?: RegExp;
  readonly tag?: string;
}

/** Case-insensitive, whitespace-normalized name for matching purposes. */
function normalizeName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The first element in `elements` matching every part of `query`, or null. */
export function findElement(
  elements: readonly GoogleBrowserElement[],
  query: GoogleElementQuery,
): GoogleBrowserElement | null {
  const wantRole = query.role ? query.role.toLowerCase() : null;
  const wantTag = query.tag ? query.tag.toLowerCase() : null;
  const wantIncludes = query.nameIncludes ? normalizeName(query.nameIncludes) : null;
  for (const element of elements) {
    if (wantRole && element.role.toLowerCase() !== wantRole) continue;
    if (wantTag && element.tag.toLowerCase() !== wantTag) continue;
    if (wantIncludes && !normalizeName(element.name).includes(wantIncludes)) continue;
    if (query.namePattern && !query.namePattern.test(element.name)) continue;
    return element;
  }
  return null;
}

/** Describes what a query was looking for, in plain language. */
function describeQuery(query: GoogleElementQuery): string {
  const parts: string[] = [];
  if (query.role) parts.push(`role "${query.role}"`);
  if (query.tag) parts.push(`tag "${query.tag}"`);
  if (query.nameIncludes) parts.push(`a name containing "${query.nameIncludes}"`);
  if (query.namePattern) parts.push(`a name matching ${query.namePattern.toString()}`);
  return parts.length > 0 ? `an element with ${parts.join(' and ')}` : 'an element matching an empty query';
}

const DEFAULT_CANDIDATE_LIMIT = 10;

/** A short, human-readable listing of elements actually present, for diagnostics. */
export function describeElements(
  elements: readonly GoogleBrowserElement[],
  limit: number = DEFAULT_CANDIDATE_LIMIT,
): string {
  if (elements.length === 0) return 'no interactive elements were found in the snapshot';
  const sample = elements.slice(0, limit);
  const described = sample.map((element) => `${element.role} "${element.name}"`).join(', ');
  const remaining = elements.length - sample.length;
  return remaining > 0 ? `${described}, and ${String(remaining)} more` : described;
}

export interface GoogleElementFound {
  readonly found: true;
  readonly element: GoogleBrowserElement;
}

export interface GoogleElementNotFound {
  readonly found: false;
  readonly query: GoogleElementQuery;
  readonly candidateCount: number;
  /** Plain-language failure statement: what was looked for, what was there instead. */
  readonly message: string;
}

export type GoogleElementLookup = GoogleElementFound | GoogleElementNotFound;

/**
 * Like `findElement`, but the miss carries a typed, descriptive result instead
 * of `null` — the failure mode this module exists to make impossible to get
 * wrong silently.
 */
export function requireElement(
  elements: readonly GoogleBrowserElement[],
  query: GoogleElementQuery,
): GoogleElementLookup {
  const element = findElement(elements, query);
  if (element) return { found: true, element };
  const message = `Looked for ${describeQuery(query)}, but the page showed ${String(elements.length)} control${
    elements.length === 1 ? '' : 's'
  } instead: ${describeElements(elements)}.`;
  return { found: false, query, candidateCount: elements.length, message };
}

/**
 * True when the page looks like Google's sign-in flow rather than the page
 * the flow expected: either the url landed on accounts.google.com's sign-in
 * route, or the snapshot shows an actual password input (the redirect
 * sometimes keeps the original url briefly, so the url check alone is not
 * sufficient).
 *
 * The password-field check is deliberately scoped to `role: 'textbox'`
 * (a real input) rather than matching "password" anywhere in any element's
 * name — Google's own pages routinely use the word in headings and buttons
 * ("App passwords", "Create app password"), and matching those would
 * misreport a normal page as a sign-in redirect.
 */
export function looksLikeGoogleSignIn(url: string, elements: readonly GoogleBrowserElement[]): boolean {
  if (/accounts\.google\.com\/.*signin/i.test(url)) return true;
  return findElement(elements, { role: 'textbox', nameIncludes: 'password' }) !== null;
}

/** Best-effort DOM tag guessed from an accessible role. */
const ROLE_TAG_HINTS: Readonly<Record<string, string>> = {
  button: 'button',
  link: 'a',
  textbox: 'input',
  searchbox: 'input',
  combobox: 'select',
  checkbox: 'input',
  radio: 'input',
  switch: 'input',
  option: 'option',
  heading: 'h2',
  label: 'label',
  tab: 'div',
  menuitem: 'div',
};

/**
 * The shared role-to-tag guess.
 *
 * Exported because every `GoogleBrowserPort` implementation faces the same
 * problem — an accessibility snapshot reports a role, not a tag — and the
 * guess should be one shared answer rather than re-invented per surface.
 * Returns `'div'` for any role with no better guess.
 */
export function deriveTagFromRole(role: string): string {
  return ROLE_TAG_HINTS[role.toLowerCase()] ?? 'div';
}
