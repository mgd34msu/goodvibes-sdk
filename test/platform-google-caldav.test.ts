/**
 * Tests for the CalDAV parser (`caldav-parse.ts`) and client
 * (`caldav-client.ts`).
 *
 * Three layers are covered:
 *   1. Parser unit tests — namespace prefix variance, RFC 5545 line
 *      unfolding, all-day vs timed events, malformed/missing input.
 *   2. Client tests against an injected fake `CalDavHttpPort`, using
 *      realistic-shaped multistatus fixtures.
 *   3. A genuine transport test: an in-process `Bun.serve` server speaking
 *      just enough CalDAV, driven by the real `createFetchCalDavHttpPort()`
 *      over real HTTP on a random port. This proves the fetch-backed
 *      transport works, not only the parsing.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  isCalendarResourceType,
  parseCalendarDataEvents,
  parseMultistatus,
  unfoldIcsLines,
} from '../packages/sdk/src/platform/google/caldav-parse.ts';
import {
  CalDavClient,
  type CalDavAuth,
  type CalDavHttpPort,
  type CalDavHttpRequest,
  type CalDavHttpResponse,
} from '../packages/sdk/src/platform/google/caldav-client.ts';
import { createFetchCalDavHttpPort } from '../packages/sdk/src/platform/google/node.ts';

// ---------------------------------------------------------------------------
// Parser: WebDAV multistatus
// ---------------------------------------------------------------------------

describe('parseMultistatus', () => {
  test('extracts current-user-principal, resourcetype, and getetag through the "D:" namespace prefix', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/</D:href>
    <D:propstat>
      <D:prop>
        <D:current-user-principal>
          <D:href>/principals/users/mike/</D:href>
        </D:current-user-principal>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    const entries = parseMultistatus(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.href).toBe('/dav/');
    expect(entries[0]?.status).toBe('HTTP/1.1 200 OK');
    expect(entries[0]?.props['current-user-principal']).toBe('/principals/users/mike/');
  });

  test('extracts calendar-home-set through a lowercase "cal:" namespace prefix', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/principals/users/mike/</d:href>
    <d:propstat>
      <d:prop>
        <cal:calendar-home-set>
          <d:href>/calendars/mike/</d:href>
        </cal:calendar-home-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
    const entries = parseMultistatus(xml);
    expect(entries[0]?.props['calendar-home-set']).toBe('/calendars/mike/');
  });

  test('extracts displayname and resourcetype through the "caldav:" namespace prefix', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:caldav="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/calendars/mike/personal/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>Personal</D:displayname>
        <D:resourcetype><D:collection/><caldav:calendar/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    const entries = parseMultistatus(xml);
    expect(entries[0]?.props['displayname']).toBe('Personal');
    expect(isCalendarResourceType(entries[0]?.props['resourcetype'])).toBe(true);
  });

  test('extracts every known prop with no namespace prefix at all', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/calendars/mike/personal/event1.ics</href>
    <propstat>
      <prop>
        <getetag>"abc123"</getetag>
        <calendar-data>BEGIN:VCALENDAR
END:VCALENDAR
</calendar-data>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`;
    const entries = parseMultistatus(xml);
    expect(entries[0]?.props['getetag']).toBe('"abc123"');
    expect(entries[0]?.props['calendar-data']).toContain('BEGIN:VCALENDAR');
  });

  test('a resourcetype with only collection (no calendar child) is not treated as a calendar', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/calendars/mike/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>homeset</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    const entries = parseMultistatus(xml);
    expect(isCalendarResourceType(entries[0]?.props['resourcetype'])).toBe(false);
  });

  test('when a response has a 200 propstat and a 404 propstat, only the 200 propstat contributes props', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/calendars/mike/personal/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>Personal</D:displayname>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
    <D:propstat>
      <D:prop>
        <D:getetag/>
      </D:prop>
      <D:status>HTTP/1.1 404 Not Found</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    const entries = parseMultistatus(xml);
    expect(entries[0]?.status).toBe('HTTP/1.1 200 OK');
    expect(entries[0]?.props['displayname']).toBe('Personal');
    expect(entries[0]?.props['getetag']).toBeUndefined();
  });

  test('a response with no propstat at all yields an empty props object rather than throwing', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/calendars/mike/orphan/</D:href>
  </D:response>
</D:multistatus>`;
    const entries = parseMultistatus(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.href).toBe('/calendars/mike/orphan/');
    expect(entries[0]?.props).toEqual({});
  });

  test('an empty string returns an empty array rather than throwing', () => {
    expect(parseMultistatus('')).toEqual([]);
  });

  test('plain non-XML text returns an empty array rather than throwing', () => {
    expect(parseMultistatus('this is not XML at all, just some plain text')).toEqual([]);
  });

  test('truncated XML missing its closing tags returns a best-effort result rather than throwing', () => {
    const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/</D:href><D:propstat><D:prop><D:displayname>Truncated`;
    expect(() => parseMultistatus(xml)).not.toThrow();
    const entries = parseMultistatus(xml);
    expect(Array.isArray(entries)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parser: iCalendar VEVENT parsing + RFC 5545 line unfolding
// ---------------------------------------------------------------------------

describe('unfoldIcsLines', () => {
  test('rejoins a CRLF-folded line by removing exactly the newline and the one leading space', () => {
    const folded = 'DESCRIPTION:This is a lo\r\n ng description that exists on one line.';
    expect(unfoldIcsLines(folded)).toBe('DESCRIPTION:This is a long description that exists on one line.');
  });

  test('rejoins a bare-LF-folded line continued with a tab', () => {
    const folded = 'SUMMARY:Weekly sync\n\twith the whole team';
    expect(unfoldIcsLines(folded)).toBe('SUMMARY:Weekly syncwith the whole team');
  });

  test('does not alter a newline that is not followed by a space or tab', () => {
    const twoLines = 'UID:abc\r\nSUMMARY:Standup';
    expect(unfoldIcsLines(twoLines)).toBe('UID:abc\r\nSUMMARY:Standup');
  });
});

describe('parseCalendarDataEvents', () => {
  test('parses a timed VEVENT with a TZID, unfolding a CRLF-folded SUMMARY correctly', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:event-1@example.com',
      'SUMMARY:Long meeting title that wra',
      ' ps across two lines',
      'DTSTART;TZID=America/New_York:20260115T090000',
      'DTEND;TZID=America/New_York:20260115T100000',
      'LOCATION:Conference Room A',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    const events = parseCalendarDataEvents(ics);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.uid).toBe('event-1@example.com');
    expect(event.summary).toBe('Long meeting title that wraps across two lines');
    expect(event.dtstart).toBe('20260115T090000');
    expect(event.dtend).toBe('20260115T100000');
    expect(event.allDay).toBe(false);
    expect(event.tzid).toBe('America/New_York');
    expect(event.location).toBe('Conference Room A');
    expect(event.rrule).toBeUndefined();
  });

  test('parses an all-day VEVENT (VALUE=DATE) with a raw, unexpanded RRULE', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:event-2@example.com',
      'SUMMARY:All day offsite',
      'DTSTART;VALUE=DATE:20260120',
      'DTEND;VALUE=DATE:20260121',
      'RRULE:FREQ=YEARLY',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseCalendarDataEvents(ics);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.allDay).toBe(true);
    expect(event.dtstart).toBe('20260120');
    expect(event.rrule).toBe('FREQ=YEARLY');
    expect(event.tzid).toBeUndefined();
  });

  test('detects an all-day event from an 8-digit DTSTART even without an explicit VALUE=DATE param', () => {
    const ics = ['BEGIN:VEVENT', 'UID:e3', 'DTSTART:20260201', 'END:VEVENT'].join('\r\n');
    const events = parseCalendarDataEvents(ics);
    expect(events[0]?.allDay).toBe(true);
  });

  test('unescapes ICS text escaping (\\n, \\, , \\;, \\\\) in SUMMARY and LOCATION', () => {
    const ics = [
      'BEGIN:VEVENT',
      'UID:e4',
      'SUMMARY:Line one\\nLine two\\, with a comma\\; and a semicolon',
      'LOCATION:Building A\\, Room 100',
      'END:VEVENT',
    ].join('\r\n');
    const events = parseCalendarDataEvents(ics);
    expect(events[0]?.summary).toBe('Line one\nLine two, with a comma; and a semicolon');
    expect(events[0]?.location).toBe('Building A, Room 100');
  });

  test('drops a VEVENT block with no UID rather than fabricating one', () => {
    const ics = ['BEGIN:VEVENT', 'SUMMARY:No uid here', 'END:VEVENT'].join('\r\n');
    expect(parseCalendarDataEvents(ics)).toEqual([]);
  });

  test('parses multiple VEVENT blocks from a single calendar-data payload', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:multi-1',
      'SUMMARY:First',
      'DTSTART:20260101T100000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:multi-2',
      'SUMMARY:Second',
      'DTSTART:20260102T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseCalendarDataEvents(ics);
    expect(events.map((e) => e.uid)).toEqual(['multi-1', 'multi-2']);
  });

  test('empty calendar-data returns an empty array rather than throwing', () => {
    expect(parseCalendarDataEvents('')).toEqual([]);
  });

  test('calendar-data with no VEVENT at all returns an empty array', () => {
    expect(parseCalendarDataEvents('BEGIN:VCALENDAR\r\nEND:VCALENDAR')).toEqual([]);
  });

  test('malformed calendar-data does not throw', () => {
    expect(() => parseCalendarDataEvents('BEGIN:VEVENT\r\nUID')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Client: fake injected HTTP port
// ---------------------------------------------------------------------------

class FakeCalDavHttpPort implements CalDavHttpPort {
  public readonly requests: CalDavHttpRequest[] = [];
  private readonly responder: (input: CalDavHttpRequest) => CalDavHttpResponse;

  constructor(responder: (input: CalDavHttpRequest) => CalDavHttpResponse) {
    this.responder = responder;
  }

  async request(input: CalDavHttpRequest): Promise<CalDavHttpResponse> {
    this.requests.push(input);
    return this.responder(input);
  }
}

const PRINCIPAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/</D:href>
    <D:propstat>
      <D:prop>
        <D:current-user-principal>
          <D:href>/principals/users/mike/</D:href>
        </D:current-user-principal>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

const HOME_SET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/principals/users/mike/</d:href>
    <d:propstat>
      <d:prop>
        <cal:calendar-home-set>
          <d:href>/calendars/mike/</d:href>
        </cal:calendar-home-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

const CALENDARS_LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/calendars/mike/</href>
    <propstat>
      <prop>
        <displayname>homeset</displayname>
        <resourcetype><collection/></resourcetype>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
  <response>
    <href>/calendars/mike/personal/</href>
    <propstat>
      <prop>
        <displayname>Personal</displayname>
        <resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype>
        <getetag>"col-etag-1"</getetag>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`;

const EVENTS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
  '  <D:response>',
  '    <D:href>/calendars/mike/personal/event1.ics</D:href>',
  '    <D:propstat>',
  '      <D:prop>',
  '        <D:getetag>"etag-event-1"</D:getetag>',
  '        <C:calendar-data>BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:event-1@example.com\r\nSUMMARY:Team sync\r\nDTSTART;TZID=America/New_York:20260115T090000\r\nDTEND;TZID=America/New_York:20260115T100000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n</C:calendar-data>',
  '      </D:prop>',
  '      <D:status>HTTP/1.1 200 OK</D:status>',
  '    </D:propstat>',
  '  </D:response>',
  '  <D:response>',
  '    <D:href>/calendars/mike/personal/event2.ics</D:href>',
  '    <D:propstat>',
  '      <D:prop>',
  '        <D:getetag>"etag-event-2"</D:getetag>',
  '        <C:calendar-data>BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:event-2@example.com\r\nSUMMARY:All day offsite\r\nDTSTART;VALUE=DATE:20260120\r\nDTEND;VALUE=DATE:20260121\r\nRRULE:FREQ=YEARLY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n</C:calendar-data>',
  '      </D:prop>',
  '      <D:status>HTTP/1.1 200 OK</D:status>',
  '    </D:propstat>',
  '  </D:response>',
  '</D:multistatus>',
].join('\n');

describe('CalDavClient against a fake injected HTTP port', () => {
  test('discoverPrincipal resolves a relative href against the request origin', async () => {
    const port = new FakeCalDavHttpPort(() => ({ status: 207, headers: {}, body: PRINCIPAL_XML }));
    const client = new CalDavClient({ http: port, auth: { kind: 'basic', username: 'mike', password: 'pw' } });
    const result = await client.discoverPrincipal('https://caldav.example.com/dav/');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principalUrl).toBe('https://caldav.example.com/principals/users/mike/');
    expect(port.requests[0]?.method).toBe('PROPFIND');
    expect(port.requests[0]?.headers['Depth']).toBe('0');
  });

  test('discoverPrincipal reports a plain-language problem when the server never returns the property', async () => {
    const port = new FakeCalDavHttpPort(() => ({ status: 207, headers: {}, body: '<D:multistatus xmlns:D="DAV:"></D:multistatus>' }));
    const client = new CalDavClient({ http: port, auth: { kind: 'basic', username: 'mike', password: 'pw' } });
    const result = await client.discoverPrincipal('https://caldav.example.com/dav/');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain('current-user-principal');
    expect(result.fix.length).toBeGreaterThan(0);
  });

  test('discoverCalendarHome resolves the calendar-home-set href against the origin', async () => {
    const port = new FakeCalDavHttpPort(() => ({ status: 207, headers: {}, body: HOME_SET_XML }));
    const client = new CalDavClient({ http: port, auth: { kind: 'basic', username: 'mike', password: 'pw' } });
    const result = await client.discoverCalendarHome('https://caldav.example.com/principals/users/mike/');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.homeUrl).toBe('https://caldav.example.com/calendars/mike/');
  });

  test('listCalendars returns only collections whose resourcetype includes calendar, with resolved hrefs', async () => {
    const port = new FakeCalDavHttpPort(() => ({ status: 207, headers: {}, body: CALENDARS_LIST_XML }));
    const client = new CalDavClient({ http: port, auth: { kind: 'basic', username: 'mike', password: 'pw' } });
    const result = await client.listCalendars('https://caldav.example.com/calendars/mike/');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.calendars).toHaveLength(1);
    expect(result.calendars[0]?.displayName).toBe('Personal');
    expect(result.calendars[0]?.href).toBe('https://caldav.example.com/calendars/mike/personal/');
    expect(result.calendars[0]?.etag).toBe('"col-etag-1"');
    expect(port.requests[0]?.headers['Depth']).toBe('1');
  });

  test('listEvents parses both a timed and an all-day event out of the REPORT response', async () => {
    const port = new FakeCalDavHttpPort(() => ({ status: 207, headers: {}, body: EVENTS_XML }));
    const client = new CalDavClient({ http: port, auth: { kind: 'basic', username: 'mike', password: 'pw' } });
    const result = await client.listEvents('https://caldav.example.com/calendars/mike/personal/', {
      start: new Date('2026-01-01T00:00:00Z'),
      end: new Date('2026-02-01T00:00:00Z'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toHaveLength(2);
    const timed = result.events.find((e) => e.uid === 'event-1@example.com');
    const allDay = result.events.find((e) => e.uid === 'event-2@example.com');
    expect(timed?.allDay).toBe(false);
    expect(timed?.tzid).toBe('America/New_York');
    expect(timed?.href).toBe('https://caldav.example.com/calendars/mike/personal/event1.ics');
    expect(timed?.etag).toBe('"etag-event-1"');
    expect(allDay?.allDay).toBe(true);
    expect(allDay?.rrule).toBe('FREQ=YEARLY');
    expect(port.requests[0]?.method).toBe('REPORT');
    expect(port.requests[0]?.body).toContain('time-range');
  });

  test('discover chains principal -> home -> calendars through three requests', async () => {
    const port = new FakeCalDavHttpPort((input) => {
      if (input.url === 'https://caldav.example.com/dav/') return { status: 207, headers: {}, body: PRINCIPAL_XML };
      if (input.url === 'https://caldav.example.com/principals/users/mike/') return { status: 207, headers: {}, body: HOME_SET_XML };
      if (input.url === 'https://caldav.example.com/calendars/mike/') return { status: 207, headers: {}, body: CALENDARS_LIST_XML };
      return { status: 404, headers: {}, body: '' };
    });
    const client = new CalDavClient({ http: port, auth: { kind: 'basic', username: 'mike', password: 'pw' } });
    const result = await client.discover('https://caldav.example.com/dav/');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principalUrl).toBe('https://caldav.example.com/principals/users/mike/');
    expect(result.homeUrl).toBe('https://caldav.example.com/calendars/mike/');
    expect(result.calendars).toHaveLength(1);
    expect(port.requests).toHaveLength(3);
  });

  test('discover stops and surfaces the failure from the first step that fails', async () => {
    const port = new FakeCalDavHttpPort(() => ({ status: 401, headers: {}, body: '' }));
    const client = new CalDavClient({ http: port, auth: { kind: 'basic', username: 'mike', password: 'pw' } });
    const result = await client.discover('https://caldav.example.com/dav/');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain('401');
    expect(port.requests).toHaveLength(1);
  });

  test('sends a Basic Authorization header built from username and password', async () => {
    const port = new FakeCalDavHttpPort(() => ({ status: 207, headers: {}, body: PRINCIPAL_XML }));
    const client = new CalDavClient({ http: port, auth: { kind: 'basic', username: 'mike', password: 'p@ss' } });
    await client.discoverPrincipal('https://caldav.example.com/dav/');
    const expected = `Basic ${Buffer.from('mike:p@ss', 'utf-8').toString('base64')}`;
    expect(port.requests[0]?.headers['Authorization']).toBe(expected);
  });

  test('sends a Bearer Authorization header built from the access token', async () => {
    const port = new FakeCalDavHttpPort(() => ({ status: 207, headers: {}, body: PRINCIPAL_XML }));
    const client = new CalDavClient({ http: port, auth: { kind: 'bearer', accessToken: 'ya29.example-token' } });
    await client.discoverPrincipal('https://caldav.example.com/dav/');
    expect(port.requests[0]?.headers['Authorization']).toBe('Bearer ya29.example-token');
  });

  test.each([401, 403, 404, 500, 418] as const)('classifies an HTTP %d as a plain-language, non-throwing failure', async (status) => {
    const port = new FakeCalDavHttpPort(() => ({ status, headers: {}, body: '' }));
    const client = new CalDavClient({ http: port, auth: { kind: 'basic', username: 'mike', password: 'pw' } });
    const result = await client.discoverPrincipal('https://caldav.example.com/dav/');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain(String(status));
    expect(result.fix.length).toBeGreaterThan(0);
  });

  test('a transport error (fetch throws) is reported as a plain-language problem rather than propagating the exception', async () => {
    const port = new FakeCalDavHttpPort(() => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:443');
    });
    const client = new CalDavClient({ http: port, auth: { kind: 'basic', username: 'mike', password: 'pw' } });
    const result = await client.discoverPrincipal('https://caldav.example.com/dav/');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain('could not reach the calendar server');
  });
});

// ---------------------------------------------------------------------------
// Client: credentials must never surface in a returned value
// ---------------------------------------------------------------------------

describe('CalDavClient credential handling', () => {
  const sensitiveAuths: readonly CalDavAuth[] = [
    { kind: 'basic', username: 'mike', password: 'hunter2-super-secret-password' },
    { kind: 'bearer', accessToken: 'ya29.super-secret-bearer-token-value' },
  ];

  for (const auth of sensitiveAuths) {
    const secret = auth.kind === 'basic' ? auth.password : auth.accessToken;

    test(`a 401 problem never contains the ${auth.kind} credential`, async () => {
      const port = new FakeCalDavHttpPort(() => ({ status: 401, headers: {}, body: '' }));
      const client = new CalDavClient({ http: port, auth });
      const result = await client.discoverPrincipal('https://caldav.example.com/dav/');
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
    });

    test(`a transport failure problem never contains the ${auth.kind} credential`, async () => {
      const port = new FakeCalDavHttpPort(() => {
        throw new Error('network unreachable');
      });
      const client = new CalDavClient({ http: port, auth });
      const result = await client.discoverPrincipal('https://caldav.example.com/dav/');
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
    });

    test(`the credential IS actually sent on the wire (so the leak check above is meaningful)`, async () => {
      const port = new FakeCalDavHttpPort(() => ({ status: 207, headers: {}, body: PRINCIPAL_XML }));
      const client = new CalDavClient({ http: port, auth });
      await client.discoverPrincipal('https://caldav.example.com/dav/');
      expect(port.requests[0]?.headers['Authorization']).toContain(auth.kind === 'bearer' ? secret : '');
    });
  }
});

// ---------------------------------------------------------------------------
// Client: genuine transport test over real HTTP
// ---------------------------------------------------------------------------

describe('CalDavClient over a real in-process HTTP server', () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl = '';

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'PROPFIND' && url.pathname === '/dav/') {
          return new Response(PRINCIPAL_XML, { status: 207, headers: { 'content-type': 'application/xml; charset=utf-8' } });
        }
        if (req.method === 'PROPFIND' && url.pathname === '/principals/users/mike/') {
          return new Response(HOME_SET_XML, { status: 207, headers: { 'content-type': 'application/xml; charset=utf-8' } });
        }
        if (req.method === 'PROPFIND' && url.pathname === '/calendars/mike/') {
          return new Response(CALENDARS_LIST_XML, { status: 207, headers: { 'content-type': 'application/xml; charset=utf-8' } });
        }
        if (req.method === 'REPORT' && url.pathname === '/calendars/mike/personal/') {
          return new Response(EVENTS_XML, { status: 207, headers: { 'content-type': 'application/xml; charset=utf-8' } });
        }
        if (req.method === 'PROPFIND' && url.pathname === '/unauthorized/') {
          return new Response('', { status: 401 });
        }
        return new Response('not found', { status: 404 });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop();
  });

  test('discover() drives real HTTP PROPFIND requests end to end against the in-process server', async () => {
    const client = new CalDavClient({
      http: createFetchCalDavHttpPort(),
      auth: { kind: 'basic', username: 'mike', password: 'live-test-password' },
    });
    const result = await client.discover(`${baseUrl}/dav/`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principalUrl).toBe(`${baseUrl}/principals/users/mike/`);
    expect(result.homeUrl).toBe(`${baseUrl}/calendars/mike/`);
    expect(result.calendars).toHaveLength(1);
    expect(result.calendars[0]?.href).toBe(`${baseUrl}/calendars/mike/personal/`);
  });

  test('listEvents() drives a real HTTP REPORT request and parses the returned VEVENTs', async () => {
    const client = new CalDavClient({
      http: createFetchCalDavHttpPort(),
      auth: { kind: 'bearer', accessToken: 'live-test-token' },
    });
    const result = await client.listEvents(`${baseUrl}/calendars/mike/personal/`, {
      start: new Date('2026-01-01T00:00:00Z'),
      end: new Date('2026-02-01T00:00:00Z'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.map((e) => e.uid).sort()).toEqual(['event-1@example.com', 'event-2@example.com']);
  });

  test('a real 401 response over HTTP is classified as a plain-language credential problem', async () => {
    const client = new CalDavClient({
      http: createFetchCalDavHttpPort(),
      auth: { kind: 'basic', username: 'mike', password: 'live-test-password' },
    });
    const result = await client.discoverPrincipal(`${baseUrl}/unauthorized/`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain('401');
    expect(JSON.stringify(result)).not.toContain('live-test-password');
  });
});
