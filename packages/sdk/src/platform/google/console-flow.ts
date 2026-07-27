/**
 * Drives the Google Auth Platform console
 * (console.cloud.google.com/auth/audience and .../auth/clients) for the three
 * things the OAuth setup path needs a browser for: reading and changing the
 * publishing status, and creating the Desktop app OAuth client.
 *
 * The publishing-status flows exist because of one verified fact (see
 * google-setup-plan.ts's header comment): an OAuth app left in "Testing"
 * issues refresh tokens that expire after seven days. `publishApp` never
 * reports success from having clicked "PUBLISH APP" — it re-reads the status
 * afterward and only reports success once the re-read confirms the change
 * actually took.
 *
 * The OAuth client's secret is a credential and is returned only in the
 * dedicated `clientSecret` field of the `ok` result — never in `detail`,
 * `problem`, or `fix`.
 */

import { AUTH_AUDIENCE_URL, AUTH_CLIENTS_URL } from './setup-plan.js';
import { findElement, looksLikeGoogleSignIn, requireElement } from './browser-elements.js';
import type { GoogleBrowserPort } from './types.js';

export type PublishingStatus = 'testing' | 'in-production' | 'unknown';

export type ConsoleReason =
  | 'sign-in-required'
  | 'project-not-selected'
  | 'status-not-found'
  | 'publish-button-not-found'
  | 'confirm-dialog-not-found'
  | 'publish-did-not-take'
  | 'publish-status-unreadable'
  | 'client-already-exists'
  | 'create-client-button-not-found'
  | 'application-type-not-found'
  | 'name-field-not-found'
  | 'create-button-not-found'
  | 'credentials-not-readable';

export interface ConsoleNeedsHuman {
  readonly kind: 'needs-human';
  readonly reason: ConsoleReason;
  readonly problem: string;
  readonly fix: string;
}

export interface ConsoleFailed {
  readonly kind: 'failed';
  readonly reason: ConsoleReason;
  readonly problem: string;
  readonly fix: string;
}

export interface ReadPublishingStatusOk {
  readonly kind: 'ok';
  readonly detail: string;
  readonly status: PublishingStatus;
}

export type ReadPublishingStatusResult = ReadPublishingStatusOk | ConsoleNeedsHuman | ConsoleFailed;

export interface PublishAppOk {
  readonly kind: 'ok';
  readonly detail: string;
  readonly status: 'in-production';
}

export type PublishAppResult = PublishAppOk | ConsoleNeedsHuman | ConsoleFailed;

export interface CreateDesktopOAuthClientOptions {
  readonly name: string;
}

export interface CreateOAuthClientOk {
  readonly kind: 'ok';
  readonly detail: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export type CreateDesktopOAuthClientResult = CreateOAuthClientOk | ConsoleNeedsHuman | ConsoleFailed;

function signInNeeded(url: string): ConsoleNeedsHuman {
  return {
    kind: 'needs-human',
    reason: 'sign-in-required',
    problem: `Google is asking to sign in instead of showing the Google Auth Platform console (currently at ${url}).`,
    fix: 'Sign in to the Google account by hand in the open browser window, then re-run this step.',
  };
}

const PROJECT_NOT_SELECTED_TEXT = /select a project|no project selected|create a project to continue|select an existing project/i;

function projectNotSelectedNeeded(): ConsoleNeedsHuman {
  return {
    kind: 'needs-human',
    reason: 'project-not-selected',
    problem: 'The Google Auth Platform console is asking for a Cloud project to be selected before it will show anything.',
    fix: 'Open the Google Cloud console, select or create the project this integration uses, then re-run this step.',
  };
}

/** Order matters: checked before the plain "testing" pattern to avoid a false match on incidental copy. */
function detectPublishingStatus(text: string): PublishingStatus {
  if (/in production/i.test(text)) return 'in-production';
  if (/\btesting\b/i.test(text)) return 'testing';
  return 'unknown';
}

export interface ReadPublishingStatusOptions {
  /**
   * Overrides the page navigated to. Defaults to the real Google Auth
   * Platform audience page. The only legitimate reason to override it is a
   * test driving this flow's real logic against a local fake page instead of
   * a live Google Cloud project — production callers never set this.
   */
  readonly pageUrl?: string;
}

/**
 * Reads the current publishing status from the audience page. Distinguishes
 * "not signed in" and "no project selected" from a genuine read failure.
 */
export async function readPublishingStatus(
  browser: GoogleBrowserPort,
  options: ReadPublishingStatusOptions = {},
): Promise<ReadPublishingStatusResult> {
  const pageUrl = options.pageUrl ?? AUTH_AUDIENCE_URL;
  await browser.navigate(pageUrl);
  const url = await browser.currentUrl();
  const elements = await browser.snapshot();

  if (looksLikeGoogleSignIn(url, elements)) {
    return signInNeeded(url);
  }

  const text = await browser.readText();
  if (PROJECT_NOT_SELECTED_TEXT.test(text)) {
    return projectNotSelectedNeeded();
  }

  const status = detectPublishingStatus(text);
  if (status === 'unknown') {
    return {
      kind: 'failed',
      reason: 'status-not-found',
      problem: 'Looked for the "Publishing status" text ("Testing" or "In production") on the audience page, but could not find either.',
      fix: `Open ${pageUrl} by hand and read the "Publishing status" box.`,
    };
  }

  return {
    kind: 'ok',
    detail: `Publishing status reads "${status === 'in-production' ? 'In production' : 'Testing'}".`,
    status,
  };
}

/**
 * Clicks "PUBLISH APP", confirms the dialog, then re-reads the status to
 * verify it actually changed. Success is reported only from the re-read —
 * never from having clicked.
 */
export async function publishApp(
  browser: GoogleBrowserPort,
  options: ReadPublishingStatusOptions = {},
): Promise<PublishAppResult> {
  const pageUrl = options.pageUrl ?? AUTH_AUDIENCE_URL;
  const before = await readPublishingStatus(browser, options);
  if (before.kind !== 'ok') return before;
  if (before.status === 'in-production') {
    return { kind: 'ok', detail: 'Publishing status was already "In production"; nothing to change.', status: 'in-production' };
  }

  const elements = await browser.snapshot();
  const publishLookup = requireElement(elements, { role: 'button', nameIncludes: 'publish app' });
  if (!publishLookup.found) {
    return {
      kind: 'failed',
      reason: 'publish-button-not-found',
      problem: publishLookup.message,
      fix: `Open ${pageUrl} by hand and click "PUBLISH APP".`,
    };
  }
  await browser.click(publishLookup.element.ref);

  const confirmElements = await browser.snapshot();
  const confirmLookup = requireElement(confirmElements, { role: 'button', nameIncludes: 'confirm' });
  if (!confirmLookup.found) {
    return {
      kind: 'failed',
      reason: 'confirm-dialog-not-found',
      problem: confirmLookup.message,
      fix: 'Click "PUBLISH APP" by hand and confirm the dialog that asks to push the app to production.',
    };
  }
  await browser.click(confirmLookup.element.ref);

  const after = await readPublishingStatus(browser, options);
  if (after.kind === 'ok' && after.status === 'in-production') {
    return {
      kind: 'ok',
      detail: 'Clicked "PUBLISH APP", confirmed the dialog, and the re-read status now shows "In production".',
      status: 'in-production',
    };
  }
  if (after.kind === 'ok' && after.status === 'testing') {
    return {
      kind: 'failed',
      reason: 'publish-did-not-take',
      problem: 'Clicked "PUBLISH APP" and confirmed the dialog, but re-reading the publishing status afterward still shows "Testing". Credentials created while the app stays in Testing will expire after seven days.',
      fix: `Open ${pageUrl} by hand, click "PUBLISH APP" again, confirm the dialog, and check the status box afterward.`,
    };
  }
  if (after.kind === 'ok') {
    // Status read back as neither "In production" nor "Testing" — the page
    // rendered something this flow does not recognise. Reporting the publish
    // as successful here would be exactly the silent lie this step exists to
    // prevent, since an app left in Testing expires its credentials in seven
    // days without ever saying so.
    return {
      kind: 'failed',
      reason: 'publish-status-unreadable',
      problem:
        'Clicked "PUBLISH APP" and confirmed the dialog, but the publishing status could not be read back afterward, so there is no evidence the change took effect.',
      fix: `Open ${pageUrl} by hand and check that the "Publishing status" box reads "In production". If it still reads "Testing", click "PUBLISH APP" and confirm.`,
    };
  }
  return after;
}

const CLIENT_ID_PATTERN = /[\w-]+\.apps\.googleusercontent\.com/;
const CLIENT_SECRET_PATTERN = /GOCSPX-[\w-]+/;

function extractClientCredentials(text: string): { readonly clientId: string; readonly clientSecret: string } | null {
  const idMatch = CLIENT_ID_PATTERN.exec(text);
  const secretMatch = CLIENT_SECRET_PATTERN.exec(text);
  if (!idMatch || !secretMatch) return null;
  return { clientId: idMatch[0], clientSecret: secretMatch[0] };
}

/**
 * Creates a Desktop app OAuth client named `options.name`. Detects a client
 * with that name already existing on the clients page and reports it as
 * `needs-human` instead of creating a duplicate.
 */
export async function createDesktopOAuthClient(
  browser: GoogleBrowserPort,
  options: CreateDesktopOAuthClientOptions,
): Promise<CreateDesktopOAuthClientResult> {
  await browser.navigate(AUTH_CLIENTS_URL);
  const url = await browser.currentUrl();
  let elements = await browser.snapshot();

  if (looksLikeGoogleSignIn(url, elements)) {
    return signInNeeded(url);
  }

  const existing = findElement(elements, { nameIncludes: options.name });
  if (existing) {
    return {
      kind: 'needs-human',
      reason: 'client-already-exists',
      problem: `An OAuth client named "${options.name}" is already listed on the clients page.`,
      fix: 'Reuse the client id and secret already stored for it, or delete that client on the clients page and re-run this step.',
    };
  }

  const createClientLookup = requireElement(elements, { role: 'button', nameIncludes: 'create client' });
  if (!createClientLookup.found) {
    return {
      kind: 'failed',
      reason: 'create-client-button-not-found',
      problem: createClientLookup.message,
      fix: `Open ${AUTH_CLIENTS_URL} by hand and click "CREATE CLIENT".`,
    };
  }
  await browser.click(createClientLookup.element.ref);

  elements = await browser.snapshot();
  const typeLookup = requireElement(elements, { nameIncludes: 'application type' });
  if (!typeLookup.found) {
    return {
      kind: 'failed',
      reason: 'application-type-not-found',
      problem: typeLookup.message,
      fix: 'Click "CREATE CLIENT" by hand and choose "Desktop app" as the application type.',
    };
  }
  await browser.click(typeLookup.element.ref);

  elements = await browser.snapshot();
  const desktopOptionLookup = requireElement(elements, { nameIncludes: 'desktop app' });
  if (!desktopOptionLookup.found) {
    return {
      kind: 'failed',
      reason: 'application-type-not-found',
      problem: desktopOptionLookup.message,
      fix: 'Open the "Application type" dropdown by hand and choose "Desktop app".',
    };
  }
  await browser.click(desktopOptionLookup.element.ref);

  elements = await browser.snapshot();
  const nameLookup = requireElement(elements, { role: 'textbox', nameIncludes: 'name' });
  if (!nameLookup.found) {
    return {
      kind: 'failed',
      reason: 'name-field-not-found',
      problem: nameLookup.message,
      fix: `Type "${options.name}" into the client "Name" field by hand.`,
    };
  }
  await browser.type(nameLookup.element.ref, options.name);

  elements = await browser.snapshot();
  const createButtonLookup = requireElement(elements, { role: 'button', nameIncludes: 'create' });
  if (!createButtonLookup.found) {
    return {
      kind: 'failed',
      reason: 'create-button-not-found',
      problem: createButtonLookup.message,
      fix: 'Click "Create" by hand to finish creating the OAuth client.',
    };
  }
  await browser.click(createButtonLookup.element.ref);

  const resultText = await browser.readText();
  const credentials = extractClientCredentials(resultText);
  if (!credentials) {
    return {
      kind: 'failed',
      reason: 'credentials-not-readable',
      problem: 'Clicked "Create" but the client ID and client secret could not be read back from the result dialog.',
      fix: `Open ${AUTH_CLIENTS_URL} by hand, open the newly created client, and copy the client ID and client secret.`,
    };
  }

  return {
    kind: 'ok',
    detail: `Created a Desktop app OAuth client named "${options.name}".`,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  };
}
