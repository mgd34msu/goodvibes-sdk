/**
 * day.ts, what "today" means for a budget that resets daily.
 *
 * The daemon had no timezone concept before this. Schedules carried per-schedule
 * IANA names (scheduler/scheduler.ts, automation/schedules.ts) and `device.location.*`
 * is a paired phone's GPS permission, but nothing described where the daemon
 * itself thinks it is. A daily budget cannot be built without that, so
 * `daemon.timezone` is added as a GENERAL daemon setting rather than a payments
 * one, the next feature that needs a calendar day should not add a second.
 *
 * ── The midnight split is accepted, not smoothed ──────────────────────────
 *
 * Owner ruled it explicitly: $100 at 23:59 and $100 at 00:00 both go through.
 * A daily budget has a boundary and a boundary can be sat on. Anything that
 * "fixed" this, a rolling 24-hour window, a cooldown either side of midnight,
 * would be a different feature than the one he asked for, and the rolling
 * version is worse in the ordinary case because he could not predict when his
 * budget refreshed. There is a test that asserts the split behaves this way, so
 * a later round cannot quietly close it.
 *
 * ── Why totals are recomputed rather than counted ─────────────────────────
 *
 * Every spend record keeps its UTC instant. Today's totals are derived by
 * filtering those instants through the CURRENT timezone, never by incrementing a
 * stored counter. Otherwise changing `daemon.timezone` would roll the day over
 * and hand back a fresh budget, a trivial way around the limit, reachable by
 * anything that can write daemon config.
 */

/** A calendar day in some zone: 'YYYY-MM-DD'. */
export type DayKey = string & { readonly __dayKey: unique symbol };

/**
 * Validate an IANA timezone name.
 *
 * Same predicate the scheduler already trusts (`scheduler/scheduler.ts`),
 * lifted here so config validation and budget arithmetic cannot disagree about
 * what counts as a zone.
 */
export function isValidTimezone(timezone: string): boolean {
  if (timezone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone the daemon reckons calendar days in.
 *
 * Empty or invalid resolves to UTC. Invalid resolving to UTC rather than
 * throwing is deliberate: a bad zone in config must not make the budget
 * unevaluable, because "cannot evaluate the budget" would either block every
 * purchase or, worse, be caught somewhere upstream and treated as no limit.
 */
export function resolveTimezone(configured: string | undefined): string {
  const value = (configured ?? '').trim();
  if (value.length === 0) return 'UTC';
  return isValidTimezone(value) ? value : 'UTC';
}

const PART_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = PART_FORMATTERS.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    PART_FORMATTERS.set(timezone, formatter);
  }
  return formatter;
}

/**
 * The calendar day containing `atMs`, in `timezone`.
 *
 * Built from `formatToParts` rather than string-slicing a locale format, because
 * locale formats reorder fields and a budget that silently reads the month as
 * the day is the kind of bug that only shows up on the 13th.
 */
export function dayKey(atMs: number, timezone: string): DayKey {
  const zone = resolveTimezone(timezone);
  const parts = formatterFor(zone).formatToParts(new Date(atMs));
  let year = '';
  let month = '';
  let day = '';
  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return `${year}-${month}-${day}` as DayKey;
}

/** True when two instants fall on the same calendar day in `timezone`. */
export function sameDay(leftMs: number, rightMs: number, timezone: string): boolean {
  return dayKey(leftMs, timezone) === dayKey(rightMs, timezone);
}
