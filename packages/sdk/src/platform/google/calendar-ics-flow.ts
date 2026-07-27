/**
 * Drives Google Calendar's settings page
 * (https://calendar.google.com/calendar/u/0/r/settings) to capture a
 * calendar's private iCal address.
 *
 * The address is a credential: anyone holding it can read the calendar. It is
 * therefore returned only in the dedicated `icsUrl` field of the `ok` result
 * and never appears in `detail`, `problem`, or `fix` — not even a truncated or
 * partially-redacted form, since even a fragment plus the known URL shape
 * meaningfully narrows the secret.
 */

import { CALENDAR_SETTINGS_URL } from './setup-plan.js';
import { describeElements, looksLikeGoogleSignIn, requireElement } from './browser-elements.js';
import type { GoogleBrowserElement, GoogleBrowserPort } from './types.js';

export type CalendarIcsReason =
  | 'sign-in-required'
  | 'calendar-not-found'
  | 'integrate-panel-not-found'
  | 'ics-address-not-found'
  | 'ics-address-malformed';

export interface CalendarIcsOk {
  readonly kind: 'ok';
  readonly detail: string;
  readonly icsUrl: string;
}

export interface CalendarIcsNeedsHuman {
  readonly kind: 'needs-human';
  readonly reason: CalendarIcsReason;
  readonly problem: string;
  readonly fix: string;
}

export interface CalendarIcsFailed {
  readonly kind: 'failed';
  readonly reason: CalendarIcsReason;
  readonly problem: string;
  readonly fix: string;
}

export type CaptureIcsAddressResult = CalendarIcsOk | CalendarIcsNeedsHuman | CalendarIcsFailed;

export interface CaptureIcsAddressOptions {
  /** When omitted, the first calendar entry in the settings panel is used. */
  readonly calendarName?: string;
}

function signInNeeded(url: string): CalendarIcsNeedsHuman {
  return {
    kind: 'needs-human',
    reason: 'sign-in-required',
    problem: `Google is asking to sign in instead of showing the calendar settings page (currently at ${url}).`,
    fix: 'Sign in to the Google account by hand in the open browser window, then re-run this step.',
  };
}

/**
 * Labels that appear in the calendar settings left panel alongside the
 * calendar list itself (section headers and unrelated nav items), so the
 * "pick the first calendar" heuristic below does not grab one of these
 * instead of an actual calendar. This list is a best-effort guess at Google's
 * current copy, not something verified against a live account in this change.
 */
const NON_CALENDAR_LABELS = new Set([
  'general',
  'add calendar',
  'import & export',
  'settings for my calendars',
  'other calendars',
  'event settings',
  'view options',
  'accessibility',
]);

function isCalendarEntry(element: GoogleBrowserElement): boolean {
  if (element.role !== 'link' && element.role !== 'button') return false;
  const normalized = element.name.trim().toLowerCase();
  return normalized.length > 0 && !NON_CALENDAR_LABELS.has(normalized);
}

function findDefaultCalendar(elements: readonly GoogleBrowserElement[]): GoogleBrowserElement | null {
  return elements.find(isCalendarEntry) ?? null;
}

/** Google's private iCal address shape, per the calendar CalDAV/iCal guide. */
const ICS_URL_PATTERN = /https:\/\/calendar\.google\.com\/calendar\/ical\/[^/\s]+\/private-[A-Za-z0-9]+\/basic\.ics/;

function findIcsUrl(text: string, elements: readonly GoogleBrowserElement[]): string | null {
  const fromText = ICS_URL_PATTERN.exec(text);
  if (fromText) return fromText[0];
  for (const element of elements) {
    const fromName = ICS_URL_PATTERN.exec(element.name);
    if (fromName) return fromName[0];
    if (element.value) {
      const fromValue = ICS_URL_PATTERN.exec(element.value);
      if (fromValue) return fromValue[0];
    }
  }
  return null;
}

/**
 * A value that looks address-shaped but does not match Google's private iCal
 * URL shape. Only used to decide which failure reason to report — the actual
 * candidate text is never carried into a message, since a near-miss can still
 * be sensitive.
 */
const ADDRESS_LIKE_PATTERN = /https:\/\/calendar\.google\.com\/calendar\/ical\/\S+/;

/**
 * Captures the private iCal address for one calendar. Never throws for
 * sign-in-needed or a missing calendar/panel; those come back as typed
 * results.
 */
export async function captureIcsAddress(
  browser: GoogleBrowserPort,
  options: CaptureIcsAddressOptions = {},
): Promise<CaptureIcsAddressResult> {
  await browser.navigate(CALENDAR_SETTINGS_URL);
  const url = await browser.currentUrl();
  let elements = await browser.snapshot();

  if (looksLikeGoogleSignIn(url, elements)) {
    return signInNeeded(url);
  }

  const calendarElement = options.calendarName
    ? (() => {
        const lookup = requireElement(elements, { nameIncludes: options.calendarName });
        return lookup.found ? lookup.element : null;
      })()
    : findDefaultCalendar(elements);

  if (!calendarElement) {
    return {
      kind: 'failed',
      reason: 'calendar-not-found',
      problem: options.calendarName
        ? `Looked for a calendar named "${options.calendarName}" in the settings panel, but the page showed ${describeElements(elements)}.`
        : `Could not find any calendar entry in the settings panel. The page showed ${describeElements(elements)}.`,
      fix: `Open ${CALENDAR_SETTINGS_URL} by hand, click the calendar you want under "Settings for my calendars", click "Integrate calendar", and copy the address under "Secret address in iCal format".`,
    };
  }

  await browser.click(calendarElement.ref);
  elements = await browser.snapshot();

  const integrateLookup = requireElement(elements, { nameIncludes: 'integrate calendar' });
  if (!integrateLookup.found) {
    return {
      kind: 'failed',
      reason: 'integrate-panel-not-found',
      problem: integrateLookup.message,
      fix: 'Open that calendar\'s settings by hand and click "Integrate calendar".',
    };
  }

  await browser.click(integrateLookup.element.ref);
  elements = await browser.snapshot();
  const text = await browser.readText();

  const icsUrl = findIcsUrl(text, elements);
  if (icsUrl) {
    return {
      kind: 'ok',
      detail: "Captured the calendar's private iCal address from the \"Integrate calendar\" panel.",
      icsUrl,
    };
  }

  const addressLike = ADDRESS_LIKE_PATTERN.test(text) || elements.some((element) => ADDRESS_LIKE_PATTERN.test(element.name) || (element.value ? ADDRESS_LIKE_PATTERN.test(element.value) : false));
  return {
    kind: 'failed',
    reason: addressLike ? 'ics-address-malformed' : 'ics-address-not-found',
    problem: addressLike
      ? "Found a calendar.google.com/calendar/ical/ value on the page, but it did not match Google's expected private iCal URL shape (…/private-<token>/basic.ics)."
      : 'Could not find the "Secret address in iCal format" value on the "Integrate calendar" panel.',
    fix: 'Open "Integrate calendar" for this calendar by hand and copy the address under "Secret address in iCal format".',
  };
}
