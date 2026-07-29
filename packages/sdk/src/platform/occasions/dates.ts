/**
 * dates.ts — the calendar arithmetic behind an occasion.
 *
 * Everything here works on CALENDAR DATES (`YYYY-MM-DD`) rather than instants.
 * A birthday is not a moment in time: it is a day, and the only instant-shaped
 * question this feature asks — "what day is it where he is, and is it a
 * reasonable hour to say something" — is answered once, at the edge, by
 * {@link todayInZone} and {@link minutesOfDayInZone}. Everything downstream is
 * string dates and whole days, so nothing in the sweep can be off by an hour
 * because a caller happened to run it near midnight in a different offset.
 *
 * The zone helpers are the payments module's, not a second copy. `daemon.timezone`
 * was added there as a GENERAL daemon setting with the explicit note that the
 * next feature needing a calendar day should not add a second; this is that
 * feature, so it imports rather than re-derives. A second `resolveTimezone` that
 * disagreed about what an invalid zone means would put the sweep a day away from
 * the budget rollover with nothing saying why.
 */
import { dayKey, resolveTimezone } from '../payments/day.js';

/** How an occasion repeats. `annual` is the ordinary case; `once` never returns. */
export type OccasionRecurrence = 'annual' | 'once';

/**
 * A parsed occasion date.
 *
 * `recurring` has no year because the year is meaningless for an annual date and
 * carrying one invites arithmetic that uses it. `dated` has one because a `once`
 * occasion without a year is not a date at all.
 */
export type OccasionDate =
  | { readonly kind: 'recurring'; readonly month: number; readonly day: number }
  | { readonly kind: 'dated'; readonly year: number; readonly month: number; readonly day: number };

/** `YYYY-MM-DD`, the only date representation that crosses a module boundary here. */
export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_DAY = /^(\d{2})-(\d{2})$/;

/** Days in a month, 1-based, honouring the leap rule. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Parse `MM-DD` or `YYYY-MM-DD`, or `null` for anything else.
 *
 * The calendar is checked, not just the shape: `02-30` and `2026-13-01` are
 * refused. That matters because an occasion whose date does not exist would
 * otherwise sit in the file looking healthy and never fire, and "it never
 * reminded me" is the failure this whole feature exists to prevent.
 */
export function parseOccasionDate(value: string): OccasionDate | null {
  const trimmed = value.trim();
  const iso = ISO_DATE.exec(trimmed);
  if (iso !== null) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > daysInMonth(year, month)) return null;
    return { kind: 'dated', year, month, day };
  }
  const md = MONTH_DAY.exec(trimmed);
  if (md === null) return null;
  const month = Number(md[1]);
  const day = Number(md[2]);
  if (month < 1 || month > 12) return null;
  // A leap year is the permissive check on purpose: `02-29` is a real birthday
  // and refusing it here would reject the one date this module has a rule for.
  if (day < 1 || day > daysInMonth(2024, month)) return null;
  return { kind: 'recurring', month, day };
}

/** Render a date back to the form it is written in. Inverse of the parser. */
export function renderOccasionDate(date: OccasionDate): string {
  const month = String(date.month).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');
  return date.kind === 'dated' ? `${date.year}-${month}-${day}` : `${month}-${day}`;
}

export function toIsoDate(year: number, month: number, day: number): IsoDate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The occurrence of `date` in `year`, with 29 February landing on the 28th.
 *
 * Owner-facing consequence: in a non-leap year a 29 February birthday is raised
 * on the 28th rather than skipped. Skipping is the behaviour a naive
 * implementation produces (the date simply does not exist, so nothing matches)
 * and it means the feature silently does nothing three years in four for the
 * person it was built for. Landing early is a day out; landing never is the
 * whole failure.
 */
export function occurrenceInYear(date: OccasionDate, year: number): IsoDate {
  const day = Math.min(date.day, daysInMonth(year, date.month));
  return toIsoDate(year, date.month, day);
}

/**
 * The next occurrence on or after `today`, or `null` when there is not one.
 *
 * A `once` occasion that has passed returns `null` — it is over, and an
 * occasion that keeps proposing a date in the past would nudge forever.
 * An `annual` occasion always has a next one.
 */
export function nextOccurrence(
  date: OccasionDate,
  recurrence: OccasionRecurrence,
  today: IsoDate,
): IsoDate | null {
  const year = Number(today.slice(0, 4));
  if (recurrence === 'once') {
    if (date.kind !== 'dated') return null;
    const iso = toIsoDate(date.year, date.month, date.day);
    return iso >= today ? iso : null;
  }
  const thisYear = occurrenceInYear(date, year);
  return thisYear >= today ? thisYear : occurrenceInYear(date, year + 1);
}

/**
 * Whole days from `from` to `to`, negative when `to` is earlier.
 *
 * Computed through `Date.UTC` on the parsed parts rather than by parsing the
 * strings as instants: `new Date('2026-03-14')` is UTC midnight while
 * `new Date('2026-03-14T00:00')` is local midnight, and mixing the two puts the
 * count a day out for half the planet. Both ends are calendar dates already in
 * the owner's zone by the time they reach here, so UTC is simply the arithmetic
 * frame and carries no zone meaning at all.
 */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const start = utcMillis(from);
  const end = utcMillis(to);
  if (start === null || end === null) return Number.NaN;
  return Math.round((end - start) / 86_400_000);
}

function utcMillis(iso: IsoDate): number | null {
  const match = ISO_DATE.exec(iso.trim());
  if (match === null) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** `iso` shifted by `days`, still a calendar date. */
export function addDays(iso: IsoDate, days: number): IsoDate {
  const base = utcMillis(iso);
  if (base === null) return iso;
  const moved = new Date(base + days * 86_400_000);
  return toIsoDate(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

/** True when `iso` parses as a calendar date that exists. */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value.trim());
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** The calendar day it is where the owner is, from `daemon.timezone`. */
export function todayInZone(nowMs: number, timezone: string): IsoDate {
  return dayKey(nowMs, timezone) as string;
}

const CLOCK_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function clockFormatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = CLOCK_FORMATTERS.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    CLOCK_FORMATTERS.set(timezone, formatter);
  }
  return formatter;
}

/**
 * Minutes past midnight where the owner is.
 *
 * `hourCycle: 'h23'` and `formatToParts` together, rather than slicing a
 * formatted string: an `en-US` time format is 12-hour by default, so a naive
 * slice reads 10pm as minute 600 and puts the quiet-hours boundary fourteen
 * hours out — in the direction that sends a message at 10pm believing it is
 * 10am.
 */
export function minutesOfDayInZone(nowMs: number, timezone: string): number {
  const zone = resolveTimezone(timezone);
  const parts = clockFormatterFor(zone).formatToParts(new Date(nowMs));
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
  }
  // `h23` renders midnight as 00, but a runtime that renders it as 24 would
  // otherwise produce minute 1440, which is outside every window.
  return (hour % 24) * 60 + minute;
}
