/**
 * rrule.ts — a pure RRULE reader for an honest, deliberately-bounded subset.
 *
 * The honesty rule (see the decision record): an event's recurrence is either
 * FULLY and correctly expanded, or NOT expanded at all with an explicit reason.
 * We never emit occurrences from a rule we do not completely honor — a half-honored
 * BYMONTHDAY would put events on wrong dates, which is worse than not expanding.
 *
 * Fully supported (expanded to real occurrences):
 *  - FREQ = DAILY | WEEKLY | MONTHLY | YEARLY
 *  - INTERVAL (default 1)
 *  - COUNT  (occurrence cap)
 *  - UNTIL  (inclusive end bound; DATE or date-time, 'Z' or floating)
 *  - BYDAY  — ONLY for FREQ=WEEKLY with INTERVAL=1 and weekday-only tokens
 *             (MO,TU,WE,TH,FR,SA,SU with no leading ordinal). Under those
 *             conditions WKST does not change the matched set, so it is ignored
 *             safely. Any BYDAY outside that condition is treated as unsupported.
 *
 * Everything else present in the RRULE (BYMONTHDAY, BYMONTH, BYSETPOS, BYHOUR,
 * BYWEEKNO, BYYEARDAY, ordinal BYDAY, BYDAY on non-weekly, INTERVAL>1 with BYDAY,
 * or an unknown FREQ) marks the rule `unsupported` and names the offending part.
 *
 * PURE: no fs, no network, no process globals.
 */

import type {
  CalendarEvent,
  DateWindow,
  EventOccurrence,
  RecurrenceInfo,
} from './types.js';

const WEEKDAY_TOKENS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
type WeekdayToken = (typeof WEEKDAY_TOKENS)[number];

const KNOWN_FREQ = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

/** Parts we fully honor; anything else present makes the rule unsupported. */
const SUPPORTED_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'WKST', 'BYDAY']);

interface RRuleParts {
  readonly map: ReadonlyMap<string, string>;
}

function parseRRule(rule: string): RRuleParts {
  const map = new Map<string, string>();
  for (const seg of rule.split(';')) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const k = seg.slice(0, eq).trim().toUpperCase();
    const v = seg.slice(eq + 1).trim();
    if (k !== '') map.set(k, v);
  }
  return { map };
}

/**
 * Classify a raw RRULE into an honest RecurrenceInfo. Called by the parser at read
 * time so the event carries its expansion verdict before any window is known.
 */
export function describeRecurrence(rule: string): RecurrenceInfo {
  const { map } = parseRRule(rule);
  const freq = (map.get('FREQ') ?? '').toUpperCase();

  if (!KNOWN_FREQ.has(freq)) {
    return { rule, expansion: 'unsupported', unsupportedReason: `RRULE FREQ '${freq || '(missing)'}' is not expanded by this build` };
  }

  for (const part of map.keys()) {
    if (!SUPPORTED_PARTS.has(part)) {
      return { rule, expansion: 'unsupported', unsupportedReason: `RRULE part ${part} is not expanded by this build` };
    }
  }

  if (map.has('BYDAY')) {
    const byDayVerdict = classifyByDay(freq, map);
    if (byDayVerdict) return { rule, expansion: 'unsupported', unsupportedReason: byDayVerdict };
  }

  return { rule, expansion: 'full' };
}

/** Return an unsupported-reason string if this BYDAY is outside the honored subset, else undefined. */
function classifyByDay(freq: string, map: ReadonlyMap<string, string>): string | undefined {
  if (freq !== 'WEEKLY') {
    return `RRULE BYDAY on FREQ=${freq} is not expanded by this build (only weekly BYDAY is supported)`;
  }
  const interval = parseInterval(map);
  if (interval !== 1) {
    return 'RRULE BYDAY with INTERVAL>1 is not expanded by this build (week-boundary/WKST handling required)';
  }
  const tokens = (map.get('BYDAY') ?? '').split(',').map((t) => t.trim().toUpperCase());
  for (const tok of tokens) {
    if (!WEEKDAY_TOKENS.includes(tok as WeekdayToken)) {
      return `RRULE BYDAY token '${tok}' with an ordinal is not expanded by this build`;
    }
  }
  return undefined;
}

function parseInterval(map: ReadonlyMap<string, string>): number {
  const raw = map.get('INTERVAL');
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Parse an UNTIL value ('YYYYMMDD' or 'YYYYMMDDThhmmss[Z]') to a 'YYYY-MM-DD' date string. */
function parseUntilDate(raw: string): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(raw.trim());
  if (!m) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Extract 'YYYY-MM-DD' from an EventDateTime value. */
function datePart(value: string): string {
  return value.slice(0, 10);
}

/** Hard ceiling so a COUNT-less UNTIL-less rule cannot run away. */
const MAX_OCCURRENCES = 1000;

function toUtcDate(ymd: string): number {
  const [y, m, d] = ymd.split('-').map((s) => Number.parseInt(s, 10));
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function fromUtcDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const DAY_MS = 86_400_000;

/** Build an occurrence start string that mirrors the seed's kind/zone. */
function occurrenceStart(event: CalendarEvent, ymd: string): string {
  const s = event.start;
  if (s.kind === 'date') return ymd;
  const time = s.value.slice(10); // 'THH:mm:ss' or 'THH:mm:ssZ'
  return `${ymd}${time}`;
}

/**
 * Expand a (possibly recurring) event into concrete occurrences inside [window.from,
 * window.to] inclusive. A non-recurring event yields at most its single seed. An
 * event whose recurrence is `unsupported` yields ONLY its seed (if in-window),
 * flagged `isSeed`, never a fabricated series — the caller reads
 * `event.recurrence.expansion` to label it "recurrence not fully expanded".
 */
export function expandEvent(event: CalendarEvent, window: DateWindow): EventOccurrence[] {
  const seedYmd = datePart(event.start.value);
  const fromMs = toUtcDate(window.from);
  const toMs = toUtcDate(window.to);
  const seedMs = toUtcDate(seedYmd);

  const inWindow = (ms: number): boolean => ms >= fromMs && ms <= toMs;
  const seedOccurrence = (): EventOccurrence[] =>
    inWindow(seedMs) ? [{ event, start: occurrenceStart(event, seedYmd), isSeed: true }] : [];

  if (!event.recurrence || event.recurrence.expansion !== 'full') {
    return seedOccurrence();
  }

  const { map } = parseRRule(event.recurrence.rule);
  const freq = (map.get('FREQ') ?? '').toUpperCase();
  const interval = parseInterval(map);
  const count = map.has('COUNT') ? Number.parseInt(map.get('COUNT') ?? '', 10) : undefined;
  const untilYmd = map.has('UNTIL') ? parseUntilDate(map.get('UNTIL') ?? '') : undefined;
  const untilMs = untilYmd ? toUtcDate(untilYmd) : undefined;
  const byDay = map.has('BYDAY')
    ? new Set((map.get('BYDAY') ?? '').split(',').map((t) => WEEKDAY_TOKENS.indexOf(t.trim().toUpperCase() as WeekdayToken)))
    : undefined;

  const out: EventOccurrence[] = [];
  let emitted = 0; // series position (counts every occurrence, in or out of window)

  // `series` yields candidate UTC-midnight ms values in ascending series order.
  // Weekly BYDAY walks day-by-day emitting matching weekdays; every other supported
  // FREQ steps period-by-period from the seed. Both share one COUNT/UNTIL/window filter.
  const emit = (ms: number): boolean => {
    // Return false to STOP the whole series (COUNT reached, past UNTIL, past window end).
    if (count !== undefined && emitted >= count) return false;
    if (untilMs !== undefined && ms > untilMs) return false;
    if (ms > toMs) return false;
    emitted += 1;
    if (ms >= fromMs) {
      const ymd = fromUtcDate(ms);
      out.push({ event, start: occurrenceStart(event, ymd), isSeed: ms === seedMs });
    }
    return true;
  };

  if (freq === 'WEEKLY' && byDay) {
    let cursor = seedMs;
    for (let i = 0; i < MAX_OCCURRENCES * 8; i++) {
      if (byDay.has(new Date(cursor).getUTCDay())) {
        if (!emit(cursor)) break;
      } else if ((untilMs !== undefined && cursor > untilMs) || cursor > toMs) {
        break; // no more matches possible past UNTIL / window end
      }
      cursor += DAY_MS;
      if (cursor - seedMs > DAY_MS * 366 * 10) break; // 10-year hard ceiling
    }
    return out;
  }

  const step = freqStepper(freq, interval);
  let cursor = seedMs;
  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    if (!emit(cursor)) break;
    cursor = step(cursor);
  }
  return out;
}

/** A stepper that advances a UTC-midnight ms cursor by one FREQ*INTERVAL period. */
function freqStepper(freq: string, interval: number): (ms: number) => number {
  switch (freq) {
    case 'DAILY':
      return (ms) => ms + DAY_MS * interval;
    case 'WEEKLY':
      return (ms) => ms + DAY_MS * 7 * interval;
    case 'MONTHLY':
      return (ms) => {
        const d = new Date(ms);
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + interval, d.getUTCDate());
      };
    case 'YEARLY':
      return (ms) => {
        const d = new Date(ms);
        return Date.UTC(d.getUTCFullYear() + interval, d.getUTCMonth(), d.getUTCDate());
      };
    default:
      return (ms) => ms + DAY_MS;
  }
}

