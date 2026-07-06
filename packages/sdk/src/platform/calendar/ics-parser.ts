/**
 * ics-parser.ts — a pure, dependency-free iCalendar (RFC 5545) reader.
 *
 * Vendored on purpose. The SDK's `packages/sdk` ships ZERO third-party runtime
 * dependencies (workspace packages only — see packages/sdk/package.json), and it
 * guards that with bundle-budget / browser-compat / no-any gates. Pulling a general
 * ICS library in for the read-focused subset we actually need would break that
 * convention for little gain; this focused reader matches repo style and is easy to
 * hold honest. See the decision record for the vendored-vs-dependency ruling and the
 * exact supported subset.
 *
 * Scope of what this reads (documented, not faked):
 *  - VCALENDAR framing, X-WR-CALNAME for a calendar display name.
 *  - VEVENT: UID, SUMMARY, LOCATION, DESCRIPTION, DTSTART, DTEND, RRULE.
 *  - DTSTART/DTEND as VALUE=DATE ('YYYYMMDD') or date-time ('YYYYMMDDTHHMMSS'),
 *    with honest zone anchoring: trailing 'Z' => utc; TZID=... => tzid (wall time
 *    kept, NOT offset-converted, because this build has no tz database); otherwise
 *    floating. RRULE is captured raw and handed to the recurrence expander.
 *  - RFC 5545 line unfolding (a leading space/tab continues the previous line) and
 *    TEXT unescaping (\\n \\, \\; \\, \\\\).
 *
 * Everything unrecognised is ignored quietly EXCEPT the two things a caller must be
 * told about: a VEVENT with no usable DTSTART is `skipped` with a reason, and an
 * RRULE we do not fully expand is flagged on the event (in rrule.ts) — never dropped.
 *
 * PURE: no fs, no network, no process globals. Input is text; output is data.
 */

import type {
  CalendarEvent,
  EventDateTime,
  ParseDiagnostic,
  ParsedCalendar,
} from './types.js';
import { describeRecurrence } from './rrule.js';

interface ContentLine {
  readonly name: string;
  readonly params: ReadonlyMap<string, string>;
  readonly value: string;
  /** 1-based line number of the first physical line of this (possibly folded) line. */
  readonly line: number;
}

/**
 * Unfold physical lines into logical content lines (RFC 5545 §3.1). A line beginning
 * with a single space or tab is a continuation of the previous line.
 */
function unfold(text: string): { raw: string; line: number }[] {
  const physical = text.split(/\r\n|\r|\n/);
  const out: { raw: string; line: number }[] = [];
  for (let i = 0; i < physical.length; i++) {
    const cur = physical[i] ?? '';
    if ((cur.startsWith(' ') || cur.startsWith('\t')) && out.length > 0) {
      out[out.length - 1]!.raw += cur.slice(1);
    } else {
      out.push({ raw: cur, line: i + 1 });
    }
  }
  return out;
}

/** Parse one content line into name/params/value (RFC 5545 §3.1). */
function parseContentLine(raw: string, line: number): ContentLine | undefined {
  const colon = raw.indexOf(':');
  if (colon < 0) return undefined;
  const head = raw.slice(0, colon);
  const value = raw.slice(colon + 1);
  const segments = head.split(';');
  const name = (segments[0] ?? '').trim().toUpperCase();
  if (name === '') return undefined;
  const params = new Map<string, string>();
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i] ?? '';
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const pName = seg.slice(0, eq).trim().toUpperCase();
    let pVal = seg.slice(eq + 1).trim();
    if (pVal.startsWith('"') && pVal.endsWith('"')) pVal = pVal.slice(1, -1);
    params.set(pName, pVal);
  }
  return { name, params, value, line };
}

/** Unescape RFC 5545 TEXT (\\n, \\N, \\,, \\;, \\\\). */
function unescapeText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      const next = value[i + 1]!;
      if (next === 'n' || next === 'N') out += '\n';
      else if (next === ',' || next === ';' || next === '\\') out += next;
      else out += next;
      i++;
    } else {
      out += ch ?? '';
    }
  }
  return out;
}

const DATE_ONLY = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/;

/** Parse a DTSTART/DTEND value + params into an honest EventDateTime, or undefined. */
function parseDateValue(
  value: string,
  params: ReadonlyMap<string, string>,
): EventDateTime | undefined {
  const trimmed = value.trim();
  const isDateParam = params.get('VALUE') === 'DATE';
  const tzid = params.get('TZID');

  const dateMatch = DATE_ONLY.exec(trimmed);
  if (dateMatch && (isDateParam || !trimmed.includes('T'))) {
    const [, y, m, d] = dateMatch;
    return { value: `${y}-${m}-${d}`, kind: 'date', zone: 'floating' };
  }

  const dtMatch = DATE_TIME.exec(trimmed);
  if (dtMatch) {
    const [, y, m, d, hh, mm, ss, z] = dtMatch;
    const local = `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
    if (z === 'Z') {
      return { value: `${local}Z`, kind: 'date-time', zone: 'utc' };
    }
    if (tzid) {
      return { value: local, kind: 'date-time', zone: 'tzid', tzid };
    }
    return { value: local, kind: 'date-time', zone: 'floating' };
  }
  return undefined;
}

let syntheticCounter = 0;

/** Build a stable synthetic UID for a VEVENT that omitted one. */
function syntheticUid(start: EventDateTime | undefined, summary: string): string {
  syntheticCounter += 1;
  const stamp = start?.value ?? 'no-start';
  const slug = summary.replace(/\s+/g, '-').slice(0, 24) || 'event';
  return `synthetic:${slug}:${stamp}:${syntheticCounter}`;
}

interface VEventDraft {
  uid?: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  rrule?: string;
  startLine: number;
}

/**
 * Parse .ics text into typed events plus honest skip/diagnostic lists.
 *
 * @param text raw .ics content (file body or fetched feed body).
 */
export function parseIcs(text: string): ParsedCalendar {
  const lines = unfold(text);
  const events: CalendarEvent[] = [];
  const skipped: ParseDiagnostic[] = [];
  const diagnostics: ParseDiagnostic[] = [];
  let calendarName: string | undefined;

  let inEvent = false;
  let draft: VEventDraft | undefined;

  for (const { raw, line } of lines) {
    if (raw.trim() === '') continue;
    const cl = parseContentLine(raw, line);
    if (!cl) continue;

    if (cl.name === 'BEGIN' && cl.value.trim().toUpperCase() === 'VEVENT') {
      inEvent = true;
      draft = { startLine: line };
      continue;
    }
    if (cl.name === 'END' && cl.value.trim().toUpperCase() === 'VEVENT') {
      if (draft) finalizeEvent(draft, events, skipped, diagnostics);
      inEvent = false;
      draft = undefined;
      continue;
    }

    if (!inEvent) {
      if (cl.name === 'X-WR-CALNAME') calendarName = unescapeText(cl.value).trim();
      continue;
    }
    if (!draft) continue;

    switch (cl.name) {
      case 'UID':
        draft.uid = cl.value.trim();
        break;
      case 'SUMMARY':
        draft.summary = unescapeText(cl.value);
        break;
      case 'LOCATION':
        draft.location = unescapeText(cl.value);
        break;
      case 'DESCRIPTION':
        draft.description = unescapeText(cl.value);
        break;
      case 'DTSTART': {
        const parsed = parseDateValue(cl.value, cl.params);
        if (parsed) draft.start = parsed;
        else diagnostics.push({ line: cl.line, component: 'DTSTART', message: `Unrecognised DTSTART value '${cl.value.trim()}' — event kept without a usable start.` });
        break;
      }
      case 'DTEND': {
        const parsed = parseDateValue(cl.value, cl.params);
        if (parsed) draft.end = parsed;
        else diagnostics.push({ line: cl.line, component: 'DTEND', message: `Unrecognised DTEND value '${cl.value.trim()}' — event kept without an end.` });
        break;
      }
      case 'RRULE':
        draft.rrule = cl.value.trim();
        break;
      default:
        break;
    }
  }

  if (inEvent && draft) {
    diagnostics.push({ line: draft.startLine, component: 'VEVENT', message: 'VEVENT was not closed with END:VEVENT before end of feed — finalised anyway.' });
    finalizeEvent(draft, events, skipped, diagnostics);
  }

  return {
    ...(calendarName !== undefined ? { calendarName } : {}),
    events,
    skipped,
    diagnostics,
  };
}

function finalizeEvent(
  draft: VEventDraft,
  events: CalendarEvent[],
  skipped: ParseDiagnostic[],
  diagnostics: ParseDiagnostic[],
): void {
  if (!draft.start) {
    skipped.push({ line: draft.startLine, component: 'VEVENT', message: `Skipped VEVENT '${draft.summary ?? draft.uid ?? 'untitled'}' — no usable DTSTART.` });
    return;
  }
  const summary = draft.summary ?? '(no title)';
  const uid = draft.uid && draft.uid !== '' ? draft.uid : syntheticUid(draft.start, summary);

  let recurrence;
  if (draft.rrule) {
    recurrence = describeRecurrence(draft.rrule);
    if (recurrence.expansion === 'unsupported' && recurrence.unsupportedReason) {
      diagnostics.push({ line: draft.startLine, component: 'RRULE', message: `Event '${summary}': ${recurrence.unsupportedReason}` });
    }
  }

  const event: CalendarEvent = {
    uid,
    summary,
    ...(draft.location !== undefined ? { location: draft.location } : {}),
    ...(draft.description !== undefined ? { description: draft.description } : {}),
    start: draft.start,
    ...(draft.end !== undefined ? { end: draft.end } : {}),
    ...(recurrence !== undefined ? { recurrence } : {}),
  };
  events.push(event);
}
