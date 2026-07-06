/**
 * platform-calendar.test.ts
 *
 * External-calendar READ connectivity. Covers:
 *  - parseIcs: VEVENT extraction (UID/SUMMARY/LOCATION/DESCRIPTION), line unfolding,
 *    TEXT unescaping, honest DTSTART zone anchoring (utc/floating/tzid, VALUE=DATE),
 *    synthetic UID for a UID-less event, and honest skip of a DTSTART-less VEVENT.
 *  - RRULE subset: DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL/COUNT/UNTIL/weekly-BYDAY
 *    expand to correct occurrences; anything outside the subset is marked
 *    `expansion: 'unsupported'` and yields ONLY its seed — never fabricated dates.
 *  - SubscriptionStore against FAKE feeds + a FAKE clock (no real network, ever):
 *    paste-URL-and-done add() with X-WR-CALNAME-derived name, conditional 304 refresh,
 *    honest unreachable / parse-error / stale-with-age status, validate-by-fetch,
 *    snapshot/restore, and maskFeedUrl.
 *  - purity: no file under platform/calendar/ imports fs/net/tty/process.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REFRESH_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
  SubscriptionStore,
  compareEventDateTime,
  eventDateTimeEpochMs,
  expandEvent,
  maskFeedUrl,
  parseIcs,
  type EventDateTime,
  type FeedFetchResult,
} from '../packages/sdk/src/platform/calendar/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CALENDAR_DIR = resolve(__dirname, '../packages/sdk/src/platform/calendar');

// --- fixtures ---------------------------------------------------------------

const BASIC_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//EN',
  'X-WR-CALNAME:Team Calendar',
  'BEGIN:VEVENT',
  'UID:evt-1@test',
  'SUMMARY:Standup\\, daily',
  'LOCATION:Room A',
  'DESCRIPTION:Line one\\nLine two',
  'DTSTART:20260706T090000Z',
  'DTEND:20260706T093000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('parseIcs', () => {
  test('extracts fields, unescapes TEXT, and anchors a UTC datetime', () => {
    const cal = parseIcs(BASIC_ICS);
    expect(cal.calendarName).toBe('Team Calendar');
    expect(cal.events).toHaveLength(1);
    const e = cal.events[0]!;
    expect(e.uid).toBe('evt-1@test');
    expect(e.summary).toBe('Standup, daily');
    expect(e.location).toBe('Room A');
    expect(e.description).toBe('Line one\nLine two');
    expect(e.start).toEqual({ value: '2026-07-06T09:00:00Z', kind: 'date-time', zone: 'utc' });
    expect(e.end?.value).toBe('2026-07-06T09:30:00Z');
    expect(cal.skipped).toHaveLength(0);
  });

  test('unfolds folded lines', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:fold@test',
      'SUMMARY:A very long title that the',
      ' feed folded across lines',
      'DTSTART;VALUE=DATE:20260706',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const e = parseIcs(ics).events[0]!;
    expect(e.summary).toBe('A very long title that thefeed folded across lines');
    expect(e.start).toEqual({ value: '2026-07-06', kind: 'date', zone: 'floating' });
  });

  test('keeps a TZID datetime as wall time, honestly un-converted', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:tz@test',
      'DTSTART;TZID=America/New_York:20260706T090000',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const e = parseIcs(ics).events[0]!;
    expect(e.start).toEqual({ value: '2026-07-06T09:00:00', kind: 'date-time', zone: 'tzid', tzid: 'America/New_York' });
  });

  test('synthesises a UID when the feed omits one', () => {
    const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:No UID\r\nDTSTART:20260706T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const e = parseIcs(ics).events[0]!;
    expect(e.uid.startsWith('synthetic:')).toBe(true);
  });

  test('skips a DTSTART-less VEVENT honestly rather than dropping it silently', () => {
    const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:no-start\r\nSUMMARY:Broken\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const cal = parseIcs(ics);
    expect(cal.events).toHaveLength(0);
    expect(cal.skipped).toHaveLength(1);
    expect(cal.skipped[0]?.message).toContain('no usable DTSTART');
  });
});

// --- RRULE ------------------------------------------------------------------

function eventWithRule(dtstart: string, rrule: string) {
  const ics = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:r@test\r\nSUMMARY:R\r\nDTSTART;VALUE=DATE:${dtstart}\r\nRRULE:${rrule}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  return parseIcs(ics).events[0]!;
}

describe('RRULE expansion (honest subset)', () => {
  test('DAILY with COUNT expands to exactly COUNT occurrences', () => {
    const e = eventWithRule('20260706', 'FREQ=DAILY;COUNT=3');
    expect(e.recurrence?.expansion).toBe('full');
    const occ = expandEvent(e, { from: '2026-07-01', to: '2026-07-31' });
    expect(occ.map((o) => o.start)).toEqual(['2026-07-06', '2026-07-07', '2026-07-08']);
    expect(occ[0]?.isSeed).toBe(true);
  });

  test('DAILY with INTERVAL and UNTIL respects both bounds', () => {
    const e = eventWithRule('20260706', 'FREQ=DAILY;INTERVAL=2;UNTIL=20260714');
    const occ = expandEvent(e, { from: '2026-07-01', to: '2026-07-31' });
    expect(occ.map((o) => o.start)).toEqual(['2026-07-06', '2026-07-08', '2026-07-10', '2026-07-12', '2026-07-14']);
  });

  test('WEEKLY BYDAY expands to the named weekdays', () => {
    // 2026-07-06 is a Monday.
    const e = eventWithRule('20260706', 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4');
    const occ = expandEvent(e, { from: '2026-07-01', to: '2026-07-31' });
    expect(occ.map((o) => o.start)).toEqual(['2026-07-06', '2026-07-08', '2026-07-13', '2026-07-15']);
  });

  test('MONTHLY steps by calendar month', () => {
    const e = eventWithRule('20260115', 'FREQ=MONTHLY;COUNT=3');
    const occ = expandEvent(e, { from: '2026-01-01', to: '2026-12-31' });
    expect(occ.map((o) => o.start)).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
  });

  test('YEARLY steps by year', () => {
    const e = eventWithRule('20260115', 'FREQ=YEARLY;COUNT=2');
    const occ = expandEvent(e, { from: '2026-01-01', to: '2028-12-31' });
    expect(occ.map((o) => o.start)).toEqual(['2026-01-15', '2027-01-15']);
  });

  // RFC 5545 §3.3.10: an invalid calendar date generated by stepping (Feb 30, Feb 29
  // in a non-leap year, ...) is skipped and does NOT count towards COUNT. These pin
  // the exact regression the reviewer reproduced: naive Date.UTC(year, month+1, day)
  // arithmetic normalizes an out-of-range day into the NEXT month (Jan 31 -> "Mar 3"),
  // permanently drifting the series onto the wrong day forever.
  describe('MONTHLY/YEARLY anchor-day preservation (RFC 5545 §3.3.10)', () => {
    test('monthly on the 31st walks only months that HAVE a 31st, never drifting onto the 3rd', () => {
      const e = eventWithRule('20260131', 'FREQ=MONTHLY;COUNT=4');
      const occ = expandEvent(e, { from: '2026-01-01', to: '2026-12-31' });
      // Feb (28 days) and Apr (30 days) are skipped; Mar/May have a 31st.
      expect(occ.map((o) => o.start)).toEqual(['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
    });

    test('monthly on the 30th skips February without drifting the anchor day', () => {
      const e = eventWithRule('20260130', 'FREQ=MONTHLY;COUNT=3');
      const occ = expandEvent(e, { from: '2026-01-01', to: '2026-12-31' });
      expect(occ.map((o) => o.start)).toEqual(['2026-01-30', '2026-03-30', '2026-04-30']);
    });

    test('yearly on Feb 29 only lands on leap years, never drifting to Mar 1', () => {
      const e = eventWithRule('20240229', 'FREQ=YEARLY;COUNT=3');
      const occ = expandEvent(e, { from: '2024-01-01', to: '2035-12-31' });
      expect(occ.map((o) => o.start)).toEqual(['2024-02-29', '2028-02-29', '2032-02-29']);
    });

    test('COUNT/UNTIL interaction with skips: a skipped candidate past UNTIL ends the series honestly short of COUNT', () => {
      // Anchored Jan 31; UNTIL=Feb 28 falls before the next VALID occurrence (Mar 31),
      // so only the seed is ever emitted even though COUNT asks for 2.
      const e = eventWithRule('20260131', 'FREQ=MONTHLY;COUNT=2;UNTIL=20260228');
      const occ = expandEvent(e, { from: '2026-01-01', to: '2026-12-31' });
      expect(occ.map((o) => o.start)).toEqual(['2026-01-31']);
    });

    test('reviewer repro: monthly-on-31st never permanently drifts onto the 3rd', () => {
      const e = eventWithRule('20260131', 'FREQ=MONTHLY;COUNT=6');
      const occ = expandEvent(e, { from: '2026-01-01', to: '2026-12-31' });
      expect(occ.map((o) => o.start)).toEqual([
        '2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31', '2026-08-31', '2026-10-31',
      ]);
      expect(occ.some((o) => o.start.endsWith('-03'))).toBe(false);
    });

    test('reviewer repro: yearly Feb-29 never drifts onto Mar 1', () => {
      const e = eventWithRule('20240229', 'FREQ=YEARLY;COUNT=2');
      const occ = expandEvent(e, { from: '2024-01-01', to: '2029-12-31' });
      expect(occ.map((o) => o.start)).toEqual(['2024-02-29', '2028-02-29']);
      expect(occ.some((o) => o.start === '2025-03-01')).toBe(false);
    });
  });

  test('window clips occurrences to [from,to]', () => {
    const e = eventWithRule('20260706', 'FREQ=DAILY;COUNT=100');
    const occ = expandEvent(e, { from: '2026-07-08', to: '2026-07-10' });
    expect(occ.map((o) => o.start)).toEqual(['2026-07-08', '2026-07-09', '2026-07-10']);
    expect(occ.every((o) => !o.isSeed)).toBe(true);
  });

  test('an unsupported RRULE part is marked, not fabricated — only the seed appears', () => {
    const e = eventWithRule('20260706', 'FREQ=MONTHLY;BYMONTHDAY=1,15');
    expect(e.recurrence?.expansion).toBe('unsupported');
    expect(e.recurrence?.unsupportedReason).toContain('BYMONTHDAY');
    const occ = expandEvent(e, { from: '2026-07-01', to: '2026-12-31' });
    expect(occ.map((o) => o.start)).toEqual(['2026-07-06']);
    expect(occ[0]?.isSeed).toBe(true);
  });

  test('BYDAY with an ordinal (monthly nth-weekday) is unsupported, not wrongly expanded', () => {
    const e = eventWithRule('20260706', 'FREQ=MONTHLY;BYDAY=3TU');
    expect(e.recurrence?.expansion).toBe('unsupported');
    const occ = expandEvent(e, { from: '2026-07-01', to: '2026-12-31' });
    expect(occ.map((o) => o.start)).toEqual(['2026-07-06']);
  });

  test('an unknown FREQ is unsupported', () => {
    const e = eventWithRule('20260706', 'FREQ=HOURLY;COUNT=5');
    expect(e.recurrence?.expansion).toBe('unsupported');
    expect(e.recurrence?.unsupportedReason).toContain('HOURLY');
  });
});

// --- cross-zone comparator (F4) ----------------------------------------------

describe('compareEventDateTime / eventDateTimeEpochMs', () => {
  const utc = (value: string): EventDateTime => ({ value, kind: 'date-time', zone: 'utc' });
  const tzid = (value: string, tz: string): EventDateTime => ({ value, kind: 'date-time', zone: 'tzid', tzid: tz });
  const floating = (value: string): EventDateTime => ({ value, kind: 'date-time', zone: 'floating' });
  const allDay = (value: string): EventDateTime => ({ value, kind: 'date', zone: 'floating' });

  test('two real UTC instants sort by true chronological order', () => {
    const earlier = utc('2026-07-06T09:00:00Z');
    const later = utc('2026-07-06T10:00:00Z');
    expect(compareEventDateTime(earlier, later)).toBeLessThan(0);
    expect([later, earlier].sort(compareEventDateTime)).toEqual([earlier, later]);
  });

  test('an all-day date sorts before a same-day timed UTC instant', () => {
    const day = allDay('2026-07-06');
    const timed = utc('2026-07-06T09:00:00Z');
    expect(compareEventDateTime(day, timed)).toBeLessThan(0);
  });

  // Reviewer's exact case: a tzid wall-clock reading of 01:00 vs a real UTC instant
  // of 05:00 on the same calendar day. This build ships no tz database, so it cannot
  // compute the true offset for America/New_York on this date — the documented
  // best-effort approximation reads the tzid wall-clock digits AS IF they were UTC.
  // This pins that documented, deterministic behavior (not a claim of true accuracy).
  test('01:00 tzid vs 05:00Z: the documented wall-clock-as-UTC approximation is deterministic', () => {
    const tzidEarly = tzid('2026-07-06T01:00:00', 'America/New_York');
    const utcLater = utc('2026-07-06T05:00:00Z');
    expect(eventDateTimeEpochMs(tzidEarly)).toBe(Date.UTC(2026, 6, 6, 1, 0, 0));
    expect(eventDateTimeEpochMs(utcLater)).toBe(Date.UTC(2026, 6, 6, 5, 0, 0));
    expect(compareEventDateTime(tzidEarly, utcLater)).toBeLessThan(0);
    expect([utcLater, tzidEarly].sort(compareEventDateTime)).toEqual([tzidEarly, utcLater]);
  });

  test('floating and tzid values sort by their wall-clock digits within the same zone', () => {
    const first = floating('2026-07-06T08:00:00');
    const second = floating('2026-07-06T09:00:00');
    expect(compareEventDateTime(first, second)).toBeLessThan(0);
  });
});

// --- SubscriptionStore (fake feeds + fake clock) ----------------------------

/** A scripted fake fetcher: maps url -> queued responses; records requests seen. */
function makeFakeFetcher(script: Map<string, FeedFetchResult[]>) {
  const requests: { url: string; etag?: string; lastModified?: string }[] = [];
  const fetcher = async (req: { url: string; etag?: string; lastModified?: string }): Promise<FeedFetchResult> => {
    requests.push({ url: req.url, ...(req.etag ? { etag: req.etag } : {}), ...(req.lastModified ? { lastModified: req.lastModified } : {}) });
    const queue = script.get(req.url);
    if (!queue || queue.length === 0) return { kind: 'error', status: 404, message: 'no scripted response' };
    return queue.length === 1 ? queue[0]! : queue.shift()!;
  };
  return { fetcher, requests };
}

describe('SubscriptionStore', () => {
  test('add() is paste-URL-and-done: derives the name from X-WR-CALNAME and stores events', async () => {
    const url = 'https://calendar.example/secret/abc123.ics';
    const { fetcher } = makeFakeFetcher(new Map([[url, [{ kind: 'ok', body: BASIC_ICS, etag: 'W/"v1"' }]]]));
    let now = 1_000_000;
    const store = new SubscriptionStore({ fetcher, clock: () => now });

    const res = await store.add({ url });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.subscription.name).toBe('Team Calendar'); // from X-WR-CALNAME, no name field required
    expect(res.subscription.health).toBe('ok');
    expect(res.subscription.eventCount).toBe(1);
    expect(res.subscription.refreshIntervalMs).toBe(DEFAULT_REFRESH_INTERVAL_MS);
    expect(store.events('Team Calendar')).toHaveLength(1);
  });

  test('refresh sends conditional validators and keeps events on 304', async () => {
    const url = 'https://cal.example/feed.ics';
    const script = new Map<string, FeedFetchResult[]>([[url, [
      { kind: 'ok', body: BASIC_ICS, etag: 'W/"v1"' },
      { kind: 'not-modified', etag: 'W/"v1"' },
    ]]]);
    const { fetcher, requests } = makeFakeFetcher(script);
    let now = 0;
    const store = new SubscriptionStore({ fetcher, clock: () => now });
    await store.add({ url });

    now += DEFAULT_REFRESH_INTERVAL_MS + 1; // make it due
    const report = await store.refresh('Team Calendar');
    expect(report.outcome).toBe('not-modified');
    expect(report.health).toBe('ok');
    expect(store.events('Team Calendar')).toHaveLength(1); // kept
    // The conditional refresh echoed the stored etag back to the server.
    expect(requests[requests.length - 1]?.etag).toBe('W/"v1"');
  });

  test('not-due refresh is skipped without touching the network', async () => {
    const url = 'https://cal.example/feed.ics';
    const { fetcher, requests } = makeFakeFetcher(new Map([[url, [{ kind: 'ok', body: BASIC_ICS }]]]));
    let now = 0;
    const store = new SubscriptionStore({ fetcher, clock: () => now });
    await store.add({ url });
    const before = requests.length;
    const report = await store.refresh('Team Calendar'); // not forced, not due
    expect(report.outcome).toBe('skipped');
    expect(requests.length).toBe(before); // no extra fetch
  });

  test('reports unreachable honestly and keeps prior events', async () => {
    const url = 'https://cal.example/feed.ics';
    const script = new Map<string, FeedFetchResult[]>([[url, [
      { kind: 'ok', body: BASIC_ICS },
      { kind: 'error', status: 503, message: 'service unavailable' },
    ]]]);
    const { fetcher } = makeFakeFetcher(script);
    let now = 0;
    const store = new SubscriptionStore({ fetcher, clock: () => now });
    await store.add({ url });
    now += DEFAULT_REFRESH_INTERVAL_MS + 1;
    const report = await store.refresh('Team Calendar');
    expect(report.outcome).toBe('unreachable');
    expect(report.detail).toContain('503');
    expect(store.get('Team Calendar')?.health).toBe('unreachable');
    expect(store.events('Team Calendar')).toHaveLength(1); // last-good kept
  });

  test('stale health carries its age once data ages past the window', async () => {
    const url = 'https://cal.example/feed.ics';
    const { fetcher } = makeFakeFetcher(new Map([[url, [{ kind: 'ok', body: BASIC_ICS }]]]));
    let now = 0;
    const store = new SubscriptionStore({ fetcher, clock: () => now });
    await store.add({ url });
    expect(store.get('Team Calendar')?.health).toBe('ok');
    now += DEFAULT_REFRESH_INTERVAL_MS * 2 + 1; // past STALE_MULTIPLE
    const sub = store.get('Team Calendar')!;
    expect(sub.health).toBe('stale');
    expect(sub.detail).toContain('min ago');
  });

  test('validateByFetch refuses a non-calendar body naming the parse stage', async () => {
    const url = 'https://cal.example/notacal';
    const { fetcher } = makeFakeFetcher(new Map([[url, [{ kind: 'ok', body: '<html>nope</html>' }]]]));
    const store = new SubscriptionStore({ fetcher, clock: () => 0 });
    const res = await store.validateByFetch(url);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe('parse');
  });

  test('validateByFetch names the fetch stage on a network failure', async () => {
    const url = 'https://cal.example/down';
    const { fetcher } = makeFakeFetcher(new Map([[url, [{ kind: 'error', status: 500, message: 'boom' }]]]));
    const store = new SubscriptionStore({ fetcher, clock: () => 0 });
    const res = await store.validateByFetch(url);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe('fetch');
    expect(res.detail).toContain('500');
  });

  test('a too-fast refresh interval is clamped up to the floor', async () => {
    const url = 'https://cal.example/feed.ics';
    const { fetcher } = makeFakeFetcher(new Map([[url, [{ kind: 'ok', body: BASIC_ICS }]]]));
    const store = new SubscriptionStore({ fetcher, clock: () => 0 });
    const res = await store.add({ url, refreshIntervalMs: 1000 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.subscription.refreshIntervalMs).toBe(MIN_REFRESH_INTERVAL_MS);
  });

  test('snapshot() excludes events; restore() + refreshDue() reloads them', async () => {
    const url = 'https://cal.example/feed.ics';
    const { fetcher } = makeFakeFetcher(new Map([[url, [{ kind: 'ok', body: BASIC_ICS }]]]));
    let now = 0;
    const store = new SubscriptionStore({ fetcher, clock: () => now });
    await store.add({ url });
    const snap = store.snapshot();
    expect(snap).toHaveLength(1);
    expect(JSON.stringify(snap)).not.toContain('VEVENT');

    const store2 = new SubscriptionStore({ fetcher, clock: () => now });
    store2.restore(snap);
    expect(store2.events('Team Calendar')).toHaveLength(0); // not loaded yet
    await store2.refreshDue({ force: true });
    expect(store2.events('Team Calendar')).toHaveLength(1);
  });

  test('remove() drops a subscription', async () => {
    const url = 'https://cal.example/feed.ics';
    const { fetcher } = makeFakeFetcher(new Map([[url, [{ kind: 'ok', body: BASIC_ICS }]]]));
    const store = new SubscriptionStore({ fetcher, clock: () => 0 });
    await store.add({ url });
    expect(store.remove('Team Calendar')).toBe(true);
    expect(store.list()).toHaveLength(0);
  });
});

describe('maskFeedUrl', () => {
  test('masks the secret path while keeping scheme+host', () => {
    const masked = maskFeedUrl('https://calendar.google.com/calendar/ical/abc123secret/basic.ics');
    expect(masked).toContain('https://calendar.google.com');
    expect(masked).not.toContain('abc123secret');
    expect(masked).toContain('…');
  });
});

describe('purity', () => {
  test('no calendar module reaches fs/net/tty/process/crypto/path/os/child_process, Buffer, or a bare (non-relative) import', () => {
    const files = readdirSync(CALENDAR_DIR).filter((f) => f.endsWith('.ts'));
    const banned: { readonly name: string; readonly pattern: RegExp }[] = [
      { name: 'node:fs', pattern: /from ['"]node:fs['"]/ },
      { name: 'node:net', pattern: /from ['"]node:net['"]/ },
      { name: 'node:tty', pattern: /from ['"]node:tty['"]/ },
      { name: 'node:process', pattern: /from ['"]node:process['"]/ },
      { name: 'node:http(s)', pattern: /from ['"]node:https?['"]/ },
      { name: 'node:crypto', pattern: /from ['"]node:crypto['"]/ },
      { name: 'node:path', pattern: /from ['"]node:path['"]/ },
      { name: 'node:os', pattern: /from ['"]node:os['"]/ },
      { name: 'node:child_process', pattern: /from ['"]node:child_process['"]/ },
      { name: 'process.stdout/stderr/env', pattern: /process\.(stdout|stderr|env)/ },
      { name: 'global fetch(...)', pattern: /\bfetch\s*\(/ },
      { name: 'Buffer', pattern: /\bBuffer\b/ },
      // Any import specifier that is neither relative ('./'/'../') nor a type-only
      // re-export of a relative path — i.e. a bare package/builtin specifier. Every
      // real import in this module is (and must stay) relative; this catches any
      // new bare specifier (a builtin this list doesn't yet name explicitly, or an
      // npm dependency) the moment it is introduced.
      { name: 'bare (non-relative) import specifier', pattern: /from\s+['"](?!\.{1,2}\/)[^'"]+['"]/ },
    ];
    for (const f of files) {
      const src = readFileSync(resolve(CALENDAR_DIR, f), 'utf8');
      for (const { name, pattern } of banned) {
        expect({ file: f, banned: name, matched: pattern.test(src) }).toEqual({ file: f, banned: name, matched: false });
      }
    }
  });
});
