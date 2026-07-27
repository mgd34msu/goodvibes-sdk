/**
 * caldav-ics-generate.ts — RFC 5545 (iCalendar) writing for the CalDAV backend.
 *
 * The other half of `caldav-ics.ts`: what a PUT of a new event serialises with,
 * and what `calendar.ics.export` renders a whole collection with.
 *
 * Pure, including the stamp. `dtStamp` is a required input rather than a
 * defaulted `new Date()` so that no clock is read here — the caller passes the
 * instant from its own injected clock, which is also what makes a generated
 * .ics byte-for-byte reproducible under test.
 */

import { escapeText } from './caldav-ics.js';

export interface GenerateICalInput {
  readonly uid: string;
  readonly summary: string;
  /** ISO-8601. */
  readonly start: string;
  /** ISO-8601. */
  readonly end: string;
  readonly description?: string | undefined;
  readonly location?: string | undefined;
  /** Raw addresses or display names. */
  readonly attendees?: readonly string[] | undefined;
  readonly organizer?: string | undefined;
  readonly status?: string | undefined;
  readonly recurrence?: string | undefined;
  readonly allDay?: boolean | undefined;
  /** Stamp time (ISO-8601). Required: this module never reads a clock. */
  readonly dtStamp: string;
}

const PRODID = '-//GoodVibes//CalDAV Connector//EN';
const CRLF = '\r\n';
const UTF8 = new TextEncoder();

/** Number of octets a string occupies when encoded as UTF-8. */
function octetLength(value: string): number {
  return UTF8.encode(value).length;
}

/**
 * Fold a content line to <=75 octets per line (RFC 5545 §3.1), with
 * continuation lines prefixed by a single space.
 *
 * Folding is measured in UTF-8 OCTETS, not JS string length (UTF-16 code
 * units), and a fold boundary is never placed in the middle of a multi-byte
 * codepoint. Iterating by Unicode codepoint (the string iterator yields whole
 * codepoints rather than surrogate halves) keeps the wire bytes valid UTF-8
 * even for non-ASCII SUMMARY/DESCRIPTION/LOCATION content.
 */
export function foldLine(line: string): string {
  if (octetLength(line) <= 75) return line;
  const parts: string[] = [];
  let chunk = '';
  let chunkOctets = 0;
  // First line budget is 75 octets; continuation lines reserve 1 octet for the
  // leading space, leaving 74 octets of payload.
  let budget = 75;
  for (const cp of line) {
    const cpOctets = octetLength(cp);
    if (chunkOctets + cpOctets > budget) {
      parts.push(chunk);
      chunk = cp;
      chunkOctets = cpOctets;
      budget = 74;
    } else {
      chunk += cp;
      chunkOctets += cpOctets;
    }
  }
  if (chunk.length > 0 || parts.length === 0) parts.push(chunk);
  return parts.map((part, index) => (index === 0 ? part : ` ${part}`)).join(CRLF);
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Format an ISO-8601 datetime as a UTC iCalendar timestamp: YYYYMMDDTHHMMSSZ. */
export function formatICalDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date value: ${iso}`);
  }
  return (
    `${String(date.getUTCFullYear())}`
    + `${pad2(date.getUTCMonth() + 1)}`
    + `${pad2(date.getUTCDate())}`
    + 'T'
    + `${pad2(date.getUTCHours())}`
    + `${pad2(date.getUTCMinutes())}`
    + `${pad2(date.getUTCSeconds())}`
    + 'Z'
  );
}

/**
 * Format an ISO-8601 datetime as an all-day iCalendar DATE: YYYYMMDD.
 *
 * An all-day DATE is a floating calendar day with no timezone (RFC 5545
 * §3.3.4), so it must reflect the calendar day as written in the INPUT's own
 * offset, not the UTC instant. Deriving YYYYMMDD from UTC components would roll
 * an input such as `2026-12-25T00:00:00+09:00` back to the 24th, corrupting the
 * DATE. We read the wall-clock date components directly from the ISO string's
 * leading `YYYY-MM-DD` (which, for any offset, IS that offset's calendar day)
 * and fall back to UTC components only for non-extended forms that omit a date
 * prefix.
 */
export function formatICalDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date value: ${iso}`);
  }
  const wallDate = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (wallDate) {
    const [, y, m, d] = wallDate;
    return `${y ?? ''}${m ?? ''}${d ?? ''}`;
  }
  return (
    `${String(date.getUTCFullYear())}`
    + `${pad2(date.getUTCMonth() + 1)}`
    + `${pad2(date.getUTCDate())}`
  );
}

function normaliseAttendeeForOutput(entry: string): { readonly value: string; readonly cn?: string } {
  const trimmed = entry.trim();
  if (/@/.test(trimmed) && !/^mailto:/i.test(trimmed)) {
    return { value: `mailto:${trimmed}` };
  }
  if (/^mailto:/i.test(trimmed)) {
    return { value: trimmed };
  }
  // A bare display name (no address): encode as CN with an empty mailto target.
  return { value: 'mailto:invalid@invalid', cn: trimmed };
}

/**
 * Render a CN parameter for an ATTENDEE/ORGANIZER line. RFC 5545 §3.2 requires
 * a param value containing COLON, SEMICOLON, or COMMA to be DQUOTE-quoted:
 * without quoting, a parser splits params on the unquoted ';' and ends the
 * value at the first unquoted ':', mis-parsing a display name like 'Doe, Jane'
 * or 'Team: Eng'. DQUOTE itself may not appear inside a quoted param value
 * (§3.2), so any embedded DQUOTE is dropped to keep the emitted line
 * well-formed.
 */
function formatCNParam(cn: string): string {
  const sanitised = cn.replace(/"/g, '');
  const needsQuoting = /[:;,]/.test(sanitised);
  return `;CN=${needsQuoting ? `"${sanitised}"` : sanitised}`;
}

/** One VEVENT block, without the enclosing VCALENDAR. */
export function eventToVEvent(input: GenerateICalInput): string[] {
  const lines: string[] = [];
  lines.push('BEGIN:VEVENT');
  lines.push(`UID:${input.uid}`);
  lines.push(`DTSTAMP:${formatICalDateTime(input.dtStamp)}`);
  if (input.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${formatICalDate(input.start)}`);
    lines.push(`DTEND;VALUE=DATE:${formatICalDate(input.end)}`);
  } else {
    lines.push(`DTSTART:${formatICalDateTime(input.start)}`);
    lines.push(`DTEND:${formatICalDateTime(input.end)}`);
  }
  lines.push(`SUMMARY:${escapeText(input.summary)}`);
  if (input.description !== undefined && input.description.length > 0) {
    lines.push(`DESCRIPTION:${escapeText(input.description)}`);
  }
  if (input.location !== undefined && input.location.length > 0) {
    lines.push(`LOCATION:${escapeText(input.location)}`);
  }
  if (input.status !== undefined && input.status.length > 0) {
    lines.push(`STATUS:${input.status.toUpperCase()}`);
  }
  if (input.recurrence !== undefined && input.recurrence.length > 0) {
    lines.push(`RRULE:${input.recurrence}`);
  }
  if (input.organizer !== undefined && input.organizer.length > 0) {
    const org = normaliseAttendeeForOutput(input.organizer);
    lines.push(`ORGANIZER${org.cn ? formatCNParam(org.cn) : ''}:${org.value}`);
  }
  for (const attendee of input.attendees ?? []) {
    if (attendee.trim().length === 0) continue;
    const norm = normaliseAttendeeForOutput(attendee);
    lines.push(`ATTENDEE${norm.cn ? formatCNParam(norm.cn) : ''}:${norm.value}`);
  }
  lines.push('END:VEVENT');
  return lines;
}

function wrapCalendar(eventLines: readonly string[]): string {
  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN'];
  lines.push(...eventLines);
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join(CRLF)}${CRLF}`;
}

/** A full VCALENDAR wrapping one event. CRLF line endings, as the wire wants. */
export function generateICS(input: GenerateICalInput): string {
  return wrapCalendar(eventToVEvent(input));
}

/** A full VCALENDAR wrapping many events (what export renders). */
export function generateCalendar(events: readonly GenerateICalInput[]): string {
  const lines: string[] = [];
  for (const event of events) lines.push(...eventToVEvent(event));
  return wrapCalendar(lines);
}
