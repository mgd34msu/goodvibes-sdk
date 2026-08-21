/**
 * Tests for the CalDAV-backed implementation of the daemon's `calendar.*`
 * verbs, the port of the calendar surface that used to live inside one
 * product.
 *
 * Everything runs against injected ports: a fake `CalDavHttpPort` (no socket),
 * a map-backed config port, a map-backed secret port, and a fixed clock and uid
 * source, so a generated .ics is byte-for-byte reproducible.
 *
 * What is asserted, deliberately:
 *   - the operator-facing wording and the config key names in it
 *   - the exact requests made (method, URL, Depth, body shape)
 *   - that no credential, host, or raw attendee address reaches a caller
 *   - the .ics round-trip, including folding, escaping and all-day values
 */

import { describe, expect, test } from 'bun:test';
import { createCalDavCalendarGatewayService } from '../packages/sdk/src/platform/calendar/caldav-gateway-service.ts';
import {
  createCalDavSecretPort,
  parseCollectionMap,
  toRelativeHref,
} from '../packages/sdk/src/platform/calendar/caldav-gateway-config.ts';
import { parseICS } from '../packages/sdk/src/platform/calendar/caldav-ics.ts';
import { generateICS, foldLine } from '../packages/sdk/src/platform/calendar/caldav-ics-generate.ts';
import { GatewayVerbError } from '../packages/sdk/src/platform/control-plane/routes/gateway-verb-error.ts';
import type {
  CalDavHttpPort,
  CalDavHttpRequest,
  CalDavHttpResponse,
} from '../packages/sdk/src/platform/google/caldav-client.ts';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface Recorded {
  readonly requests: CalDavHttpRequest[];
  readonly port: CalDavHttpPort;
}

function fakeHttp(
  respond: (request: CalDavHttpRequest) => CalDavHttpResponse | Promise<CalDavHttpResponse>,
): Recorded {
  const requests: CalDavHttpRequest[] = [];
  return {
    requests,
    port: {
      async request(input) {
        requests.push(input);
        return respond(input);
      },
    },
  };
}

function ok(body: string, headers: Record<string, string> = {}): CalDavHttpResponse {
  return { status: 207, headers, body };
}

const BASE_CONFIG: Record<string, unknown> = {
  'surfaces.calendar.caldavUrl': 'https://dav.example.com/calendars/mike/personal/',
  'surfaces.calendar.caldavUser': 'mike',
  'surfaces.calendar.caldavPassword': 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD',
};

function configPort(overrides: Record<string, unknown> = {}) {
  const values = { ...BASE_CONFIG, ...overrides };
  return {
    get(key: string): unknown {
      if (!(key in values)) throw new Error(`Invalid config path: ${key}`);
      return values[key];
    },
  };
}

function secretStore(entries: Record<string, string> = { GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD: 'hunter2' }) {
  return createCalDavSecretPort({
    async get(key: string): Promise<string | null> {
      return entries[key] ?? null;
    },
  });
}

const FIXED_NOW = Date.parse('2026-07-27T09:30:00.000Z');

function service(http: CalDavHttpPort, options: {
  readonly config?: Record<string, unknown>;
  readonly secrets?: Record<string, string>;
} = {}) {
  return createCalDavCalendarGatewayService({
    config: configPort(options.config),
    secrets: options.secrets === undefined ? secretStore() : secretStore(options.secrets),
    http,
    now: () => FIXED_NOW,
    randomUuid: () => 'fixed-uuid',
  });
}

function multistatus(entries: readonly { href: string; calendarData: string }[]): string {
  const responses = entries.map((entry) => `
  <D:response>
    <D:href>${entry.href}</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>"etag-1"</D:getetag>
        <C:calendar-data>${entry.calendarData}</C:calendar-data>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses}
</D:multistatus>`;
}

function vevent(fields: {
  uid: string;
  summary: string;
  start: string;
  end: string;
  extra?: readonly string[];
}): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    `UID:${fields.uid}`,
    `DTSTART:${fields.start}`,
    `DTEND:${fields.end}`,
    `SUMMARY:${fields.summary}`,
    ...(fields.extra ?? []),
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

async function expectVerbError(
  run: () => Promise<unknown>,
): Promise<GatewayVerbError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayVerbError);
    return error as GatewayVerbError;
  }
  throw new Error('expected the call to fail, but it resolved');
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('CalDAV gateway configuration', () => {
  test('an unconfigured surface names the exact keys to set', async () => {
    const http = fakeHttp(() => ok(multistatus([])));
    const error = await expectVerbError(() =>
      service(http.port, { config: { 'surfaces.calendar.caldavUrl': '' } }).listEvents({}),
    );
    expect(error.message).toBe(
      'CalDAV is not configured. Set surfaces.calendar.caldavUrl and surfaces.calendar.caldavUser.',
    );
    expect(error.code).toBe('CALENDAR_NOT_CONFIGURED');
    expect(error.status).toBe(412);
    expect(http.requests).toHaveLength(0);
  });

  test('a missing config section reads as unconfigured rather than throwing', async () => {
    const http = fakeHttp(() => ok(multistatus([])));
    const bare = createCalDavCalendarGatewayService({
      config: { get(key: string): unknown { throw new Error(`Invalid config path: ${key}`); } },
      secrets: secretStore(),
      http: http.port,
    });
    const error = await expectVerbError(() => bare.listEvents({}));
    expect(error.code).toBe('CALENDAR_NOT_CONFIGURED');
  });

  test('a missing password is reported as a credential-store problem, not a server one', async () => {
    const http = fakeHttp(() => ok(multistatus([])));
    const error = await expectVerbError(() => service(http.port, { secrets: {} }).listEvents({}));
    expect(error.message).toBe('CalDAV password is not available in the credential store.');
    expect(error.code).toBe('CALENDAR_CREDENTIALS_MISSING');
    expect(error.status).toBe(412);
  });

  test('the password falls back to the config-key-derived secret when config holds no reference', async () => {
    const http = fakeHttp(() => ok(multistatus([])));
    await service(http.port, {
      config: { 'surfaces.calendar.caldavPassword': '' },
      secrets: { GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD: 'derived-secret' },
    }).listEvents({});
    expect(http.requests[0]?.headers['Authorization']).toBe(
      `Basic ${Buffer.from('mike:derived-secret').toString('base64')}`,
    );
  });

  test('a non-ASCII password still produces a correct Basic header', async () => {
    const http = fakeHttp(() => ok(multistatus([])));
    await service(http.port, {
      config: { 'surfaces.calendar.caldavPassword': '' },
      secrets: { GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD: 'pässwörd-✓' },
    }).listEvents({});
    expect(http.requests[0]?.headers['Authorization']).toBe(
      `Basic ${Buffer.from('mike:pässwörd-✓', 'utf-8').toString('base64')}`,
    );
  });

  test('the calendars map is JSON; malformed config degrades to default-only instead of failing', () => {
    expect(parseCollectionMap('{"work":"/dav/work/","home":"/dav/home/"}')).toEqual({
      work: '/dav/work/',
      home: '/dav/home/',
    });
    expect(parseCollectionMap('work,home')).toEqual({});
    expect(parseCollectionMap('["work"]')).toEqual({});
    expect(parseCollectionMap(undefined)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe('calendar.events.list', () => {
  const body = multistatus([
    {
      href: '/calendars/mike/personal/b.ics',
      calendarData: vevent({
        uid: 'b@example.com',
        summary: 'Later meeting',
        start: '20260728T140000Z',
        end: '20260728T150000Z',
        extra: ['LOCATION:Room 2', 'ATTENDEE;CN=Jane Doe:mailto:jane@example.com', 'ATTENDEE:mailto:sam@example.com'],
      }),
    },
    {
      href: '/calendars/mike/personal/a.ics',
      calendarData: vevent({
        uid: 'a@example.com',
        summary: 'Earlier standup',
        start: '20260727T090000Z',
        end: '20260727T091500Z',
      }),
    },
  ]);

  test('REPORTs the default collection at Depth 1 and sorts by start', async () => {
    const http = fakeHttp(() => ok(body));
    const events = await service(http.port).listEvents({});
    expect(http.requests).toHaveLength(1);
    const request = http.requests[0];
    expect(request?.method).toBe('REPORT');
    expect(request?.url).toBe('https://dav.example.com/calendars/mike/personal');
    expect(request?.headers['Depth']).toBe('1');
    expect(request?.body).toContain('<C:comp-filter name="VEVENT">');
    expect(events.map((event) => event.title)).toEqual(['Earlier standup', 'Later meeting']);
    expect(events[0]?.id).toBe('/calendars/mike/personal/a.ics');
  });

  test('attendees come back as display names, never as addresses', async () => {
    const http = fakeHttp(() => ok(body));
    const events = await service(http.port).listEvents({});
    const later = events.find((event) => event.title === 'Later meeting');
    expect(later?.attendees).toEqual(['Jane Doe', 'sam']);
    expect(JSON.stringify(events)).not.toContain('jane@example.com');
    expect(JSON.stringify(events)).not.toContain('sam@example.com');
  });

  test('a time range becomes a CalDAV UTC filter', async () => {
    const http = fakeHttp(() => ok(body));
    await service(http.port).listEvents({ from: '2026-07-27T00:00:00Z', to: '2026-07-28T00:00:00Z' });
    expect(http.requests[0]?.body).toContain('start="20260727T000000Z"');
    expect(http.requests[0]?.body).toContain('end="20260728T000000Z"');
  });

  test('an unparseable range is the caller\'s error, and no request is made', async () => {
    const http = fakeHttp(() => ok(body));
    const error = await expectVerbError(() => service(http.port).listEvents({ from: 'next tuesday' }));
    expect(error.message).toBe("Field 'from' must be a valid ISO-8601 date.");
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(http.requests).toHaveLength(0);
  });

  test('limit defaults to 20 and clamps to 1..200', async () => {
    const many = multistatus(
      Array.from({ length: 30 }, (_unused, index) => ({
        href: `/calendars/mike/personal/${String(index)}.ics`,
        calendarData: vevent({
          uid: `${String(index)}@example.com`,
          summary: `Event ${String(index)}`,
          start: `202607${String(10 + index).padStart(2, '0')}T090000Z`,
          end: `202607${String(10 + index).padStart(2, '0')}T100000Z`,
        }),
      })),
    );
    const http = fakeHttp(() => ok(many));
    expect(await service(http.port).listEvents({})).toHaveLength(20);
    expect(await service(http.port).listEvents({ limit: 5 })).toHaveLength(5);
    expect(await service(http.port).listEvents({ limit: 0 })).toHaveLength(1);
    expect(await service(http.port).listEvents({ limit: 9999 })).toHaveLength(30);
  });

  test('a mapped calendar id resolves to its configured collection path', async () => {
    const http = fakeHttp(() => ok(multistatus([])));
    await service(http.port, {
      config: { 'surfaces.calendar.calendars': '{"work":"/dav/calendars/work/"}' },
    }).listEvents({ calendarId: 'work' });
    expect(http.requests[0]?.url).toBe('https://dav.example.com/dav/calendars/work');
  });

  test('an unmapped calendar id becomes a percent-encoded collection under the origin', async () => {
    const http = fakeHttp(() => ok(multistatus([])));
    await service(http.port).listEvents({ calendarId: 'team calendar' });
    // An id with no entry in `surfaces.calendar.calendars` is treated as a
    // host-absolute collection name, so it resolves against the ORIGIN rather
    // than under the configured collection path. Servers that nest calendars
    // under a user path need the mapping, which is what it is for.
    expect(http.requests[0]?.url).toBe('https://dav.example.com/team%20calendar');
  });
});

// ---------------------------------------------------------------------------
// Reading one event
// ---------------------------------------------------------------------------

describe('calendar.events.get', () => {
  const single = vevent({
    uid: 'a@example.com',
    summary: 'Standup',
    start: '20260727T090000Z',
    end: '20260727T091500Z',
    extra: ['RRULE:FREQ=WEEKLY;COUNT=10'],
  });

  test('an href-like id is fetched directly with GET', async () => {
    const http = fakeHttp(() => ({ status: 200, headers: {}, body: single }));
    const event = await service(http.port).getEvent('/calendars/mike/personal/a.ics');
    expect(http.requests[0]?.method).toBe('GET');
    expect(http.requests[0]?.url).toBe('https://dav.example.com/calendars/mike/personal/a.ics');
    expect(event.uid).toBe('a@example.com');
    expect(event.id).toBe('/calendars/mike/personal/a.ics');
    expect(event.recurrence).toBe('FREQ=WEEKLY;COUNT=10');
  });

  test('a bare UID is matched server-side by prop-filter, and confirmed client-side', async () => {
    const http = fakeHttp(() => ok(multistatus([{ href: '/calendars/mike/personal/a.ics', calendarData: single }])));
    const event = await service(http.port).getEvent('a@example.com');
    expect(http.requests[0]?.method).toBe('REPORT');
    expect(http.requests[0]?.body).toContain('<C:prop-filter name="UID">');
    expect(http.requests[0]?.body).toContain('a@example.com');
    expect(event.title).toBe('Standup');
  });

  test('a server that ignores the UID filter never yields the wrong event', async () => {
    const other = vevent({ uid: 'zzz@example.com', summary: 'Not it', start: '20260727T090000Z', end: '20260727T093000Z' });
    const http = fakeHttp(() => ok(multistatus([{ href: '/calendars/mike/personal/z.ics', calendarData: other }])));
    const error = await expectVerbError(() => service(http.port).getEvent('a@example.com'));
    expect(error.message).toBe('Event not found: a@example.com');
    expect(error.status).toBe(404);
  });

  test('a 404 on a direct fetch is "not found", not a server fault', async () => {
    const http = fakeHttp(() => ({ status: 404, headers: {}, body: '' }));
    const error = await expectVerbError(() => service(http.port).getEvent('/calendars/mike/personal/gone.ics'));
    expect(error.code).toBe('CALENDAR_NOT_FOUND');
    expect(error.status).toBe(404);
  });

  test('a UID containing XML metacharacters is escaped into the filter', async () => {
    const http = fakeHttp(() => ok(multistatus([])));
    await expectVerbError(() => service(http.port).getEvent('a&b<c'));
    expect(http.requests[0]?.body).toContain('a&amp;b&lt;c');
  });
});

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

describe('calendar.events.create', () => {
  test('PUTs a VEVENT that will not overwrite an existing resource', async () => {
    const http = fakeHttp(() => ({ status: 201, headers: {}, body: '' }));
    const created = await service(http.port).createEvent({
      title: 'Review; with, punctuation',
      start: '2026-07-27T10:00:00Z',
      end: '2026-07-27T11:00:00Z',
      description: 'Line one\nline two',
      location: 'Room 1',
      attendees: ['jane@example.com', 'Sam Smith'],
    });
    const request = http.requests[0];
    expect(request?.method).toBe('PUT');
    expect(request?.headers['If-None-Match']).toBe('*');
    expect(request?.headers['Content-Type']).toBe('text/calendar; charset=utf-8');
    expect(request?.url).toBe('https://dav.example.com/calendars/mike/personal/fixed-uuid@goodvibes.ics');
    expect(request?.body).toContain('SUMMARY:Review\\; with\\, punctuation');
    expect(request?.body).toContain('DESCRIPTION:Line one\\nline two');
    expect(request?.body).toContain('DTSTAMP:20260727T093000Z');
    expect(request?.body).toContain('STATUS:CONFIRMED');
    expect(request?.body).toContain('ATTENDEE:mailto:jane@example.com');
    expect(request?.body).toContain('ATTENDEE;CN=Sam Smith:mailto:invalid@invalid');
    expect(created).toEqual({
      eventId: '/calendars/mike/personal/fixed-uuid@goodvibes.ics',
      uid: 'fixed-uuid@goodvibes',
      createdAt: '2026-07-27T09:30:00.000Z',
    });
  });

  test('a server-assigned Location wins, reduced to a host-relative href', async () => {
    const http = fakeHttp(() => ({
      status: 201,
      headers: { location: 'https://dav.example.com/calendars/mike/personal/server-chosen.ics' },
      body: '',
    }));
    const created = await service(http.port).createEvent({
      title: 'Sync',
      start: '2026-07-27T10:00:00Z',
      end: '2026-07-27T11:00:00Z',
    });
    expect(created.eventId).toBe('/calendars/mike/personal/server-chosen.ics');
  });

  test('an end before the start is refused before anything is written', async () => {
    const http = fakeHttp(() => ({ status: 201, headers: {}, body: '' }));
    const error = await expectVerbError(() =>
      service(http.port).createEvent({
        title: 'Backwards',
        start: '2026-07-27T11:00:00Z',
        end: '2026-07-27T10:00:00Z',
      }),
    );
    expect(error.message).toBe("Field 'end' must not be before 'start'.");
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(http.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

describe('calendar.ics import and export', () => {
  const twoEvents = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:one@example.com',
    'DTSTART:20260727T090000Z',
    'DTEND:20260727T100000Z',
    'SUMMARY:First',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:two@example.com',
    'DTSTART;VALUE=DATE:20260728',
    'DTEND;VALUE=DATE:20260729',
    'SUMMARY:All day',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  test('import PUTs one resource per VEVENT and reports the hrefs', async () => {
    const http = fakeHttp(() => ({ status: 201, headers: {}, body: '' }));
    const result = await service(http.port).importIcs(twoEvents);
    expect(result.imported).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.eventIds).toEqual([
      '/calendars/mike/personal/one@example.com.ics',
      '/calendars/mike/personal/two@example.com.ics',
    ]);
    expect(http.requests.map((request) => request.method)).toEqual(['PUT', 'PUT']);
    expect(http.requests[1]?.body).toContain('DTSTART;VALUE=DATE:20260728');
  });

  test('one refused event does not sink the rest, and is named', async () => {
    let call = 0;
    const http = fakeHttp(() => {
      call += 1;
      return call === 1 ? { status: 507, headers: {}, body: '' } : { status: 201, headers: {}, body: '' };
    });
    const result = await service(http.port).importIcs(twoEvents);
    expect(result.imported).toBe(1);
    expect(result.eventIds).toEqual(['/calendars/mike/personal/two@example.com.ics']);
    expect(result.errors).toEqual(['one@example.com: CalDAV server returned HTTP 507.']);
  });

  test('an .ics with no VEVENT is refused rather than reported as zero imports', async () => {
    const http = fakeHttp(() => ({ status: 201, headers: {}, body: '' }));
    const error = await expectVerbError(() => service(http.port).importIcs('BEGIN:VCALENDAR\r\nEND:VCALENDAR'));
    expect(error.message).toBe('No VEVENT components found in .ics content.');
    expect(error.code).toBe('CALENDAR_EMPTY_ICS');
    expect(error.status).toBe(400);
  });

  test('export renders every event in the collection into one VCALENDAR', async () => {
    const http = fakeHttp(() => ok(multistatus([
      {
        href: '/calendars/mike/personal/a.ics',
        calendarData: vevent({
          uid: 'a@example.com',
          summary: 'Standup',
          start: '20260727T090000Z',
          end: '20260727T091500Z',
          extra: ['ATTENDEE;CN=Jane:mailto:jane@example.com'],
        }),
      },
    ])));
    const exported = await service(http.port).exportIcs({});
    expect(exported.eventCount).toBe(1);
    expect(exported.icsContent.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(exported.icsContent).toContain('UID:a@example.com');
    expect(exported.icsContent).toContain('DTSTAMP:20260727T093000Z');
    // The export is the payload a calendar app will re-import, so the ORIGINAL
    // addressing survives here even though a listing response would not carry
    // it. The CN parameter does not survive: an attendee is re-emitted by its
    // address, and the address is what the receiving calendar resolves a name
    // from anyway.
    expect(exported.icsContent).toContain('ATTENDEE:mailto:jane@example.com');
  });

  test('a generated .ics parses back to the same event (round trip)', () => {
    const summary = `A very long summary that will certainly exceed the seventy-five octet folding limit ${'x'.repeat(40)}`;
    const ics = generateICS({
      uid: 'round@example.com',
      summary,
      start: '2026-07-27T10:00:00Z',
      end: '2026-07-27T11:00:00Z',
      description: 'Semi; comma, backslash \\ and\nnewline',
      location: 'Room; 1',
      attendees: ['jane@example.com'],
      organizer: 'mailto:mike@example.com',
      status: 'confirmed',
      recurrence: 'FREQ=DAILY;COUNT=3',
      dtStamp: '2026-07-27T09:30:00.000Z',
    });
    for (const line of ics.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    const parsed = parseICS(ics);
    expect(parsed).toHaveLength(1);
    const event = parsed[0];
    expect(event?.uid).toBe('round@example.com');
    expect(event?.summary).toBe(summary);
    expect(event?.description).toBe('Semi; comma, backslash \\ and\nnewline');
    expect(event?.location).toBe('Room; 1');
    expect(event?.start).toBe('2026-07-27T10:00:00.000Z');
    expect(event?.end).toBe('2026-07-27T11:00:00.000Z');
    expect(event?.status).toBe('confirmed');
    expect(event?.recurrence).toBe('FREQ=DAILY;COUNT=3');
    expect(event?.attendees).toEqual([{ displayName: 'jane', rawValue: 'mailto:jane@example.com' }]);
    expect(event?.organizer).toBe('mike');
  });

  test('an all-day event keeps its calendar day through a round trip', () => {
    const ics = generateICS({
      uid: 'allday@example.com',
      summary: 'Holiday',
      start: '2026-12-25T00:00:00+09:00',
      end: '2026-12-26T00:00:00+09:00',
      allDay: true,
      dtStamp: '2026-07-27T09:30:00.000Z',
    });
    expect(ics).toContain('DTSTART;VALUE=DATE:20261225');
    const parsed = parseICS(ics);
    expect(parsed[0]?.allDay).toBe(true);
    expect(parsed[0]?.start).toBe('2026-12-25T00:00:00.000Z');
  });

  test('a folded multi-byte summary never splits a codepoint', () => {
    const folded = foldLine(`SUMMARY:${'é'.repeat(60)}`);
    expect(folded.split('\r\n').length).toBeGreaterThan(1);
    expect(folded.replace(/\r\n /g, '')).toBe(`SUMMARY:${'é'.repeat(60)}`);
  });

  test('a VEVENT whose DTSTART and DTEND disagree on type is refused, not silently mangled', () => {
    const mismatched = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:bad@example.com',
      'DTSTART;VALUE=DATE:20260728',
      'DTEND:20260729T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(() => parseICS(mismatched)).toThrow(/mismatched VALUE types/);
  });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('calendar discovery', () => {
  const collections = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/calendars/mike/personal/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>Personal</D:displayname>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/calendars/mike/inbox/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>Inbox</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

  test('PROPFIND lists only calendar collections, keyed by their last path segment', async () => {
    const http = fakeHttp(() => ok(collections));
    const calendars = await service(http.port).listCalendars();
    expect(http.requests[0]?.method).toBe('PROPFIND');
    expect(http.requests[0]?.headers['Depth']).toBe('1');
    expect(calendars).toEqual([{ calendarId: 'personal', displayName: 'Personal' }]);
  });

  test('a server root falls back to principal then calendar-home discovery', async () => {
    const principal = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response><D:href>/dav/</D:href><D:propstat><D:prop>
    <D:current-user-principal><D:href>/principals/mike/</D:href></D:current-user-principal>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;
    const home = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response><D:href>/principals/mike/</D:href><D:propstat><D:prop>
    <C:calendar-home-set><D:href>/calendars/mike/</D:href></C:calendar-home-set>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;
    let call = 0;
    const http = fakeHttp(() => {
      call += 1;
      if (call === 1) return ok('<D:multistatus xmlns:D="DAV:"></D:multistatus>');
      if (call === 2) return ok(principal);
      if (call === 3) return ok(home);
      return ok(collections);
    });
    const calendars = await service(http.port, {
      config: { 'surfaces.calendar.caldavUrl': 'https://dav.example.com/dav/' },
    }).listCalendars();
    expect(calendars).toEqual([{ calendarId: 'personal', displayName: 'Personal' }]);
    expect(http.requests.map((request) => request.url)).toEqual([
      'https://dav.example.com/dav',
      'https://dav.example.com/dav/',
      'https://dav.example.com/principals/mike/',
      'https://dav.example.com/calendars/mike/',
    ]);
  });

  test('a server that advertises nothing still names the configured default', async () => {
    const http = fakeHttp(() => ok('<D:multistatus xmlns:D="DAV:"></D:multistatus>'));
    const calendars = await service(http.port, {
      config: { 'surfaces.calendar.defaultCalendarId': 'personal' },
    }).listCalendars();
    expect(calendars).toEqual([{ calendarId: 'personal', displayName: 'personal' }]);
  });
});

// ---------------------------------------------------------------------------
// Failure reporting
// ---------------------------------------------------------------------------

describe('CalDAV failures never carry the connection', () => {
  test('a rejected credential is an auth failure with no credential in the message', async () => {
    const http = fakeHttp(() => ({ status: 401, headers: {}, body: 'Unauthorized' }));
    const error = await expectVerbError(() => service(http.port).listEvents({}));
    expect(error.message).toBe('CalDAV server returned HTTP 401.');
    expect(error.code).toBe('CALENDAR_AUTH_FAILED');
    expect(error.status).toBe(401);
    expect(error.message).not.toContain('hunter2');
    expect(error.message).not.toContain('dav.example.com');
  });

  test('a transport failure never names the host it could not reach', async () => {
    const http = fakeHttp(() => {
      throw new Error('getaddrinfo ENOTFOUND dav.example.com');
    });
    const error = await expectVerbError(() => service(http.port).listEvents({}));
    expect(error.message).toBe('CalDAV request failed: network error.');
    expect(error.code).toBe('CALENDAR_NETWORK_ERROR');
    expect(error.status).toBe(502);
    expect(error.message).not.toContain('dav.example.com');
  });

  test('a 5xx from the calendar server is reported as an upstream failure', async () => {
    const http = fakeHttp(() => ({ status: 503, headers: {}, body: '' }));
    const error = await expectVerbError(() => service(http.port).listEvents({}));
    expect(error.status).toBe(502);
    expect(error.code).toBe('CALENDAR_REQUEST_FAILED');
  });

  test('hrefs are reduced to host-relative paths', () => {
    expect(toRelativeHref('https://dav.example.com/calendars/mike/a.ics')).toBe('/calendars/mike/a.ics');
    expect(toRelativeHref('calendars/mike/a.ics')).toBe('/calendars/mike/a.ics');
    expect(toRelativeHref('  /calendars/mike/a.ics  ')).toBe('/calendars/mike/a.ics');
  });
});
