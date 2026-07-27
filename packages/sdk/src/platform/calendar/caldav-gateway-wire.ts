/**
 * caldav-gateway-wire.ts — the CalDAV requests the gateway verbs make, and the
 * one place their failures become honest statuses.
 *
 * Transport is `CalDavHttpPort`, the port the hoisted CalDAV client already
 * defines (`platform/google/caldav-client.ts`), so the same injected adapter —
 * the fetch-backed one in `platform/google/node.ts`, or a fake — drives both.
 * Nothing here opens a socket.
 *
 * What a caller sees on failure is deliberately thin: `CalDAV server returned
 * HTTP 401.` and nothing else. The base URL, the account name, the credential
 * and the raw transport error (`getaddrinfo ENOTFOUND cal.example.com`, which
 * names the host) all stay inside this module — `calendar.ics.import` returns
 * per-event error strings straight to the caller, so anything this layer puts
 * in a message is a string that travels.
 */

import { GatewayVerbError } from '../control-plane/routes/gateway-verb-error.js';
import type { CalDavHttpPort } from '../google/caldav-client.js';

export interface CalDavWireResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Format an ISO-8601 instant as a CalDAV UTC stamp (YYYYMMDDTHHMMSSZ) for a
 * time-range filter. An unparseable value is the caller's mistake and says so.
 */
export function toCalDavStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new GatewayVerbError(`Invalid date range value: ${iso}`, 'CALENDAR_BAD_RANGE', 400);
  }
  const pad = (n: number): string => (n < 10 ? `0${String(n)}` : String(n));
  return (
    `${String(date.getUTCFullYear())}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** `calendar-query` REPORT body, optionally bounded by a time range. */
export function calendarQueryBody(from?: string, to?: string): string {
  const timeFilter = from || to
    ? `<C:time-range${from ? ` start="${toCalDavStamp(from)}"` : ''}${to ? ` end="${toCalDavStamp(to)}"` : ''}/>`
    : '';
  return [
    '<?xml version="1.0" encoding="utf-8" ?>',
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
    '  <D:prop>',
    '    <D:getetag/>',
    '    <C:calendar-data/>',
    '  </D:prop>',
    '  <C:filter>',
    '    <C:comp-filter name="VCALENDAR">',
    `      <C:comp-filter name="VEVENT">${timeFilter}</C:comp-filter>`,
    '    </C:comp-filter>',
    '  </C:filter>',
    '</C:calendar-query>',
  ].join('\n');
}

/**
 * A `calendar-query` REPORT that matches ONE VEVENT by UID, server-side.
 *
 * The server does the matching, so a UID lookup costs one resource on the wire
 * instead of the whole collection — and, more importantly, cannot silently miss
 * an event that a truncated unfiltered listing would have cut off.
 */
export function calendarQueryByUidBody(uid: string): string {
  // Escape XML metacharacters in the UID before embedding it in the filter.
  const safeUid = uid
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return [
    '<?xml version="1.0" encoding="utf-8" ?>',
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
    '  <D:prop>',
    '    <D:getetag/>',
    '    <C:calendar-data/>',
    '  </D:prop>',
    '  <C:filter>',
    '    <C:comp-filter name="VCALENDAR">',
    '      <C:comp-filter name="VEVENT">',
    `        <C:prop-filter name="UID"><C:text-match collation="i;octet">${safeUid}</C:text-match></C:prop-filter>`,
    '      </C:comp-filter>',
    '    </C:comp-filter>',
    '  </C:filter>',
    '</C:calendar-query>',
  ].join('\n');
}

/** PROPFIND body listing the collections under a calendar home. */
export function propfindCalendarsBody(): string {
  return [
    '<?xml version="1.0" encoding="utf-8" ?>',
    '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
    '  <D:prop>',
    '    <D:displayname/>',
    '    <D:resourcetype/>',
    '  </D:prop>',
    '</D:propfind>',
  ].join('\n');
}

/** One authenticated CalDAV request. */
export type CalDavRequest = (
  url: string,
  method: string,
  body?: string,
  extraHeaders?: Readonly<Record<string, string>>,
) => Promise<CalDavWireResponse>;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64 of the UTF-8 bytes of a string, written out rather than reached for.
 *
 * Node's byte-array type would be one line of this, and is what the CalDAV
 * client elsewhere uses — but `platform/calendar` is runtime-neutral by rule,
 * and a test reads these files to keep it that way (no node builtins, no bare
 * import specifiers, nothing runtime-specific). `btoa` is the other one-liner
 * and it is wrong for exactly the input that matters here: a password with a
 * non-ASCII character. So the bytes come from `TextEncoder` and are encoded
 * below.
 */
function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const triple = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += BASE64_ALPHABET[(triple >> 18) & 63] ?? '';
    out += BASE64_ALPHABET[(triple >> 12) & 63] ?? '';
    out += b1 === undefined ? '=' : BASE64_ALPHABET[(triple >> 6) & 63] ?? '';
    out += b2 === undefined ? '=' : BASE64_ALPHABET[triple & 63] ?? '';
  }
  return out;
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${base64Utf8(`${username}:${password}`)}`;
}

/**
 * Bind an HTTP port and a credential into a request function that speaks
 * CalDAV and reports failure as a `GatewayVerbError`.
 *
 * Status mapping, unchanged from the surface this replaces: 401/403 are
 * `CALENDAR_AUTH_FAILED`, 404 is `CALENDAR_NOT_FOUND`, any other 4xx keeps its
 * own status under `CALENDAR_REQUEST_FAILED`, and anything else (including a
 * 5xx from the calendar server) is reported as a 502 — the daemon is not the
 * thing that failed.
 */
export function createCalDavRequest(
  http: CalDavHttpPort,
  credential: { readonly username: string; readonly password: string },
): CalDavRequest {
  const authorization = basicAuthHeader(credential.username, credential.password);
  return async (url, method, body, extraHeaders) => {
    let response: CalDavWireResponse;
    try {
      response = await http.request({
        method,
        url,
        headers: {
          Authorization: authorization,
          ...(body !== undefined
            ? {
                'Content-Type': method === 'PUT'
                  ? 'text/calendar; charset=utf-8'
                  : 'application/xml; charset=utf-8',
              }
            : {}),
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      // Redacted for the same reason as the HTTP-status branch below: a raw
      // transport error names the calendar host, and these messages reach a
      // caller verbatim through `calendar.ics.import`'s errors[].
      throw new GatewayVerbError('CalDAV request failed: network error.', 'CALENDAR_NETWORK_ERROR', 502);
    }
    const status = response.status;
    if (status < 200 || status >= 300) {
      const code = status === 401 || status === 403
        ? 'CALENDAR_AUTH_FAILED'
        : status === 404
          ? 'CALENDAR_NOT_FOUND'
          : 'CALENDAR_REQUEST_FAILED';
      throw new GatewayVerbError(
        `CalDAV server returned HTTP ${String(status)}.`,
        code,
        status >= 400 && status < 500 ? status : 502,
      );
    }
    return response;
  };
}

/** Case-insensitive header lookup — header casing is the server's choice, not ours. */
export function readHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}
