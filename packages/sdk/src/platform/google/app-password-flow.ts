/**
 * Drives Google's app-password page (https://myaccount.google.com/apppasswords)
 * to create a 16-character app password with a known label.
 *
 * Three states are not "ready" and are detected and returned distinctly
 * instead of retried in a loop:
 *
 *  - `sign-in-required` , Google redirected to a sign-in page.
 *  - `two-step-required`, the account has no 2-Step Verification, so Google
 *                           makes app passwords unavailable outright.
 *  - `label-already-exists`, an app password with this label is already
 *                              listed. Google never re-displays an existing
 *                              password, so the only way forward is reusing
 *                              the one already stored, or deleting that entry
 *                              and re-running. Detecting this is what makes
 *                              the flow idempotent instead of piling up
 *                              duplicate app passwords on every re-run.
 *
 * The created password is returned only in the dedicated `password` field of
 * the `ok` result. It is never written into `detail`, `problem`, or `fix`,
 * those are the strings that get logged and shown in error messages.
 */

import { APP_PASSWORD_LABEL, APP_PASSWORD_URL, TWO_STEP_URL } from './setup-plan.js';
import { describeElements, findElement, looksLikeGoogleSignIn, requireElement } from './browser-elements.js';
import type { GoogleBrowserElement, GoogleBrowserPort } from './types.js';

export type AppPasswordReason =
  | 'sign-in-required'
  | 'two-step-required'
  | 'label-already-exists'
  | 'create-form-not-found'
  | 'result-dialog-not-found';

export interface AppPasswordOk {
  readonly kind: 'ok';
  readonly detail: string;
  readonly password: string;
}

export interface AppPasswordNeedsHuman {
  readonly kind: 'needs-human';
  readonly reason: AppPasswordReason;
  readonly problem: string;
  readonly fix: string;
}

export interface AppPasswordFailed {
  readonly kind: 'failed';
  readonly reason: AppPasswordReason;
  readonly problem: string;
  readonly fix: string;
}

export type CreateAppPasswordResult = AppPasswordOk | AppPasswordNeedsHuman | AppPasswordFailed;

export interface CreateAppPasswordOptions {
  readonly label?: string;
  /**
   * Overrides the page navigated to. Defaults to Google's real app-password
   * page. The only legitimate reason to override it is a test driving this
   * flow's real logic against a local fake page instead of a live Google
   * account, production callers never set this.
   */
  readonly pageUrl?: string;
}

function signInNeeded(url: string): AppPasswordNeedsHuman {
  return {
    kind: 'needs-human',
    reason: 'sign-in-required',
    problem: `Google is asking to sign in instead of showing the app-password page (currently at ${url}).`,
    fix: 'Sign in to the Google account by hand in the open browser window, complete any 2-Step Verification prompt, then re-run this step.',
  };
}

/**
 * Text Google shows on the app-password page when 2-Step Verification is not
 * on. Matched loosely because the exact wording was not re-verified live for
 * this change (the automated browser is never pointed at a real Google
 * account in this environment), treat this as best-effort and confirm
 * against a live account before relying on it.
 */
const TWO_STEP_REQUIRED_TEXT =
  /2-step verification[^.]*(is off|required|isn.t (on|enabled))|turn on 2-step verification to (create|use) app passwords|app passwords aren.t available/i;

function twoStepNeeded(): AppPasswordNeedsHuman {
  return {
    kind: 'needs-human',
    reason: 'two-step-required',
    problem: 'This Google account does not have 2-Step Verification on, so Google does not offer app passwords at all.',
    fix: `Open ${TWO_STEP_URL}, turn on 2-Step Verification, then re-run this step.`,
  };
}

function findExistingLabelEntry(elements: readonly GoogleBrowserElement[], label: string): GoogleBrowserElement | null {
  const wanted = label.trim().toLowerCase();
  if (!wanted) return null;
  return elements.find((element) => {
    const name = element.name.trim().toLowerCase();
    return (name.includes('delete') || name.includes('remove')) && name.includes(wanted);
  }) ?? null;
}

function alreadyExists(label: string, pageUrl: string): AppPasswordNeedsHuman {
  return {
    kind: 'needs-human',
    reason: 'label-already-exists',
    problem: `An app password labeled "${label}" is already listed on this page. Google never re-displays an existing app password's value.`,
    fix: `Reuse the app password already stored for "${label}", or delete that entry on ${pageUrl} and re-run this step to create a fresh one.`,
  };
}

/** Google renders the password in four groups of four letters, e.g. "abcd efgh ijkl mnop". */
const RAW_PASSWORD_PATTERN = /\b([A-Za-z]{4})[\s-]([A-Za-z]{4})[\s-]([A-Za-z]{4})[\s-]([A-Za-z]{4})\b/;

function extractPassword(text: string): string | null {
  const match = RAW_PASSWORD_PATTERN.exec(text);
  if (!match) return null;
  return `${match[1]}${match[2]}${match[3]}${match[4]}`;
}

const WAIT_ATTEMPTS = 5;
const WAIT_DELAY_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Creates a Google app password under `label` (default: `APP_PASSWORD_LABEL`).
 * Never throws for any of the three known non-ready states; each is reported
 * as a typed `needs-human` result instead.
 */
export async function createAppPassword(
  browser: GoogleBrowserPort,
  options: CreateAppPasswordOptions = {},
): Promise<CreateAppPasswordResult> {
  const label = options.label ?? APP_PASSWORD_LABEL;
  const pageUrl = options.pageUrl ?? APP_PASSWORD_URL;

  await browser.navigate(pageUrl);
  const url = await browser.currentUrl();
  let elements = await browser.snapshot();

  if (looksLikeGoogleSignIn(url, elements)) {
    return signInNeeded(url);
  }

  const pageText = await browser.readText();
  if (TWO_STEP_REQUIRED_TEXT.test(pageText)) {
    return twoStepNeeded();
  }

  const existingEntry = findExistingLabelEntry(elements, label);
  if (existingEntry) {
    return alreadyExists(label, pageUrl);
  }

  const nameFieldLookup = requireElement(elements, { role: 'textbox', nameIncludes: 'app name' });
  const createButtonLookup = requireElement(elements, { role: 'button', nameIncludes: 'create' });

  // No sign-in prompt, no two-step message, no existing entry, and yet the
  // create form itself is missing, Google most likely disabled the form
  // because 2-Step Verification is off, even though the page text did not
  // match the patterns above.
  if (!nameFieldLookup.found && !createButtonLookup.found) {
    return twoStepNeeded();
  }
  if (!nameFieldLookup.found) {
    return {
      kind: 'failed',
      reason: 'create-form-not-found',
      problem: nameFieldLookup.message,
      fix: `Open ${pageUrl} by hand, type "${label}" into the "App name" field, and click "Create".`,
    };
  }
  if (!createButtonLookup.found) {
    return {
      kind: 'failed',
      reason: 'create-form-not-found',
      problem: createButtonLookup.message,
      fix: `Open ${pageUrl} by hand, type "${label}" into the "App name" field, and click "Create".`,
    };
  }

  await browser.type(nameFieldLookup.element.ref, label);
  await browser.click(createButtonLookup.element.ref);

  let passwordText: string | null = null;
  for (let attempt = 0; attempt < WAIT_ATTEMPTS && !passwordText; attempt += 1) {
    if (attempt > 0) await delay(WAIT_DELAY_MS);
    const text = await browser.readText();
    passwordText = extractPassword(text);
  }

  if (!passwordText) {
    elements = await browser.snapshot();
    return {
      kind: 'failed',
      reason: 'result-dialog-not-found',
      problem: `Clicked "Create" but no 16-character app password could be read back afterward. The page showed ${describeElements(elements)}.`,
      fix: `Open ${pageUrl} by hand, check whether an app password named "${label}" was created, and store it manually if so.`,
    };
  }

  return {
    kind: 'ok',
    detail: `Created an app password labeled "${label}".`,
    password: passwordText,
  };
}

// Re-exported so tests and other flow modules can build fake snapshots that
// exercise the same matching this flow relies on, without duplicating it.
export { findElement };
