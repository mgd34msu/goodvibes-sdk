/**
 * browser-engine-contract.ts, the engine's option/target types, its error, and
 * the two pure helpers that neither read nor hold engine state.
 *
 * Split out of browser-engine.ts, which crossed the 800-line cap once the
 * untrusted-content boundary and the card-field guard both landed in it. Each
 * of those lanes kept the file under the cap on its own; the union did not.
 * Nothing here touches `BrowserEngine` state, so this is a move, not a
 * redesign: `readElementData` runs inside the page and closes over nothing,
 * and `normalizeUrl` is a pure string check.
 *
 * Every public name is re-exported from browser-engine.ts so the
 * `platform/browser` barrel's surface is unchanged, the same convention
 * orchestrator-runner.ts used when its context-window unit moved out.
 */
import { BrowserSessionError } from './browser-sessions.js';
import type { CardFieldGuard, OwnerApproval, UntrustedContentPort } from './browser-types.js';

export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
export const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
export const DEFAULT_TEXT_LIMIT = 20_000;

/**
 * Schemes a page may be sent to.
 *
 * `javascript:` is refused outright. A javascript: URL is not navigation, it is
 * script injection into whatever is currently loaded, and it is exactly how a
 * bookmarklet ended up executing somewhere it was never meant to. Script that
 * needs to run in a page goes through action:"evaluate", which is scoped to a
 * page this engine controls and is reported as such.
 */
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:', 'file:', 'about:']);

export interface BrowserTarget {
  readonly sessionId?: string | undefined;
  readonly pageId?: string | undefined;
}

export interface BrowserEngineOptions {
  /** Where screenshots are written. Must be a directory the product's read path can open. */
  readonly screenshotDirectory: string;
  /**
   * The product's untrusted-content contract. Required, and deliberately not
   * defaulted: an engine with no port would read pages and label nothing, which
   * is the boundary silently absent rather than a compile error. The
   * implementation is expected to be backed by the process-wide ledger every
   * other surface that reads stranger-written text also writes to, the email
   * surface most of all, so "read a page, then send a message" is visible as
   * one composition rather than two unrelated acts.
   */
  readonly untrusted: UntrustedContentPort;
  /** An owner approval covering an outward action in this turn, when one exists. */
  readonly approval?: OwnerApproval | null;
  /**
   * Records that this session wrote a file, so the product's read path can open
   * it afterwards. Optional: a surface with no session write ledger passes
   * nothing and screenshots are simply written and reported.
   */
  readonly recordSessionWrite?: ((path: string) => void) | undefined;
  /**
   * Keeps card material out of everything a page hands back.
   *
   * Optional here so every existing caller keeps working, and NOT optional in
   * practice: `payments.checkout.fillCard` refuses to type into an engine that
   * has none. A browser used for ordinary automation needs no guard; a browser
   * used to pay for something cannot be made to run without one.
   */
  readonly cardFieldGuard?: CardFieldGuard | undefined;
}

/** Fields the extraction contract can ask for. Nothing here can invoke anything. */
export type BrowserExtractField = 'text' | 'html' | 'value' | 'attributes';

/**
 * Runs in the page. Fixed, shipped in this file, and never assembled from
 * caller input: the caller only chooses which of these fields it wants.
 */
export function readElementData(element: Element, fields: string[]): Record<string, unknown> {
  const data: Record<string, unknown> = { tag: element.tagName.toLowerCase() };
  for (const field of fields) {
    if (field === 'text') {
      const text = (element as HTMLElement).innerText ?? element.textContent ?? '';
      data.text = text.replace(/\s+/g, ' ').trim().slice(0, 20_000);
    } else if (field === 'html') {
      data.html = element.outerHTML.slice(0, 20_000);
    } else if (field === 'value') {
      const input = element as HTMLInputElement;
      const type = (element.getAttribute('type') ?? '').toLowerCase();
      data.value = type === 'password' ? null : (input.value ?? null);
    } else if (field === 'attributes') {
      const attributes: Record<string, string> = {};
      for (const attribute of Array.from(element.attributes)) {
        attributes[attribute.name] = attribute.value.slice(0, 2_000);
      }
      data.attributes = attributes;
    }
  }
  return data;
}

export class UntrustedEffectError extends Error {
  constructor(message: string, readonly fix: string) {
    super(message);
    this.name = 'UntrustedEffectError';
  }
}

/**
 * Identity-provider hosts whose own sign-in routes this engine refuses to
 * click or type on, matched by hostname so a subdomain still counts.
 *
 * This is deliberately not specific to Google. The Google flows in
 * `platform/google/` already carry their own sign-in check
 * (`looksLikeGoogleSignIn` in `browser-elements.ts`) and bail out before this
 * code ever runs. This list exists for the path those flows do not cover: the
 * browser tool driven directly, one click/type call at a time, with no
 * structured flow watching for a sign-in redirect at all.
 */
const KNOWN_IDENTITY_PROVIDER_HOSTS: readonly RegExp[] = [
  /(^|\.)accounts\.google\.com$/i,
  /(^|\.)login\.microsoftonline\.com$/i,
  /(^|\.)login\.live\.com$/i,
  /(^|\.)appleid\.apple\.com$/i,
  /(^|\.)login\.yahoo\.com$/i,
  /(^|\.)github\.com$/i,
];

/** Path or query shape that reads as a sign-in step rather than ordinary browsing. */
const SIGN_IN_ROUTE_PATTERN = /(sign[\s_-]?in|log[\s_-]?in|authorize|oauth)/i;

/**
 * Whether the current page is a credential-entry page this engine should
 * refuse to drive.
 *
 * Two independent signals, either sufficient on its own:
 *   - a password-type field is present right now, which works for any site
 *     and needs no provider list at all;
 *   - the URL is on a known identity provider's own sign-in route, which
 *     catches the page before a password field has necessarily rendered yet
 *     (an email/identifier step, an account picker).
 *
 * `hasPasswordField` is supplied by the caller rather than computed here: the
 * engine already has either a stored snapshot or a live page to ask, and
 * which one it uses is a decision this pure function should not have to make.
 */
export function looksLikeCredentialPage(url: string, hasPasswordField: boolean): boolean {
  if (hasPasswordField) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!KNOWN_IDENTITY_PROVIDER_HOSTS.some((pattern) => pattern.test(parsed.hostname))) return false;
  return SIGN_IN_ROUTE_PATTERN.test(parsed.pathname) || SIGN_IN_ROUTE_PATTERN.test(parsed.search);
}

/**
 * The message/fix pair for refusing an interactive action on a credential
 * page, or null when the page is not one.
 *
 * `elements` is whatever the last snapshot recorded, a plain `{ role, name }`
 * shape rather than the full `BrowserElementRef`, so this stays a pure
 * function with no dependency on the snapshot module. The engine is the only
 * caller, and it is the one place that knows whether a snapshot exists at all.
 */
export function credentialPageRefusal(
  url: string,
  elements: readonly { readonly role: string; readonly name: string }[],
  action: string,
): { readonly message: string; readonly fix: string } | null {
  const hasPasswordField = elements.some((element) => element.role.toLowerCase() === 'textbox' && /password/i.test(element.name));
  if (!looksLikeCredentialPage(url, hasPasswordField)) return null;
  return {
    message: `This page looks like a sign-in page (${url}), so the browser layer will not ${action} on it. Automated sign-ins are not supported here, only the account owner can complete one.`,
    fix: `Give the owner this URL to open in their own browser and sign in there: ${url}`,
  };
}

/**
 * What `launch()` tells the caller happened. Reuse is called out explicitly,
 * only one managed session runs at a time, so a second launch call getting
 * the same session back is a normal outcome, not a silent no-op.
 */
export function launchNote(session: { readonly reused: boolean; readonly headless: boolean; readonly sessionId: string }): string {
  if (session.reused) {
    return `Reusing the browser session already open (${session.sessionId}). Only one managed session runs at a time; call action:"close" first if a different profile is needed.`;
  }
  return session.headless
    ? 'Started headless. Pass headless:false to open a visible window for a sign-in.'
    : 'Started a visible window. Sign in once here and the profile keeps the login for later runs.';
}

export function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new BrowserSessionError('No url was given to navigate to.', 'Pass url:"https://example.com".');
  }
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new BrowserSessionError(`"${rawUrl}" is not a usable URL.`, 'Pass a full URL such as https://example.com.');
  }
  if (parsed.protocol === 'javascript:') {
    throw new BrowserSessionError(
      'Navigating to a javascript: URL is not supported, because it runs script against whatever page is currently open instead of loading a page.',
      'Use action:"evaluate" to run script in a page this tool controls.',
    );
  }
  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
    throw new BrowserSessionError(
      `The ${parsed.protocol} scheme is not supported by the browser tool.`,
      'Use an http, https, file, or about URL.',
    );
  }
  return parsed.toString();
}
