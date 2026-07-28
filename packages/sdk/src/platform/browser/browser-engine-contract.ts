/**
 * browser-engine-contract.ts — the engine's option/target types, its error, and
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
 * `platform/browser` barrel's surface is unchanged — the same convention
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
   * other surface that reads stranger-written text also writes to — the email
   * surface most of all — so "read a page, then send a message" is visible as
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
