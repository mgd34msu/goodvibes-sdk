/**
 * occasions-dates.test.ts
 *
 * The calendar arithmetic an occasion rests on, and the line grammar that reads
 * one out of the owner's profile.
 *
 * The through-line: nothing here guesses. A date that does not exist is refused
 * rather than coerced, a kind that was not written is never inferred, and a
 * segment this module does not recognise is kept rather than dropped.
 */
import { describe, expect, test } from 'bun:test';
import {
  addDays,
  daysBetween,
  daysInMonth,
  isIsoDate,
  isLeapYear,
  minutesOfDayInZone,
  nextOccurrence,
  occurrenceInYear,
  parseOccasionDate,
  renderOccasionDate,
  todayInZone,
} from '../packages/sdk/src/platform/occasions/dates.ts';
import {
  occasionIdFor,
  parseOccasionLine,
  parsePlanLine,
  renderOccasionLine,
  renderPlanLine,
  splitSegments,
} from '../packages/sdk/src/platform/occasions/grammar.ts';

describe('occasion dates', () => {
  test('parses MM-DD as recurring and YYYY-MM-DD as dated', () => {
    expect(parseOccasionDate('03-14')).toEqual({ kind: 'recurring', month: 3, day: 14 });
    expect(parseOccasionDate('2015-09-12')).toEqual({ kind: 'dated', year: 2015, month: 9, day: 12 });
  });

  test('refuses a date the calendar does not have', () => {
    expect(parseOccasionDate('02-30')).toBeNull();
    expect(parseOccasionDate('13-01')).toBeNull();
    expect(parseOccasionDate('2026-02-29')).toBeNull();
    expect(parseOccasionDate('2026-00-10')).toBeNull();
    expect(parseOccasionDate('not a date')).toBeNull();
  });

  test('accepts 29 February as a recurring date', () => {
    expect(parseOccasionDate('02-29')).toEqual({ kind: 'recurring', month: 2, day: 29 });
  });

  test('rendering is the inverse of parsing', () => {
    for (const value of ['03-14', '12-01', '2015-09-12']) {
      const parsed = parseOccasionDate(value);
      expect(parsed).not.toBeNull();
      expect(renderOccasionDate(parsed!)).toBe(value);
    }
  });

  test('leap years and month lengths', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(1900)).toBe(false);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  test('29 February lands on the 28th in a non-leap year, and on the 29th in a leap year', () => {
    const feb29 = parseOccasionDate('02-29')!;
    expect(occurrenceInYear(feb29, 2027)).toBe('2027-02-28');
    expect(occurrenceInYear(feb29, 2028)).toBe('2028-02-29');
  });

  test('next occurrence rolls into next year once the date has passed', () => {
    const march14 = parseOccasionDate('03-14')!;
    expect(nextOccurrence(march14, 'annual', '2026-01-01')).toBe('2026-03-14');
    expect(nextOccurrence(march14, 'annual', '2026-03-14')).toBe('2026-03-14');
    expect(nextOccurrence(march14, 'annual', '2026-03-15')).toBe('2027-03-14');
  });

  test('an annual occasion declared with a year still recurs on its month and day', () => {
    const anniversary = parseOccasionDate('2015-09-12')!;
    expect(nextOccurrence(anniversary, 'annual', '2026-07-29')).toBe('2026-09-12');
  });

  test('a one-off that has passed has no next occurrence', () => {
    const once = parseOccasionDate('2026-09-12')!;
    expect(nextOccurrence(once, 'once', '2026-07-29')).toBe('2026-09-12');
    expect(nextOccurrence(once, 'once', '2026-09-13')).toBeNull();
  });

  test('a one-off with no year is not a date at all', () => {
    expect(nextOccurrence(parseOccasionDate('09-12')!, 'once', '2026-07-29')).toBeNull();
  });

  test('day arithmetic crosses months, years and a leap day', () => {
    expect(daysBetween('2026-07-29', '2026-08-08')).toBe(10);
    expect(daysBetween('2026-08-08', '2026-07-29')).toBe(-10);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  test('isIsoDate checks the calendar, not just the shape', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-2-8')).toBe(false);
  });

  test('the day and the clock are read in the owner timezone, not the host one', () => {
    // 2026-07-29T03:30:00Z is still the 28th in New York and already the 29th
    // in Tokyo. A sweep that read the host clock would put the whole feature a
    // day out for anyone not on UTC.
    const instant = Date.parse('2026-07-29T03:30:00Z');
    expect(todayInZone(instant, 'America/New_York')).toBe('2026-07-28');
    expect(todayInZone(instant, 'Asia/Tokyo')).toBe('2026-07-29');
    expect(todayInZone(instant, 'UTC')).toBe('2026-07-29');
  });

  test('minutes past midnight are 24-hour, in zone', () => {
    const instant = Date.parse('2026-07-29T03:30:00Z');
    expect(minutesOfDayInZone(instant, 'UTC')).toBe(3 * 60 + 30);
    expect(minutesOfDayInZone(instant, 'America/New_York')).toBe(23 * 60 + 30);
    // Midnight is minute zero, not minute 1440.
    expect(minutesOfDayInZone(Date.parse('2026-07-29T00:00:00Z'), 'UTC')).toBe(0);
    // An empty zone falls back to UTC rather than throwing.
    expect(minutesOfDayInZone(instant, '')).toBe(3 * 60 + 30);
  });
});

describe('occasion line grammar', () => {
  test('reads a full line, in any segment order', () => {
    const forward = parseOccasionLine(4, "- Sarah's birthday · 03-14 · annual · gift-giving · for Sarah · lead 21");
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;
    expect(forward.occasion.title).toBe("Sarah's birthday");
    expect(forward.occasion.date).toEqual({ kind: 'recurring', month: 3, day: 14 });
    expect(forward.occasion.recurrence).toBe('annual');
    expect(forward.occasion.kind).toBe('gift-giving');
    expect(forward.occasion.person).toBe('Sarah');
    expect(forward.occasion.leadDays).toBe(21);
    expect(forward.occasion.lineIndex).toBe(4);

    // `text` deliberately preserves the line as HE wrote it, so the two differ
    // there and nowhere else. Everything the feature acts on is identical.
    const shuffled = parseOccasionLine(4, "- Sarah's birthday · lead 21 · gift-giving · for Sarah · annual · 03-14");
    expect(shuffled.ok).toBe(true);
    if (!shuffled.ok) return;
    const { text: forwardText, ...forwardRest } = forward.occasion;
    const { text: shuffledText, ...shuffledRest } = shuffled.occasion;
    expect(shuffledRest).toEqual(forwardRest);
    expect(shuffledText).not.toBe(forwardText);
  });

  test('accepts the pipe separator as well as the middot', () => {
    const piped = parseOccasionLine(0, '- Dad | 11-02 | annual | remember-only');
    expect(piped.ok).toBe(true);
    if (!piped.ok) return;
    expect(piped.occasion.title).toBe('Dad');
    expect(piped.occasion.kind).toBe('remember-only');
  });

  test('a line with no kind is refused, and says so — nothing is inferred', () => {
    const result = parseOccasionLine(2, "- Mum's birthday · 04-02 · annual");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unparsed.reason).toContain('no kind');
    expect(result.unparsed.text).toBe("Mum's birthday · 04-02 · annual");
  });

  test('a line with no date is refused with its own reason', () => {
    const result = parseOccasionLine(2, '- Something · annual · gift-giving');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unparsed.reason).toContain('no date');
  });

  test('a bare YYYY-MM-DD is a one-off; a bare MM-DD is annual', () => {
    const dated = parseOccasionLine(0, '- Wedding · 2027-06-05 · gift-giving');
    expect(dated.ok && dated.occasion.recurrence).toBe('once');
    const recurring = parseOccasionLine(0, '- Birthday · 06-05 · gift-giving');
    expect(recurring.ok && recurring.occasion.recurrence).toBe('annual');
  });

  test('unrecognised segments are kept, never dropped', () => {
    const result = parseOccasionLine(0, '- Dad · 11-02 · annual · remember-only · his 70th · something else');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occasion.extras).toEqual(['his 70th', 'something else']);
    expect(renderOccasionLine(result.occasion)).toContain('his 70th');
  });

  test('rendering round-trips a parsed line', () => {
    const source = "Sarah's birthday · 03-14 · annual · gift-giving · for Sarah · lead 21 · mirrored";
    const parsed = parseOccasionLine(0, `- ${source}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(renderOccasionLine(parsed.occasion)).toBe(source);
  });

  test('the id is stable across date, kind and lead edits', () => {
    const before = parseOccasionLine(0, "- Sarah's Birthday · 03-14 · annual · gift-giving");
    const after = parseOccasionLine(9, "- sarah's   birthday · 03-15 · annual · remember-only · lead 30");
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.occasion.id).toBe(before.occasion.id);
    expect(before.occasion.id).toBe(occasionIdFor("Sarah's birthday"));
  });

  test('splitSegments keeps a title that carries no attributes', () => {
    expect(splitSegments('- just a note')).toEqual({ title: 'just a note', segments: [] });
  });

  test('shorthand kind words resolve to the owner-facing names', () => {
    const gift = parseOccasionLine(0, '- A · 03-14 · gift');
    const remember = parseOccasionLine(0, '- B · 03-14 · remember');
    const neither = parseOccasionLine(0, '- C · 03-14 · none');
    expect(gift.ok && gift.occasion.kind).toBe('gift-giving');
    expect(remember.ok && remember.occasion.kind).toBe('remember-only');
    expect(neither.ok && neither.occasion.kind).toBe('neither');
  });
});

describe('plan line grammar', () => {
  test('reads a dated range with attributes', () => {
    const result = parsePlanLine(3, '- Lisbon · 2026-09-12..2026-09-19 · away · in Lisbon');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.from).toBe('2026-09-12');
    expect(result.plan.to).toBe('2026-09-19');
    expect(result.plan.away).toBe(true);
    expect(result.plan.destination).toBe('Lisbon');
  });

  test('away is opt-in — a dated range at home is still a plan', () => {
    const result = parsePlanLine(0, '- Kitchen refit · 2026-09-03..2026-09-10');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.away).toBe(false);
  });

  test('a range written backwards is ordered rather than refused', () => {
    const result = parsePlanLine(0, '- Trip · 2026-09-19..2026-09-12 · away');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.from).toBe('2026-09-12');
    expect(result.plan.to).toBe('2026-09-19');
  });

  test('a plan with no range is refused with a reason', () => {
    const result = parsePlanLine(0, '- Some trip · away');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unparsed.reason).toContain('no dated range');
  });

  test('rendering round-trips a parsed plan', () => {
    const source = 'Lisbon · 2026-09-12..2026-09-19 · away · in Lisbon · with the kids';
    const parsed = parsePlanLine(0, `- ${source}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(renderPlanLine(parsed.plan)).toBe(source);
  });
});
