/**
 * checkin/quiet-hours.ts
 *
 * Quiet-hours parsing and evaluation, split out so it is unit-testable in
 * isolation. Format is 'HH:MM-HH:MM' in local time; an empty/invalid string
 * means "no quiet hours". A window whose end is <= its start wraps past
 * midnight (e.g. '22:00-08:00' is quiet from 10pm through 8am).
 */

interface QuietWindow {
  readonly startMinutes: number;
  readonly endMinutes: number;
}

function parseHHMM(value: string): number | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function parseQuietHours(spec: string): QuietWindow | null {
  if (!spec || !spec.includes('-')) return null;
  const [rawStart, rawEnd] = spec.split('-', 2);
  const startMinutes = parseHHMM(rawStart ?? '');
  const endMinutes = parseHHMM(rawEnd ?? '');
  if (startMinutes === null || endMinutes === null) return null;
  return { startMinutes, endMinutes };
}

/** Whether the given instant (local time) falls within the quiet-hours window. */
export function isQuietHours(now: number, spec: string): boolean {
  const window = parseQuietHours(spec);
  if (!window) return false;
  const date = new Date(now);
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (window.startMinutes === window.endMinutes) return false;
  if (window.startMinutes < window.endMinutes) {
    return minutes >= window.startMinutes && minutes < window.endMinutes;
  }
  // Wraps past midnight.
  return minutes >= window.startMinutes || minutes < window.endMinutes;
}
