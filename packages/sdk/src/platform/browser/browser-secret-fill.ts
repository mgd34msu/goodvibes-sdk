/**
 * browser-secret-fill.ts — typing a value the model must never see.
 *
 * Split out of browser-engine.ts rather than living as one more method on it,
 * because this is a genuinely separate concern with its own rules. Every other
 * page operation on the engine reports what it did in terms the model can read
 * back; this one exists precisely so that it cannot.
 *
 * ── Why the value is a parameter and not a lookup ─────────────────────────
 *
 * This module does not know what a card is and cannot reach a secret store. It
 * is handed a string by an in-process caller (payments/fill-card.ts, which read
 * it from the daemon's own store) and types it. Keeping the lookup out of here
 * is what lets `platform/browser/` stay free of any payment wiring, and it also
 * means there is exactly one module in the repository that can produce card
 * material — not two.
 *
 * ── The two rules this file exists to enforce ─────────────────────────────
 *
 *  1. **A guard must be installed.** Without one, page content reported after
 *     this runs would contain what was just typed. The refusal is here rather
 *     than in the caller so that no caller can skip it.
 *  2. **The driver's error never escapes.** A browser's fill failure can quote
 *     the string it was asked to type — `could not type "…" into #cc` — and an
 *     error message is a read path exactly like a response field. The original
 *     is discarded and replaced with one written here, naming the element.
 */
import type { Locator, Page } from 'playwright-core';
import { BrowserSessionError } from './browser-sessions.js';
import { resolveRef } from './browser-snapshot.js';
import type { BrowserElementRef, BrowserSnapshot, CardFieldGuard } from './browser-types.js';

export interface SecretFillRequest {
  readonly page: Page;
  readonly snapshot: BrowserSnapshot | null;
  readonly ref: string;
  readonly value: string;
  readonly guard: CardFieldGuard | null;
  readonly timeoutMs: number;
}

export interface SecretFillOutcome {
  readonly element: BrowserElementRef;
}

/**
 * Type a secret into a resolved element, reporting only the element.
 *
 * The return deliberately carries no echo of the value, no length, and no
 * masked form. A caller that wanted to log "filled 16 characters" would have to
 * count them itself, which is the kind of thing that shows up in review.
 */
export async function fillSecretIntoPage(request: SecretFillRequest): Promise<SecretFillOutcome> {
  if (request.guard === null) {
    throw new BrowserSessionError(
      'Refused: this browser has no card-material redaction installed, so anything typed here '
      + 'could be read straight back out of a page snapshot.',
      'Construct the browser engine with a cardFieldGuard before using it to pay for anything.',
    );
  }

  const { locator, element } = await resolveRef(request.page, request.snapshot, request.ref);
  await typeOrRefuse(locator, request.value, request.timeoutMs, element);
  return { element };
}

async function typeOrRefuse(
  locator: Locator,
  value: string,
  timeout: number,
  element: BrowserElementRef,
): Promise<void> {
  try {
    await locator.fill(value, { timeout });
  } catch (error) {
    // Discarded rather than wrapped. The failing call had the value in its
    // arguments, and Playwright's message includes the string it tried to type.
    void error;
    throw new BrowserSessionError(
      `The ${element.role} "${element.name}" would not accept input.`,
      'Re-snapshot the page and check the field is present and enabled.',
    );
  }
}

/**
 * Refuse a page capture while card material is on the page.
 *
 * A screenshot of a filled payment form is a picture of the number. Unlike
 * every other read path it cannot be string-searched, and painting boxes over
 * the fields we recognise leaves whatever a hostile page invented — so this
 * refuses rather than producing a file that looks redacted and is not.
 */
export function assertCaptureAllowed(
  guard: CardFieldGuard | null,
  sessionId: string,
  pageId: string,
): void {
  if (guard?.hasLiveMaterial(sessionId, pageId) !== true) return;
  throw new BrowserSessionError(
    'Refused: this page currently has payment details filled in, and a screenshot of it would '
    + 'be a picture of them. Unlike text, an image cannot have the card removed from it.',
    'Take the screenshot after the order is submitted, or on a different page.',
  );
}
