/**
 * merged-calendar-model.ts — normalization of provider (Google Calendar API v3,
 * Microsoft Graph) events into the ONE merged event model shared with A9's .ics
 * path: A9's CalendarEvent shape plus a source label and the provider ids.
 *
 * Time-anchoring honesty follows A9's contract (this build ships no tz database):
 *  - An all-day value keeps its 'YYYY-MM-DD' date and is `zone: 'floating'`.
 *  - A timed value carrying an explicit numeric offset or a trailing Z is normalized
 *    to a real UTC instant (`zone: 'utc'`) — a fixed-offset -> UTC shift is pure
 *    arithmetic, NOT a named-zone conversion, so it is lossless and honest.
 *  - A timed value that only names a zone (no offset) is kept as wall time with the
 *    TZID recorded (`zone: 'tzid'`), never converted.
 *
 * Recurrence is delegated to the provider: the API clients request expanded single
 * instances (Google singleEvents=true, Graph calendarView), so each normalized event
 * is one concrete occurrence — no rule is fabricated here.
 */

import type { EventDateTime } from './types.js';
import type { CalendarProviderId, MergedCalendarEvent } from './oauth-types.js';

// ---------------------------------------------------------------------------
// Google Calendar API v3
// ---------------------------------------------------------------------------

interface GoogleDate {
  date?: unknown;
  dateTime?: unknown;
  timeZone?: unknown;
}
interface GoogleEvent {
  id?: unknown;
  iCalUID?: unknown;
  summary?: unknown;
  location?: unknown;
  description?: unknown;
  start?: GoogleDate;
  end?: GoogleDate;
  status?: unknown;
}

function googleDateTime(value: GoogleDate | undefined): EventDateTime | null {
  if (!value) return null;
  if (typeof value.date === 'string') {
    return { value: value.date, kind: 'date', zone: 'floating' };
  }
  if (typeof value.dateTime === 'string') {
    return normalizeOffsetDateTime(value.dateTime, typeof value.timeZone === 'string' ? value.timeZone : undefined);
  }
  return null;
}

/**
 * Normalize one Google event (already a concrete instance from singleEvents=true)
 * into the merged model. Returns null for an event with no usable start.
 */
export function normalizeGoogleEvent(
  raw: unknown,
  calendarId: string,
  calendarLabel: string,
): MergedCalendarEvent | null {
  const ev = (raw ?? {}) as GoogleEvent;
  const start = googleDateTime(ev.start);
  if (!start) return null;
  const id = typeof ev.id === 'string' ? ev.id : undefined;
  const uid = typeof ev.iCalUID === 'string' && ev.iCalUID.length > 0 ? ev.iCalUID : id ?? syntheticUid('google', calendarId);
  const end = googleDateTime(ev.end);
  return {
    uid,
    summary: typeof ev.summary === 'string' ? ev.summary : '(no title)',
    ...(typeof ev.location === 'string' ? { location: ev.location } : {}),
    ...(typeof ev.description === 'string' ? { description: ev.description } : {}),
    start,
    ...(end ? { end } : {}),
    source: 'google-api',
    ...(id ? { sourceEventId: id } : {}),
    calendarId,
    calendarLabel,
  };
}

// ---------------------------------------------------------------------------
// Microsoft Graph
// ---------------------------------------------------------------------------

interface GraphDate {
  dateTime?: unknown;
  timeZone?: unknown;
}
interface GraphEvent {
  id?: unknown;
  iCalUId?: unknown;
  subject?: unknown;
  bodyPreview?: unknown;
  location?: { displayName?: unknown } | undefined;
  start?: GraphDate;
  end?: GraphDate;
  isAllDay?: unknown;
}

function graphDateTime(value: GraphDate | undefined, isAllDay: boolean): EventDateTime | null {
  if (!value || typeof value.dateTime !== 'string') return null;
  const zone = typeof value.timeZone === 'string' ? value.timeZone : 'UTC';
  if (isAllDay) {
    // Graph all-day start is midnight; keep the date part as a floating date.
    return { value: value.dateTime.slice(0, 10), kind: 'date', zone: 'floating' };
  }
  if (zone === 'UTC') {
    // Graph returns UTC wall time without an offset; stamp it as real UTC.
    const iso = value.dateTime.endsWith('Z') ? isoSeconds(value.dateTime) : `${isoSeconds(value.dateTime)}Z`;
    return { value: iso, kind: 'date-time', zone: 'utc' };
  }
  // A named zone with no offset: keep wall time, record the TZID, do NOT convert.
  return { value: isoSeconds(value.dateTime), kind: 'date-time', zone: 'tzid', tzid: zone };
}

/** Normalize one Graph event (a concrete instance from calendarView) into the model. */
export function normalizeGraphEvent(
  raw: unknown,
  calendarId: string,
  calendarLabel: string,
): MergedCalendarEvent | null {
  const ev = (raw ?? {}) as GraphEvent;
  const isAllDay = ev.isAllDay === true;
  const start = graphDateTime(ev.start, isAllDay);
  if (!start) return null;
  const id = typeof ev.id === 'string' ? ev.id : undefined;
  const uid = typeof ev.iCalUId === 'string' && ev.iCalUId.length > 0 ? ev.iCalUId : id ?? syntheticUid('microsoft', calendarId);
  const end = graphDateTime(ev.end, isAllDay);
  const location = ev.location && typeof ev.location.displayName === 'string' ? ev.location.displayName : undefined;
  return {
    uid,
    summary: typeof ev.subject === 'string' ? ev.subject : '(no title)',
    ...(location ? { location } : {}),
    ...(typeof ev.bodyPreview === 'string' && ev.bodyPreview.length > 0 ? { description: ev.bodyPreview } : {}),
    start,
    ...(end ? { end } : {}),
    source: 'microsoft-graph',
    ...(id ? { sourceEventId: id } : {}),
    calendarId,
    calendarLabel,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a date-time that may carry a numeric offset or trailing Z into a real
 * UTC instant. A value with only a named zone (no offset) is impossible here (the
 * Google API always includes an offset on dateTime), but we defend: if Date cannot
 * parse it, keep the wall value as tzid when a zone was named, else floating.
 */
export function normalizeOffsetDateTime(value: string, namedZone?: string): EventDateTime {
  const hasOffset = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value);
  if (hasOffset) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) {
      return { value: new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'), kind: 'date-time', zone: 'utc' };
    }
  }
  if (namedZone) return { value: isoSeconds(value), kind: 'date-time', zone: 'tzid', tzid: namedZone };
  return { value: isoSeconds(value), kind: 'date-time', zone: 'floating' };
}

/** Trim a provider date-time to whole-second ISO (drop sub-second + any offset tail). */
function isoSeconds(value: string): string {
  const trimmed = value.replace(/\.\d+/, '');
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(trimmed);
  return m ? m[1]! : trimmed;
}

function syntheticUid(provider: CalendarProviderId, calendarId: string): string {
  return `goodvibes-${provider}-${calendarId}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Cross-zone chronological ordering (F4)
// ---------------------------------------------------------------------------

/**
 * Best-effort epoch (ms) for one {@link EventDateTime}, for sorting a mixed list of
 * merged events across zones/kinds. THIS IS THE ONE DOCUMENTED FUNCTION every
 * consumer should sort through — a raw `localeCompare`/string sort on `.value` looks
 * like it works (ISO strings are lexicographically sortable) but silently produces
 * the wrong order the moment a `zone: 'utc'` value (a real instant) is compared
 * against a `zone: 'tzid'` or `zone: 'floating'` value (a wall-clock reading with an
 * unknown or undeclared offset) — e.g. a `tzid` event at `01:00` in
 * `America/New_York` and a `utc` event at `05:00Z` are close to the same real
 * instant (EDT is UTC-4), but a naive string/localeCompare sort of `'01:00:00'` vs
 * `'05:00:00Z'` treats them as 4-5 hours apart on the SAME axis, which they are not.
 *
 * Documented approximation (this build ships no tz database, so a true conversion is
 * not possible):
 *  - `kind: 'date'` (all-day) => midnight UTC of that date.
 *  - `zone: 'utc'` => the real epoch, via `Date.parse` of the (already-normalized,
 *    Z-suffixed) ISO value. Authoritative.
 *  - `zone: 'tzid'` or `zone: 'floating'` => the wall-clock digits are read AS IF
 *    they were UTC (no offset applied). This is an approximation, not the true
 *    instant — it keeps events within the SAME zone in correct relative order, and
 *    gives cross-zone comparisons a deterministic (if approximate) answer instead of
 *    an arbitrary one.
 */
export function eventDateTimeEpochMs(dt: EventDateTime): number {
  if (dt.kind === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dt.value);
    if (!m) return Number.NaN;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  if (dt.zone === 'utc') {
    const ms = Date.parse(dt.value);
    if (Number.isFinite(ms)) return ms;
  }
  // tzid / floating (or an unparsable utc value, defensively): treat the wall-clock
  // digits as if they were UTC — see the documented approximation above.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(dt.value);
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/**
 * Chronological comparator for {@link EventDateTime} values (ascending), suitable
 * for `Array.prototype.sort`. See {@link eventDateTimeEpochMs} for the documented
 * cross-zone approximation this is built on — this is the ONE function every
 * consumer should sort through instead of inventing its own string comparison.
 */
export function compareEventDateTime(a: EventDateTime, b: EventDateTime): number {
  return eventDateTimeEpochMs(a) - eventDateTimeEpochMs(b);
}

/** Sort {@link MergedCalendarEvent}s by start time, through {@link compareEventDateTime}. */
export function compareMergedCalendarEventsByStart(a: MergedCalendarEvent, b: MergedCalendarEvent): number {
  return compareEventDateTime(a.start, b.start);
}
