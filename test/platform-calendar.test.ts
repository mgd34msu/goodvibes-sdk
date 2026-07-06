/**
 * platform-calendar.test.ts
 *
 * One-Platform Wave 4, A9 — external-calendar READ connectivity. Covers:
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
  expandEvent,
  maskFeedUrl,
  parseIcs,
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
  test('no calendar module reaches fs/net/tty/process', () => {
    const files = readdirSync(CALENDAR_DIR).filter((f) => f.endsWith('.ts'));
    const banned = [/from ['"]node:fs['"]/, /from ['"]node:net['"]/, /from ['"]node:tty['"]/, /from ['"]node:process['"]/, /from ['"]node:https?['"]/, /process\.(stdout|stderr|env)/, /\bfetch\s*\(/];
    for (const f of files) {
      const src = readFileSync(resolve(CALENDAR_DIR, f), 'utf8');
      for (const pat of banned) {
        expect({ file: f, matched: pat.test(src) }).toEqual({ file: f, matched: false });
      }
    }
  });
});
