/**
 * Driving the Google setup pages with the platform browser.
 *
 * `GoogleBrowserPort` (see `types.ts`) is six methods wide on purpose, so the
 * flows can be exercised against a scripted fake with no browser at all. This
 * module is the other half: the adapter that satisfies that port with a real
 * `BrowserEngine`, so the same flows drive real pages.
 *
 * It lives in the SDK rather than in a product because of who needs it. The
 * Cloud Console walkthrough is browser-driven, and the daemon is a runtime
 * that has to be able to complete it, a walkthrough only one product could
 * perform is a walkthrough the daemon cannot offer at all. Both halves are
 * platform now, so the adapter between them is too.
 *
 * The port owns exactly one implicit session/page pair: the first `navigate()`
 * lets the engine open (or reuse) a session, and every later call targets the
 * same session and page. Callers never pass or see a session id.
 *
 * On `tag`: `BrowserEngine.snapshot()` reports an accessible role, not a DOM
 * tag name, so `tag` here is the shared best-effort guess from
 * `deriveTagFromRole`. Every flow matches by role and name; `tag` is an
 * optional extra filter and never load-bearing.
 */

import type {
  BrowserEngine,
  BrowserLaunchOptions,
  BrowserTarget,
} from '../browser/index.js';
import { deriveTagFromRole } from './browser-elements.js';
import type { GoogleBrowserElement, GoogleBrowserPort } from './types.js';

export interface GoogleBrowserPortOptions {
  /** Passed through to the engine's first navigate, when no session exists yet. */
  readonly launch?: BrowserLaunchOptions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The labelled envelope a page-reading call returns, as a plain record.
 *
 * Kept as one named step so every reader of page text goes through the same
 * place, and a future change to the envelope breaks one function rather than
 * every caller that happened to reach into it.
 */
function readUntrustedEnvelope(result: Record<string, unknown>): Record<string, unknown> {
  const content = result['content'];
  if (typeof content !== 'object' || content === null) {
    throw new Error('google browser port: expected the browser engine to return a labelled content envelope.');
  }
  return content as Record<string, unknown>;
}

function requireStringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') {
    throw new Error(
      `google browser port: expected the browser engine to return a string field "${field}", got ${typeof value}.`,
    );
  }
  return value;
}

function toGoogleElement(raw: unknown): GoogleBrowserElement {
  if (!isRecord(raw)) {
    throw new Error('google browser port: expected a snapshot element to be an object.');
  }
  const ref = requireStringField(raw, 'ref');
  const role = requireStringField(raw, 'role');
  const name = requireStringField(raw, 'name');
  const value = typeof raw.value === 'string' ? raw.value : undefined;
  return { ref, role, name, tag: deriveTagFromRole(role), value };
}

function toGoogleElements(rawElements: unknown): readonly GoogleBrowserElement[] {
  if (!Array.isArray(rawElements)) {
    throw new Error('google browser port: expected the browser engine snapshot to return an "elements" array.');
  }
  return rawElements.map((entry: unknown) => toGoogleElement(entry));
}

/** Builds a `GoogleBrowserPort` over a live `BrowserEngine`. */
export function createGoogleBrowserPort(
  engine: BrowserEngine,
  options: GoogleBrowserPortOptions = {},
): GoogleBrowserPort {
  let sessionId: string | undefined;
  let pageId: string | undefined;

  function target(): BrowserTarget {
    return { sessionId, pageId };
  }

  function adopt(result: Record<string, unknown>): void {
    sessionId = requireStringField(result, 'sessionId');
    pageId = requireStringField(result, 'pageId');
  }

  return {
    async navigate(url) {
      const result = await engine.navigate(target(), {
        url,
        ...(options.launch === undefined ? {} : { launch: options.launch }),
      });
      adopt(result);
      return { url: requireStringField(result, 'url'), title: requireStringField(result, 'title') };
    },

    async currentUrl() {
      // No dedicated "where am I" call exists on the engine; readText carries
      // the current url as a side field, so a minimal read doubles as one.
      const result = await engine.readText(target(), { maxChars: 1 });
      adopt(result);
      return requireStringField(result, 'url');
    },

    async snapshot() {
      const result = await engine.snapshot(target());
      adopt(result);
      return toGoogleElements(result.elements);
    },

    async click(ref) {
      const result = await engine.click(target(), { ref });
      adopt(result);
    },

    async type(ref, text, typeOptions) {
      const result = await engine.type(target(), {
        ref,
        text,
        ...(typeOptions?.submit === undefined ? {} : { submit: typeOptions.submit }),
      });
      adopt(result);
    },

    async readText(readOptions) {
      const result = await engine.readText(target(), {
        ...(readOptions?.maxChars === undefined ? {} : { maxChars: readOptions.maxChars }),
      });
      adopt(result);
      // The engine hands back a LABELLED envelope, not a bare string: page text
      // travels with its origin and the standing rule about what page text may
      // ask for.
      //
      // Unwrapping here is deliberate and narrow. These flows drive Google's
      // own console pages to complete a setup the owner started, and they match
      // the text against fixed expectations rather than following instructions
      // found in it, so the words never reach the model as direction.
      return requireStringField(readUntrustedEnvelope(result), 'text');
    },
  };
}
