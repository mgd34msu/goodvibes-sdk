/**
 * caldav-ics.ts — RFC 5545 (iCalendar) reading for the CalDAV calendar backend.
 *
 * Pure: no network, no filesystem, no clock, no secret. It is what the CalDAV
 * gateway service deserialises REPORT/GET payloads with, and what
 * `calendar.ics.import` parses an uploaded file with.
 *
 * The VEVENT subset covered is the one calendar connectors actually need:
 * SUMMARY, DTSTART, DTEND, DESCRIPTION, LOCATION, UID, ATTENDEE, ORGANIZER,
 * STATUS, RRULE, plus all-day (VALUE=DATE) detection. Every other property is
 * kept verbatim in `raw`, so a parse/serialise round-trip does not quietly drop
 * what this module does not model.
 *
 * Why this exists alongside `ics-parser.ts`: that parser answers "what is on
 * this calendar" for the merged-calendar model and returns `CalendarEvent`s.
 * This one is the CalDAV wire codec — it keeps the raw ATTENDEE/ORGANIZER
 * values a PUT has to re-emit, and the display names a response may show, which
 * are two different things and must not be confused (see `ICalAttendee`).
 */

/** One ATTENDEE, split into what may be shown and what must be re-emitted. */
export interface ICalAttendee {
  /** Display name only (CN parameter, or the local-part of the address). */
  readonly displayName: string;
  /**
   * The property value exactly as it arrived (e.g. `mailto:a@b.example`).
   * Re-emitted on a PUT so an import preserves the original addressing; never
   * surfaced in a gateway response, where display names are all a caller gets.
   */
  readonly rawValue: string;
}

export interface ParsedICalEvent {
  readonly uid: string;
  readonly summary: string;
  readonly description?: string;
  readonly location?: string;
  /** ISO-8601 start. */
  readonly start: string;
  /** ISO-8601 end. */
  readonly end: string;
  readonly allDay: boolean;
  readonly status?: string;
  /** Raw RRULE value (e.g. "FREQ=WEEKLY;COUNT=10") when present. */
  readonly recurrence?: string;
  readonly attendees: readonly ICalAttendee[];
  /** Organizer display name only (CN or local-part). */
  readonly organizer?: string;
  /** Raw organizer value, for re-emission only. */
  readonly organizerRaw?: string;
  /** Every property not modelled above, keyed by upper-case name. */
  readonly raw: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Line unfolding (RFC 5545 §3.1)
// ---------------------------------------------------------------------------

/**
 * Unfold folded content lines: a line beginning with a space or tab is a
 * continuation of the previous one, not a line of its own. Blank lines are
 * dropped — no iCalendar property is expressible as one.
 */
export function unfoldLines(content: string): string[] {
  const rawLines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines: string[] = [];
  for (const rawLine of rawLines) {
    if ((rawLine.startsWith(' ') || rawLine.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += rawLine.slice(1);
    } else {
      lines.push(rawLine);
    }
  }
  return lines.filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Text escaping (RFC 5545 §3.3.11)
// ---------------------------------------------------------------------------

export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}

export function unescapeText(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === 'n' || next === 'N') {
        result += '\n';
      } else if (next === '\\' || next === ';' || next === ',') {
        result += next;
      } else {
        // Unrecognised escape sequence (not one of \\ \; \, \n \N): RFC 5545
        // defines no such sequence, so the backslash is a literal character.
        // Preserve BOTH the backslash and the following char so values that
        // happen to contain a literal backslash round-trip losslessly.
        result += ch;
        result += next;
      }
      i += 1;
    } else {
      result += ch;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Date/time parsing (RFC 5545 §3.3.5)
// ---------------------------------------------------------------------------

/**
 * Parse an iCalendar date or date-time value into an ISO-8601 string.
 * Supports YYYYMMDD (DATE), YYYYMMDDTHHMMSSZ (UTC), and YYYYMMDDTHHMMSS
 * (floating/local).
 */
export function parseICalDate(value: string): { readonly iso: string; readonly allDay: boolean } {
  const trimmed = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const iso = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), 0, 0, 0)).toISOString();
    return { iso, allDay: true };
  }
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(trimmed);
  if (dateTime) {
    const [, y, m, d, hh, mm, ss, zulu] = dateTime;
    // A trailing 'Z' marks an absolute UTC instant. Without it the value is a
    // floating/local time (RFC 5545 §3.3.5): it has no offset and denotes the
    // wall-clock time in the observer's own zone. Interpreting it via Date.UTC
    // would relabel that wall-clock as UTC and shift the resulting ISO instant
    // by the local offset on round-trip; we instead build it through the local
    // Date constructor so the ISO reflects the same wall-clock in local time.
    const date = zulu
      ? new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)))
      : new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
    return { iso: date.toISOString(), allDay: false };
  }
  throw new Error(`Unrecognised iCalendar date value: ${value}`);
}

// ---------------------------------------------------------------------------
// Property line parsing
// ---------------------------------------------------------------------------

interface ContentLine {
  readonly name: string;
  readonly params: Readonly<Record<string, string>>;
  readonly value: string;
}

/** Split a `NAME;PARAM=foo;OTHER="a;b"` prefix on unquoted semicolons. */
function splitParams(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === ';' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

function parseContentLine(line: string): ContentLine {
  // Split name(+params) from value at the first unquoted colon.
  let colonIndex = -1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      colonIndex = i;
      break;
    }
  }
  if (colonIndex === -1) {
    return { name: line.toUpperCase(), params: {}, value: '' };
  }
  const namePart = line.slice(0, colonIndex);
  const value = line.slice(colonIndex + 1);
  const segments = splitParams(namePart);
  const name = (segments.shift() ?? '').toUpperCase();
  const params: Record<string, string> = {};
  for (const segment of segments) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    const key = segment.slice(0, eq).toUpperCase();
    let paramValue = segment.slice(eq + 1);
    if (paramValue.startsWith('"') && paramValue.endsWith('"')) {
      paramValue = paramValue.slice(1, -1);
    }
    params[key] = paramValue;
  }
  return { name, params, value };
}

/** The display name for an ATTENDEE/ORGANIZER value: its CN, or the local-part. */
export function attendeeDisplayName(params: Readonly<Record<string, string>>, value: string): string {
  const cn = params['CN'];
  if (cn && cn.trim().length > 0) return cn.trim();
  const withoutScheme = value.trim().replace(/^mailto:/i, '');
  const atIndex = withoutScheme.indexOf('@');
  if (atIndex > 0) return withoutScheme.slice(0, atIndex);
  return withoutScheme;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Accumulator for one VEVENT being parsed. Carries the VALUE type observed on
 * DTSTART/DTEND so `finaliseEvent` can enforce that they agree (RFC 5545
 * §3.8.2.2).
 */
interface ParsingEvent {
  uid?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  status?: string;
  recurrence?: string;
  organizer?: string;
  organizerRaw?: string;
  startIsDate?: boolean;
  endIsDate?: boolean;
  readonly attendees: ICalAttendee[];
  readonly raw: Record<string, string>;
}

function applyProperty(target: ParsingEvent, line: ContentLine): void {
  switch (line.name) {
    case 'UID':
      target.uid = line.value.trim();
      break;
    case 'SUMMARY':
      target.summary = unescapeText(line.value);
      break;
    case 'DESCRIPTION':
      target.description = unescapeText(line.value);
      break;
    case 'LOCATION':
      target.location = unescapeText(line.value);
      break;
    case 'STATUS':
      target.status = line.value.trim().toLowerCase();
      break;
    case 'RRULE':
      target.recurrence = line.value.trim();
      break;
    case 'DTSTART': {
      const { iso, allDay } = parseICalDate(line.value);
      // A value is DATE-typed when explicitly tagged VALUE=DATE or when the
      // serialised form carries no time component (parseICalDate -> allDay).
      const isDate = line.params['VALUE'] === 'DATE' || allDay;
      target.start = iso;
      target.startIsDate = isDate;
      target.allDay = isDate;
      break;
    }
    case 'DTEND': {
      const { iso, allDay } = parseICalDate(line.value);
      const isDate = line.params['VALUE'] === 'DATE' || allDay;
      target.end = iso;
      target.endIsDate = isDate;
      break;
    }
    case 'ATTENDEE':
      target.attendees.push({
        displayName: attendeeDisplayName(line.params, line.value),
        rawValue: line.value.trim(),
      });
      break;
    case 'ORGANIZER':
      target.organizer = attendeeDisplayName(line.params, line.value);
      target.organizerRaw = line.value.trim();
      break;
    default:
      target.raw[line.name] = line.value;
      break;
  }
}

function finaliseEvent(partial: ParsingEvent): ParsedICalEvent {
  // RFC 5545 §3.8.2.2: when DTEND is present it MUST share the VALUE type of
  // DTSTART. A DATE-valued DTSTART paired with a DATE-TIME DTEND (or vice
  // versa) is malformed; accepting it silently would corrupt all-day handling.
  if (
    partial.startIsDate !== undefined
    && partial.endIsDate !== undefined
    && partial.startIsDate !== partial.endIsDate
  ) {
    throw new Error(
      'VEVENT DTSTART and DTEND have mismatched VALUE types (one DATE, one DATE-TIME).',
    );
  }
  const start = partial.start ?? new Date(0).toISOString();
  const end = partial.end ?? start;
  return {
    uid: partial.uid ?? '',
    summary: partial.summary ?? '',
    ...(partial.description === undefined ? {} : { description: partial.description }),
    ...(partial.location === undefined ? {} : { location: partial.location }),
    start,
    end,
    allDay: partial.allDay ?? false,
    ...(partial.status === undefined ? {} : { status: partial.status }),
    ...(partial.recurrence === undefined ? {} : { recurrence: partial.recurrence }),
    attendees: partial.attendees,
    ...(partial.organizer === undefined ? {} : { organizer: partial.organizer }),
    ...(partial.organizerRaw === undefined ? {} : { organizerRaw: partial.organizerRaw }),
    raw: partial.raw,
  };
}

/**
 * Parse a full .ics document and return every VEVENT component in it. Multiple
 * VEVENTs (a VCALENDAR carrying recurrence overrides, or a whole collection
 * exported as one file) all come back.
 *
 * Throws — rather than dropping the event — on a date value it cannot read or
 * on a DTSTART/DTEND VALUE-type mismatch: a calendar entry silently landing on
 * the wrong day is worse than a refusal that names the file.
 */
export function parseICS(content: string): ParsedICalEvent[] {
  const lines = unfoldLines(content);
  const events: ParsedICalEvent[] = [];
  let current: ParsingEvent | null = null;

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      current = { attendees: [], raw: {} };
      continue;
    }
    if (upper === 'END:VEVENT') {
      if (current) {
        events.push(finaliseEvent(current));
        current = null;
      }
      continue;
    }
    if (!current) continue;
    applyProperty(current, parseContentLine(line));
  }

  return events;
}

/** The first UID in a raw .ics document, if it has one. */
export function extractUid(content: string): string | undefined {
  for (const line of unfoldLines(content)) {
    if (line.toUpperCase().startsWith('UID:')) {
      return line.slice(line.indexOf(':') + 1).trim();
    }
  }
  return undefined;
}
