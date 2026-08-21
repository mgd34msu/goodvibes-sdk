/**
 * browser-secret-fill.ts, typing values the model must never see.
 *
 * Split out of browser-engine.ts rather than living as one more method on it,
 * because this is a genuinely separate concern with its own rules. Every other
 * page operation on the engine reports what it did in terms the model can read
 * back; this one exists precisely so that it cannot.
 *
 * ── Why the value is a parameter and not a lookup ─────────────────────────
 *
 * This module does not know what a card is and cannot reach a secret store. It
 * is handed strings by an in-process caller (payments/fill-card.ts, which read
 * them from the daemon's own store) and types them. Keeping the lookup out of
 * here is what lets `platform/browser/` stay free of any payment wiring, and it
 * also means there is exactly one module in the repository that can produce
 * card material, not two.
 *
 * ── Why a batch, not one call per field ────────────────────────────────────
 *
 * A checkout has several secret fields, and every one of them is addressed by
 * a ref that only resolves against the snapshot in place when it was minted.
 * Typing field one and then re-resolving field two against that SAME snapshot
 * works fine; the bug this replaces was clearing the snapshot after every
 * single field, which meant field two's ref pointed at nothing by the time its
 * turn came. So every ref in the batch, including ones typed later, is
 * resolved against the CURRENT snapshot before any of them is typed: a target
 * that will not resolve refuses the whole batch before a single character
 * reaches the page, rather than after some of it already has.
 *
 * ── The two rules this file exists to enforce ─────────────────────────────
 *
 *  1. **A guard must be installed.** Without one, page content reported after
 *     this runs would contain what was just typed. The refusal is here rather
 *     than in the caller so that no caller can skip it.
 *  2. **The driver's error never escapes.** A browser's fill failure can quote
 *     the string it was asked to type, `could not type "…" into #cc`, and an
 *     error message is a read path exactly like a response field. The original
 *     is discarded and replaced with one written here, naming the element.
 */
import type { Locator, Page } from 'playwright-core';
import { BrowserSessionError } from './browser-sessions.js';
import { resolveRef } from './browser-snapshot.js';
import type { BrowserElementRef, BrowserSnapshot, CardFieldGuard } from './browser-types.js';

export interface SecretFillItem {
  readonly ref: string;
  readonly value: string;
}

export interface BatchSecretFillRequest {
  readonly page: Page;
  readonly snapshot: BrowserSnapshot | null;
  readonly fills: readonly SecretFillItem[];
  readonly guard: CardFieldGuard | null;
  readonly timeoutMs: number;
}

/**
 * `filled` carries only the refs that were successfully typed, in order, never
 * a value. `ok` is false when a target could not be resolved at all (nothing
 * was typed) or when typing stopped partway through; `failedRef` names the one
 * target where it stopped, so the caller can report a field name without ever
 * holding what was meant to go into it.
 */
export interface BatchSecretFillOutcome {
  readonly ok: boolean;
  readonly filled: readonly string[];
  readonly failedRef: string | null;
}

/**
 * Type every field of a secret batch, reporting only which refs were filled.
 *
 * The return deliberately carries no echo of any value, no length, and no
 * masked form. A caller that wanted to log "filled 16 characters" would have to
 * count them itself, which is the kind of thing that shows up in review.
 */
export async function fillSecretsIntoPage(request: BatchSecretFillRequest): Promise<BatchSecretFillOutcome> {
  if (request.guard === null) {
    throw new BrowserSessionError(
      'Refused: this browser has no card-material redaction installed, so anything typed here '
      + 'could be read straight back out of a page snapshot.',
      'Construct the browser engine with a cardFieldGuard before using it to pay for anything.',
    );
  }

  // Every target is resolved against the ONE pre-fill snapshot before any
  // value is typed. Resolving field two after field one was already typed is
  // exactly the bug this batch exists to close.
  //
  // An unresolvable ref is reported the same way a typing failure is, as
  // `failedRef` on the returned outcome, rather than thrown. Nothing has been
  // typed yet at this point regardless of which ref in the batch failed to
  // resolve, so `filled` is empty either way; the difference a throw would
  // have made is only that the caller could no longer name WHICH ref it was.
  const resolved: { readonly ref: string; readonly value: string; readonly locator: Locator; readonly element: BrowserElementRef }[] = [];
  for (const fill of request.fills) {
    try {
      const { locator, element } = await resolveRef(request.page, request.snapshot, fill.ref);
      resolved.push({ ref: fill.ref, value: fill.value, locator, element });
    } catch (error) {
      void error;
      return { ok: false, filled: [], failedRef: fill.ref };
    }
  }

  const filled: string[] = [];
  for (const item of resolved) {
    try {
      await typeOrRefuse(item.locator, item.value, request.timeoutMs, item.element);
    } catch (error) {
      void error;
      return { ok: false, filled, failedRef: item.ref };
    }
    filled.push(item.ref);
  }
  return { ok: true, filled, failedRef: null };
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
 * the fields we recognise leaves whatever a hostile page invented, so this
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
