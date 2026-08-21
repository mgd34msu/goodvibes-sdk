/**
 * Minimal CalDAV client over an injectable HTTP transport.
 *
 * Scope
 * ─────
 *   - Principal discovery (PROPFIND `current-user-principal`)
 *   - Calendar home discovery (PROPFIND `calendar-home-set`)
 *   - Calendar collection listing (PROPFIND Depth 1, filtered to `calendar`
 *     resourcetypes)
 *   - Event listing via `calendar-query` REPORT with a VEVENT time-range
 *     filter
 *   - `discover()`, a convenience that chains all three discovery steps
 *
 * Every method returns a typed, discriminated result, `{ ok: true, ... }`
 * or `{ ok: false, problem, fix }`, instead of throwing on HTTP-level or
 * protocol-level failure. Exceptions are reserved for programmer error
 * (e.g. passing a non-URL string where a URL is required is still handled
 * defensively below rather than thrown, since a live server address is
 * exactly the kind of input that can be malformed).
 *
 * Credentials are never included in a returned value, an error message, or
 * a log line anywhere in this module, failures are described in plain
 * language keyed off the HTTP status code only.
 *
 * Transport injection
 * ────────────────────
 * All I/O goes through `CalDavHttpPort`, injected at construction. The only
 * place real network I/O happens is `createFetchCalDavHttpPort()` below,
 * which wraps the global `fetch`. Tests supply a fake port (or drive the
 * real fetch-backed port against an in-process HTTP server).
 */

import { isCalendarResourceType, parseCalendarDataEvents, parseMultistatus, type CalDavEventRecord } from './caldav-parse.js';

// ---------------------------------------------------------------------------
// Transport port
// ---------------------------------------------------------------------------

export interface CalDavHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface CalDavHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface CalDavHttpPort {
  request(input: CalDavHttpRequest): Promise<CalDavHttpResponse>;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type CalDavAuth =
  | { readonly kind: 'basic'; readonly username: string; readonly password: string }
  | { readonly kind: 'bearer'; readonly accessToken: string };

function buildAuthHeader(auth: CalDavAuth): string {
  if (auth.kind === 'basic') {
    const token = Buffer.from(`${auth.username}:${auth.password}`, 'utf-8').toString('base64');
    return `Basic ${token}`;
  }
  return `Bearer ${auth.accessToken}`;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** A plain-language, credential-free failure: what went wrong and what to do about it. */
export interface CalDavProblem {
  readonly problem: string;
  readonly fix: string;
}

export type CalDavResult<T> = ({ readonly ok: true } & T) | ({ readonly ok: false } & CalDavProblem);

export interface CalDavCalendar {
  readonly href: string;
  readonly displayName: string;
  readonly etag?: string;
}

export interface CalDavListedEvent extends CalDavEventRecord {
  readonly href: string;
  readonly etag?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classifies an HTTP status into a plain-language problem, or `null` when the
 * status is a CalDAV success (200-series or 207 Multi-Status).
 */
function classifyHttpFailure(status: number): CalDavProblem | null {
  if (status === 207 || (status >= 200 && status < 300)) return null;
  if (status === 401) {
    return { problem: 'the server rejected the credentials (401)', fix: 'check the account username/password or access token and try again' };
  }
  if (status === 403) {
    return { problem: 'the server denied access to this calendar resource (403)', fix: 'confirm the account has permission to access this calendar' };
  }
  if (status === 404) {
    return { problem: 'the requested calendar resource was not found (404)', fix: 'confirm the server address and calendar path are correct' };
  }
  if (status >= 500) {
    return { problem: `the calendar server returned an error (${status})`, fix: 'try again later or contact the calendar server administrator' };
  }
  return { problem: `the server returned an unexpected response (${status})`, fix: 'confirm the server address is a valid CalDAV endpoint' };
}

/**
 * Resolves a `<href>` value returned by the server against the ORIGIN of the
 * request URL, not the full request URL. CalDAV hrefs come back as absolute
 * paths from the server root (e.g. "/calendars/me/personal/"); resolving
 * them against a request URL that itself has a path (e.g.
 * "https://host/dav/principals/me/") would otherwise risk concatenating the
 * two paths together. `new URL(href, origin + '/')` treats the base as
 * having no path at all, so both absolute-path hrefs and the rare relative
 * one resolve the same way a browser would from the server root.
 */
function resolveHref(href: string, requestUrl: string): string {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const origin = new URL(requestUrl).origin;
    return new URL(trimmed, `${origin}/`).toString();
  } catch {
    return trimmed;
  }
}

function formatCalDavUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

const PROPFIND_CURRENT_USER_PRINCIPAL_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal/>
  </d:prop>
</d:propfind>`;

const PROPFIND_CALENDAR_HOME_SET_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-home-set/>
  </d:prop>
</d:propfind>`;

const PROPFIND_LIST_CALENDARS_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:getetag/>
  </d:prop>
</d:propfind>`;

function buildCalendarQueryBody(start: Date, end: Date): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${formatCalDavUtc(start)}" end="${formatCalDavUtc(end)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface CalDavClientOptions {
  readonly http: CalDavHttpPort;
  readonly auth: CalDavAuth;
}

export class CalDavClient {
  private readonly http: CalDavHttpPort;
  private readonly auth: CalDavAuth;

  constructor(options: CalDavClientOptions) {
    this.http = options.http;
    this.auth = options.auth;
  }

  /** PROPFIND Depth 0 for `current-user-principal`. */
  public async discoverPrincipal(baseUrl: string): Promise<CalDavResult<{ readonly principalUrl: string }>> {
    const sent = await this.send('PROPFIND', baseUrl, PROPFIND_CURRENT_USER_PRINCIPAL_BODY, '0');
    if (!sent.ok) return sent;
    const entries = parseMultistatus(sent.body);
    for (const entry of entries) {
      const raw = entry.props['current-user-principal'];
      if (raw) return { ok: true, principalUrl: resolveHref(raw, baseUrl) };
    }
    return {
      ok: false,
      problem: 'the server response did not include a current-user-principal',
      fix: 'confirm the base URL is a valid CalDAV endpoint for this account',
    };
  }

  /** PROPFIND Depth 0 for `calendar-home-set`. */
  public async discoverCalendarHome(principalUrl: string): Promise<CalDavResult<{ readonly homeUrl: string }>> {
    const sent = await this.send('PROPFIND', principalUrl, PROPFIND_CALENDAR_HOME_SET_BODY, '0');
    if (!sent.ok) return sent;
    const entries = parseMultistatus(sent.body);
    for (const entry of entries) {
      const raw = entry.props['calendar-home-set'];
      if (raw) return { ok: true, homeUrl: resolveHref(raw, principalUrl) };
    }
    return {
      ok: false,
      problem: 'the server response did not include a calendar-home-set',
      fix: 'confirm the account principal supports CalDAV calendars',
    };
  }

  /** PROPFIND Depth 1, returning collections whose resourcetype includes `calendar`. */
  public async listCalendars(homeUrl: string): Promise<CalDavResult<{ readonly calendars: readonly CalDavCalendar[] }>> {
    const sent = await this.send('PROPFIND', homeUrl, PROPFIND_LIST_CALENDARS_BODY, '1');
    if (!sent.ok) return sent;
    const entries = parseMultistatus(sent.body);
    const calendars: CalDavCalendar[] = [];
    for (const entry of entries) {
      if (!entry.href || !isCalendarResourceType(entry.props['resourcetype'])) continue;
      calendars.push({
        href: resolveHref(entry.href, homeUrl),
        displayName: entry.props['displayname'] ?? '',
        ...(entry.props['getetag'] !== undefined ? { etag: entry.props['getetag'] } : {}),
      });
    }
    return { ok: true, calendars };
  }

  /** `calendar-query` REPORT with a VEVENT time-range filter. */
  public async listEvents(
    calendarUrl: string,
    range: { readonly start: Date; readonly end: Date },
  ): Promise<CalDavResult<{ readonly events: readonly CalDavListedEvent[] }>> {
    const sent = await this.send('REPORT', calendarUrl, buildCalendarQueryBody(range.start, range.end), '1');
    if (!sent.ok) return sent;
    const entries = parseMultistatus(sent.body);
    const events: CalDavListedEvent[] = [];
    for (const entry of entries) {
      const calendarData = entry.props['calendar-data'];
      if (!calendarData) continue;
      const href = resolveHref(entry.href, calendarUrl);
      for (const record of parseCalendarDataEvents(calendarData)) {
        events.push({
          ...record,
          href,
          ...(entry.props['getetag'] !== undefined ? { etag: entry.props['getetag'] } : {}),
        });
      }
    }
    return { ok: true, events };
  }

  /** Convenience: principal → calendar home → calendars, in one call. */
  public async discover(baseUrl: string): Promise<
    CalDavResult<{
      readonly principalUrl: string;
      readonly homeUrl: string;
      readonly calendars: readonly CalDavCalendar[];
    }>
  > {
    const principal = await this.discoverPrincipal(baseUrl);
    if (!principal.ok) return principal;
    const home = await this.discoverCalendarHome(principal.principalUrl);
    if (!home.ok) return home;
    const calendars = await this.listCalendars(home.homeUrl);
    if (!calendars.ok) return calendars;
    return {
      ok: true,
      principalUrl: principal.principalUrl,
      homeUrl: home.homeUrl,
      calendars: calendars.calendars,
    };
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Sends one PROPFIND/REPORT request and classifies the outcome. Returns
   * `{ ok: true, body }` on a CalDAV-successful response, or a
   * `{ ok: false, problem, fix }` result for both transport failures (the
   * request never completed) and HTTP-level failures (it completed with a
   * non-2xx/207 status), the caller never has to distinguish the two.
   */
  private async send(
    method: string,
    url: string,
    body: string,
    depth: '0' | '1',
  ): Promise<CalDavResult<{ readonly body: string }>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/xml; charset=utf-8',
      Depth: depth,
      Authorization: buildAuthHeader(this.auth),
    };
    let response: CalDavHttpResponse;
    try {
      response = await this.http.request({ method, url, headers, body });
    } catch (error) {
      return {
        ok: false,
        problem: `could not reach the calendar server: ${describeError(error)}`,
        fix: 'check the server address and the network connection',
      };
    }
    const failure = classifyHttpFailure(response.status);
    if (failure) return { ok: false, ...failure };
    return { ok: true, body: response.body };
  }
}
