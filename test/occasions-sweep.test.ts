/**
 * occasions-sweep.test.ts
 *
 * The approach sweep's decision, and the cadence and message rules around it.
 * Everything here is pure: a date goes in, a decision comes out, so each rule is
 * asserted by handing it a day rather than by waiting for one.
 *
 * The through-line: nothing unresolved is ever dropped. Quiet hours hold rather
 * than discard, a decline expires with its date, "later" comes back, and a nudge
 * that reaches a channel never carries the date in any form.
 */
import { describe, expect, test } from 'bun:test';
import {
  adjustForAway,
  interviewResumeDate,
  laterReturnDate,
  nextNudgeDue,
} from '../packages/sdk/src/platform/occasions/cadence.ts';
import { parseOccasionLine, parsePlanLine } from '../packages/sdk/src/platform/occasions/grammar.ts';
import {
  composeConflictMessage,
  composeNudge,
  composeNudgeMessage,
  nameOf,
  proximityOf,
  subjectFor,
} from '../packages/sdk/src/platform/occasions/nudge.ts';
import {
  decideSweep,
  effectiveLead,
  isWithinActiveHours,
  type OccasionsPolicy,
  type SweepContext,
} from '../packages/sdk/src/platform/occasions/sweep.ts';
import type {
  Occasion,
  OccasionAcknowledgement,
  OpenItem,
  Plan,
} from '../packages/sdk/src/platform/occasions/types.ts';

const POLICY: OccasionsPolicy = {
  enabled: true,
  leadDays: 10,
  activeHours: '08:00-22:00',
  nudgeChannel: 'telegram',
  cadenceDays: 3,
  finalStretchDays: 2,
  awayAdjust: true,
  calendarMirror: false,
  suppressMirroredNudges: true,
  interviewQuestions: 3,
  giftHistoryYears: 10,
  sweepIntervalMinutes: 60,
};

function occasion(line: string): Occasion {
  const parsed = parseOccasionLine(0, `- ${line}`);
  if (!parsed.ok) throw new Error(`fixture line did not parse: ${parsed.unparsed.reason}`);
  return parsed.occasion;
}

function plan(line: string): Plan {
  const parsed = parsePlanLine(0, `- ${line}`);
  if (!parsed.ok) throw new Error(`fixture plan did not parse: ${parsed.unparsed.reason}`);
  return parsed.plan;
}

function context(overrides: Partial<SweepContext> = {}): SweepContext {
  return {
    now: Date.parse('2026-03-06T10:00:00Z'),
    today: '2026-03-06',
    minutesOfDay: 10 * 60,
    occasions: [],
    conflicts: [],
    plans: [],
    acknowledgements: [],
    openItems: [],
    interviews: [],
    policy: POLICY,
    ...overrides,
  };
}

describe('active hours', () => {
  test('08:00 to 22:00 is the window it may speak in', () => {
    expect(isWithinActiveHours(7 * 60 + 59, '08:00-22:00')).toBe(false);
    expect(isWithinActiveHours(8 * 60, '08:00-22:00')).toBe(true);
    expect(isWithinActiveHours(21 * 60 + 59, '08:00-22:00')).toBe(true);
    expect(isWithinActiveHours(22 * 60, '08:00-22:00')).toBe(false);
    expect(isWithinActiveHours(3 * 60, '08:00-22:00')).toBe(false);
  });

  test('an unset or unreadable window is no restriction, never permanent silence', () => {
    expect(isWithinActiveHours(3 * 60, '')).toBe(true);
    expect(isWithinActiveHours(3 * 60, 'nonsense')).toBe(true);
    expect(isWithinActiveHours(3 * 60, '08:00')).toBe(true);
  });

  test('a window that wraps past midnight is honoured', () => {
    expect(isWithinActiveHours(23 * 60, '22:00-06:00')).toBe(true);
    expect(isWithinActiveHours(2 * 60, '22:00-06:00')).toBe(true);
    expect(isWithinActiveHours(12 * 60, '22:00-06:00')).toBe(false);
  });
});

describe('the sweep decision', () => {
  test('raises an occasion inside its lead window', () => {
    const decision = decideSweep(context({
      occasions: [occasion("Sarah's birthday · 03-14 · annual · gift-giving · for Sarah")],
    }));
    expect(decision.hold).toBeNull();
    expect(decision.due).toHaveLength(1);
    expect(decision.due[0]!.occurrence).toBe('2026-03-14');
    expect(decision.due[0]!.daysUntil).toBe(8);
    expect(decision.openItemWrites).toHaveLength(1);
    expect(decision.openItemWrites[0]!.kind).toBe('nudge');
  });

  test('says nothing before the lead window opens', () => {
    const decision = decideSweep(context({
      today: '2026-03-01',
      occasions: [occasion("Sarah's birthday · 03-14 · annual · gift-giving")],
    }));
    expect(decision.due).toHaveLength(0);
  });

  test('a per-occasion lead override widens the window on its own', () => {
    const wide = occasion("Sarah's birthday · 03-14 · annual · gift-giving · lead 30");
    expect(effectiveLead(wide, POLICY)).toBe(30);
    const decision = decideSweep(context({ today: '2026-03-01', occasions: [wide] }));
    expect(decision.due).toHaveLength(1);
  });

  test('kind "neither" is never raised', () => {
    const decision = decideSweep(context({
      occasions: [occasion('Something · 03-14 · annual · neither')],
    }));
    expect(decision.due).toHaveLength(0);
  });

  test('remember-only is raised, and its message never mentions a gift', () => {
    const decision = decideSweep(context({
      occasions: [occasion('Dad · 03-14 · annual · remember-only')],
    }));
    expect(decision.due).toHaveLength(1);
    const nudge = composeNudge({
      id: 'n',
      now: 0,
      subjects: decision.due.map((entry) => subjectFor(entry.occasion, entry.daysUntil)),
    });
    expect(nudge.message.toLowerCase()).not.toContain('sort something');
    expect(nudge.answerable).toBe(false);
  });

  test('quiet hours hold everything, and drop nothing', () => {
    const decision = decideSweep(context({
      minutesOfDay: 3 * 60,
      occasions: [occasion("Sarah's birthday · 03-14 · annual · gift-giving")],
    }));
    expect(decision.hold).toBe('quiet-hours');
    expect(decision.due).toHaveLength(0);
    // Crucially: no open item was written, so nothing was marked as raised and
    // the same occasion is still due the moment the window opens.
    expect(decision.openItemWrites).toHaveLength(0);
  });

  test('turned off is a stated hold, not an empty answer', () => {
    const decision = decideSweep(context({
      policy: { ...POLICY, enabled: false },
      occasions: [occasion("Sarah's birthday · 03-14 · annual · gift-giving")],
    }));
    expect(decision.hold).toBe('disabled');
  });

  test('a no goes silent for this occurrence', () => {
    const answered: OccasionAcknowledgement = {
      id: 'x',
      occasionId: "sarah's birthday",
      occurrence: '2026-03-14',
      answer: 'no',
      answeredAt: 0,
      expiresAfter: '2026-03-14',
    };
    const decision = decideSweep(context({
      occasions: [occasion("Sarah's birthday · 03-14 · annual · gift-giving")],
      acknowledgements: [answered],
    }));
    expect(decision.due).toHaveLength(0);
  });

  test("a no about LAST year's occurrence does not silence this year's", () => {
    const stale: OccasionAcknowledgement = {
      id: 'x',
      occasionId: "sarah's birthday",
      occurrence: '2025-03-14',
      answer: 'no',
      answeredAt: 0,
      expiresAfter: '2025-03-14',
    };
    const decision = decideSweep(context({
      occasions: [occasion("Sarah's birthday · 03-14 · annual · gift-giving")],
      acknowledgements: [stale],
    }));
    expect(decision.due).toHaveLength(1);
  });

  test('a later is silent until its return date, then comes back', () => {
    const later: OccasionAcknowledgement = {
      id: 'x',
      occasionId: "sarah's birthday",
      occurrence: '2026-03-14',
      answer: 'later',
      answeredAt: 0,
      returnOn: '2026-03-10',
    };
    const occasions = [occasion("Sarah's birthday · 03-14 · annual · gift-giving")];
    expect(decideSweep(context({ occasions, acknowledgements: [later] })).due).toHaveLength(0);
    expect(
      decideSweep(context({ today: '2026-03-10', occasions, acknowledgements: [later] })).due,
    ).toHaveLength(1);
  });

  test('an occasion mirrored to a calendar is left to the calendar', () => {
    const mirrored = [occasion("Sarah's birthday · 03-14 · annual · gift-giving · mirrored")];
    expect(decideSweep(context({ occasions: mirrored })).due).toHaveLength(0);
    // And both pings when he has asked for both.
    expect(
      decideSweep(context({
        occasions: mirrored,
        policy: { ...POLICY, suppressMirroredNudges: false },
      })).due,
    ).toHaveLength(1);
  });

  test('an occasion raised today is not raised again until its item is due', () => {
    const item: OpenItem = {
      id: "nudge:sarah's birthday@2026-03-14",
      kind: 'nudge',
      occasionId: "sarah's birthday",
      occurrence: '2026-03-14',
      openedAt: 0,
      lastRaisedAt: 0,
      raiseCount: 1,
      dueOn: '2026-03-09',
    };
    const occasions = [occasion("Sarah's birthday · 03-14 · annual · gift-giving")];
    expect(decideSweep(context({ occasions, openItems: [item] })).due).toHaveLength(0);
    const laterDay = decideSweep(context({ today: '2026-03-09', occasions, openItems: [item] }));
    expect(laterDay.due).toHaveLength(1);
    expect(laterDay.openItemWrites[0]!.raiseCount).toBe(2);
  });

  test('several occasions in one window batch into one message', () => {
    const decision = decideSweep(context({
      occasions: [
        occasion("Sarah's birthday · 03-14 · annual · gift-giving · for Sarah"),
        occasion('Our anniversary · 03-12 · annual · gift-giving · for Jane'),
      ],
    }));
    expect(decision.due).toHaveLength(2);
    const nudge = composeNudge({
      id: 'n',
      now: 0,
      subjects: decision.due.map((entry) => subjectFor(entry.occasion, entry.daysUntil)),
    });
    expect(nudge.subjects).toHaveLength(2);
    expect(nudge.message.split('.').length).toBeLessThanOrEqual(3);
  });

  test('a conflict is raised, and raised again on its own cadence', () => {
    const conflict = {
      occasionId: 'mum',
      title: 'Mum',
      dates: ['04-02', '04-03'],
      lineIndexes: [1, 2],
    };
    const first = decideSweep(context({ conflicts: [conflict] }));
    expect(first.conflicts).toHaveLength(1);
    const item = first.openItemWrites.find((entry) => entry.kind === 'conflict');
    expect(item?.dueOn).toBe('2026-03-09');
    // A conflict carries no occurrence: it is a fact about the record, so it
    // outlives any one year's date.
    expect(item?.occurrence).toBe('');
    expect(item?.expiresAfter).toBeUndefined();
    const tooSoon = decideSweep(context({ conflicts: [conflict], openItems: [item!] }));
    expect(tooSoon.conflicts).toHaveLength(0);
  });
});

describe('cadence', () => {
  test('roughly every third day, then daily for the last two', () => {
    expect(nextNudgeDue('2026-03-04', '2026-03-14', POLICY)).toBe('2026-03-07');
    expect(nextNudgeDue('2026-03-12', '2026-03-14', POLICY)).toBe('2026-03-13');
    expect(nextNudgeDue('2026-03-13', '2026-03-14', POLICY)).toBe('2026-03-14');
  });

  test('a gap never steps past the date itself', () => {
    expect(nextNudgeDue('2026-03-13', '2026-03-14', { cadenceDays: 30, finalStretchDays: 0 }))
      .toBe('2026-03-14');
  });

  test('later comes back roughly halfway, never tomorrow and never past the day', () => {
    expect(laterReturnDate('2026-03-01', '2026-03-21')).toBe('2026-03-11');
    expect(laterReturnDate('2026-03-13', '2026-03-14')).toBe('2026-03-14');
    expect(laterReturnDate('2026-03-14', '2026-03-14')).toBe('2026-03-14');
  });

  test('a dropped interview resumes the next day, and never after the date', () => {
    expect(interviewResumeDate('2026-03-06')).toBe('2026-03-07');
    expect(interviewResumeDate('2026-03-06', '2026-03-14')).toBe('2026-03-07');
    // The day before the occurrence: tomorrow IS the day, so it stands.
    expect(interviewResumeDate('2026-03-13', '2026-03-14')).toBe('2026-03-14');
    // On the day: there is nowhere later to go.
    expect(interviewResumeDate('2026-03-14', '2026-03-14')).toBe('2026-03-14');
  });

  test('the sweep resumes a dropped interview through that same rule', () => {
    const interview = {
      id: "interview:sarah's birthday@2026-03-14",
      occasionId: "sarah's birthday",
      occurrence: '2026-03-14',
      startedAt: 0,
      steps: [{ id: 'direction', prompt: 'what?', opensFrom: '' }],
      answers: [],
    };
    const onTheDay = decideSweep(context({ today: '2026-03-14', interviews: [interview] }));
    const item = onTheDay.openItemWrites.find((entry) => entry.kind === 'interview');
    // Not the 15th: the sweep must not compute this itself and step past the date.
    expect(item?.dueOn).toBe('2026-03-14');
  });

  test('a nudge due while he is away moves to the day before he leaves', () => {
    const trip = [plan('Lisbon · 2026-03-09..2026-03-16 · away · in Lisbon')];
    expect(adjustForAway('2026-03-11', '2026-03-06', trip)).toBe('2026-03-08');
  });

  test('a nudge outside an away window is untouched', () => {
    const trip = [plan('Lisbon · 2026-03-09..2026-03-16 · away')];
    expect(adjustForAway('2026-03-07', '2026-03-06', trip)).toBe('2026-03-07');
    // A dated range he is NOT away for does not move anything.
    const home = [plan('Kitchen refit · 2026-03-09..2026-03-16')];
    expect(adjustForAway('2026-03-11', '2026-03-06', home)).toBe('2026-03-11');
  });

  test('once he has already left there is nothing earlier, so the nudge stands', () => {
    const trip = [plan('Lisbon · 2026-03-01..2026-03-16 · away')];
    expect(adjustForAway('2026-03-11', '2026-03-06', trip)).toBe('2026-03-11');
  });

  test('away adjustment is applied by the sweep only when it is on', () => {
    const occasions = [occasion("Sarah's birthday · 03-14 · annual · gift-giving")];
    const plans = [plan('Lisbon · 2026-03-09..2026-03-16 · away')];
    const on = decideSweep(context({ occasions, plans }));
    expect(on.openItemWrites[0]!.dueOn).toBe('2026-03-08');
    const off = decideSweep(context({ occasions, plans, policy: { ...POLICY, awayAdjust: false } }));
    expect(off.openItemWrites[0]!.dueOn).toBe('2026-03-09');
  });
});

describe('what a nudge says', () => {
  test('proximity is a word, and the thresholds are the only place a count is read', () => {
    expect(proximityOf(10)).toBe('approaching');
    expect(proximityOf(5)).toBe('soon');
    expect(proximityOf(2)).toBe('imminent');
  });

  test('the message names the occasion and the person and NEVER the date', () => {
    const message = composeNudgeMessage([
      subjectFor(occasion("Sarah's birthday · 03-14 · annual · gift-giving · for Sarah"), 8),
    ]);
    expect(message).toContain("Sarah's birthday");
    // Not the date, not the month, not the day count, in any rendering.
    expect(message).not.toContain('03-14');
    expect(message).not.toContain('March');
    expect(message).not.toContain('14');
    expect(message).not.toMatch(/\d/);
  });

  test('a batched message carries no digits either', () => {
    const message = composeNudgeMessage([
      subjectFor(occasion("Sarah's birthday · 03-14 · annual · gift-giving · for Sarah"), 8),
      subjectFor(occasion('Our anniversary · 03-12 · annual · gift-giving · for Jane'), 6),
      subjectFor(occasion('Dad · 03-13 · annual · remember-only'), 7),
    ]);
    expect(message).not.toMatch(/\d/);
    expect(message).toContain('Dad');
  });

  test('the person is added only when the title does not already carry them', () => {
    expect(nameOf(subjectFor(occasion("Sarah's birthday · 03-14 · annual · gift-giving · for Sarah"), 8)))
      .toBe("Sarah's birthday");
    expect(nameOf(subjectFor(occasion('Anniversary · 03-14 · annual · gift-giving · for Jane'), 8)))
      .toBe('Anniversary (Jane)');
  });

  test('a conflict message does not print the dates onto a channel', () => {
    const message = composeConflictMessage('Mum', ['04-02', '04-03']);
    expect(message).toContain('Mum');
    expect(message).not.toContain('04-02');
    expect(message).not.toContain('04-03');
  });
});
