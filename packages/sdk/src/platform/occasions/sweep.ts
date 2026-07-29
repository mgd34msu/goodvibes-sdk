/**
 * sweep.ts — which occasions are entering their lead window, and may be raised.
 *
 * This is the whole decision, as ONE PURE FUNCTION. It takes a clock reading,
 * the declared occasions, the plans, the recorded answers and the open items,
 * and returns what to raise and what to write back. It performs no IO, reads no
 * clock of its own and delivers nothing, which is what makes every rule below
 * testable by handing it a date rather than by waiting for one.
 *
 * The rules it applies, in the order they are applied:
 *
 *  1. **Turned off** → nothing, stated as a reason rather than an empty result.
 *  2. **Quiet hours** → nothing, and NOTHING IS DROPPED. An item due at 3am is
 *     still due at 8am; the sweep simply does not speak outside 08:00–22:00 in
 *     his own timezone.
 *  3. **Kind `neither`** → never raised. Recorded so the date can be answered
 *     when he asks, and for nothing else.
 *  4. **Outside the lead window** → not yet. Ten days by default, overridable
 *     per occasion, because "order something and have it arrive" is not the
 *     same runway for everything.
 *  5. **Already answered for THIS occurrence** → a `no` is silent for the rest
 *     of this cycle, a `yes` has moved on to the interview, and a `later` comes
 *     back on its own date.
 *  6. **Mirrored to a calendar** → suppressed, when he has asked for that. The
 *     calendar's own reminder plus ours is two pings for one occasion.
 *  7. **Raised too recently** → the open item's own due date governs. First at
 *     the top of the window, then roughly every third day, then daily for the
 *     last two.
 *
 * Everything that survives all seven is batched into ONE message.
 */
import { parseQuietHours } from '../checkin/quiet-hours.js';
import {
  adjustForAway,
  conflictItemId,
  interviewItemId,
  interviewResumeDate,
  isDue,
  laterReturnDate,
  nextNudgeDue,
  nudgeItemId,
  openItemFor,
  raisedAgain,
  type CadencePolicy,
} from './cadence.js';
import { addDays, daysBetween, nextOccurrence, type IsoDate } from './dates.js';
import type {
  Interview,
  Occasion,
  OccasionAcknowledgement,
  OccasionConflict,
  OpenItem,
  Plan,
} from './types.js';

/** The occasions feature's effective policy, all of it operator-editable. */
export interface OccasionsPolicy extends CadencePolicy {
  readonly enabled: boolean;
  /** Default runway in days. A per-occasion `lead N` overrides it. */
  readonly leadDays: number;
  /** The hours it may speak, `HH:MM-HH:MM`, in `daemon.timezone`. */
  readonly activeHours: string;
  /** Whether a plan that takes him away moves a nudge earlier. */
  readonly awayAdjust: boolean;
  /** Whether an occasion mirrored to a calendar is left to the calendar. */
  readonly suppressMirroredNudges: boolean;
  /** How many questions the gift interview asks. */
  readonly interviewQuestions: number;
  /** How long gift history is kept, in years. */
  readonly giftHistoryYears: number;
  /** Where nudges are delivered. Empty ⇒ the agent surface only. */
  readonly nudgeChannel: string;
  /** Whether occasions are written out to the calendar as a mirror. */
  readonly calendarMirror: boolean;
  /** How often the scheduled sweep runs, in minutes. Read live, per tick. */
  readonly sweepIntervalMinutes: number;
}

/** One occasion that is due to be raised, with the occurrence it is about. */
export interface DueOccasion {
  readonly occasion: Occasion;
  readonly occurrence: IsoDate;
  /** Whole days from today. Never rendered — see nudge.ts. */
  readonly daysUntil: number;
}

/** Everything the sweep needs, gathered by the caller. */
export interface SweepContext {
  readonly now: number;
  readonly today: IsoDate;
  /** Minutes past midnight where he is. */
  readonly minutesOfDay: number;
  readonly occasions: readonly Occasion[];
  readonly conflicts: readonly OccasionConflict[];
  readonly plans: readonly Plan[];
  readonly acknowledgements: readonly OccasionAcknowledgement[];
  readonly openItems: readonly OpenItem[];
  readonly interviews: readonly Interview[];
  readonly policy: OccasionsPolicy;
}

/** Why a sweep raised nothing, when it raised nothing. */
export type SweepHold = 'disabled' | 'quiet-hours' | null;

/** What the sweep decided. The caller delivers it and writes the items back. */
export interface SweepDecision {
  readonly hold: SweepHold;
  readonly due: readonly DueOccasion[];
  readonly conflicts: readonly OccasionConflict[];
  /** Interviews he walked away from that are due to be picked up again. */
  readonly resumeInterviews: readonly Interview[];
  /** Open items to create or replace, already carrying their next due date. */
  readonly openItemWrites: readonly OpenItem[];
}

const EMPTY: SweepDecision = {
  hold: null,
  due: [],
  conflicts: [],
  resumeInterviews: [],
  openItemWrites: [],
};

/**
 * Whether the clock is inside the hours it may speak.
 *
 * The owner's words were *"8am to 10pm are generally fine, anything outside of
 * that probably not, so quiet outside of that range"*, so the setting names the
 * ACTIVE window rather than the quiet one — a setting whose value is the thing
 * he said. The parse is the check-in's, so the two cannot disagree about what
 * `HH:MM-HH:MM` means; the evaluation is not, because the check-in reads the
 * host's local clock and this has to read `daemon.timezone`.
 */
export function isWithinActiveHours(minutesOfDay: number, activeHours: string): boolean {
  const window = parseQuietHours(activeHours);
  // No window configured means no restriction. An unparseable value is the same
  // answer on purpose: a typo in a time range must not silence the feature
  // permanently and invisibly.
  if (window === null) return true;
  if (window.startMinutes === window.endMinutes) return true;
  if (window.startMinutes < window.endMinutes) {
    return minutesOfDay >= window.startMinutes && minutesOfDay < window.endMinutes;
  }
  return minutesOfDay >= window.startMinutes || minutesOfDay < window.endMinutes;
}

/** The lead this occasion actually uses. */
export function effectiveLead(occasion: Occasion, policy: OccasionsPolicy): number {
  const override = occasion.leadDays;
  if (override !== null && Number.isFinite(override) && override >= 0) return override;
  return Math.max(0, Math.round(policy.leadDays));
}

function answerFor(
  acknowledgements: readonly OccasionAcknowledgement[],
  occasionId: string,
  occurrence: IsoDate,
): OccasionAcknowledgement | undefined {
  return acknowledgements.find(
    (entry) => entry.occasionId === occasionId && entry.occurrence === occurrence,
  );
}

/** The whole decision. Pure: same inputs, same answer, every time. */
export function decideSweep(context: SweepContext): SweepDecision {
  const { policy, today, now } = context;
  if (!policy.enabled) return { ...EMPTY, hold: 'disabled' };
  if (!isWithinActiveHours(context.minutesOfDay, policy.activeHours)) {
    return { ...EMPTY, hold: 'quiet-hours' };
  }

  const itemsById = new Map(context.openItems.map((item) => [item.id, item]));
  const due: DueOccasion[] = [];
  const writes: OpenItem[] = [];

  for (const occasion of context.occasions) {
    if (occasion.kind === 'neither') continue;
    const occurrence = nextOccurrence(occasion.date, occasion.recurrence, today);
    if (occurrence === null) continue;
    const daysUntil = daysBetween(today, occurrence);
    if (!Number.isFinite(daysUntil) || daysUntil > effectiveLead(occasion, policy)) continue;

    const answer = answerFor(context.acknowledgements, occasion.id, occurrence);
    if (answer?.answer === 'no' || answer?.answer === 'yes') continue;
    if (answer?.answer === 'later' && (answer.returnOn ?? occurrence) > today) continue;
    if (occasion.mirrored && policy.suppressMirroredNudges) continue;

    const itemId = nudgeItemId(occasion.id, occurrence);
    const existing = itemsById.get(itemId);
    if (existing !== undefined && !isDue(existing, today)) continue;

    const nextDue = nextDueFor(today, occurrence, context.plans, policy);
    writes.push(existing === undefined
      ? openItemFor({
        kind: 'nudge',
        id: itemId,
        occasionId: occasion.id,
        occurrence,
        now,
        dueOn: nextDue,
        expiresAfter: occurrence,
      })
      : raisedAgain(existing, now, nextDue));
    due.push({ occasion, occurrence, daysUntil });
  }

  const conflicts: OccasionConflict[] = [];
  for (const conflict of context.conflicts) {
    const itemId = conflictItemId(conflict.occasionId);
    const existing = itemsById.get(itemId);
    if (existing !== undefined && !isDue(existing, today)) continue;
    // A conflict has no occurrence: it is a fact about the record, not about
    // this year, and it stays open until he fixes the file.
    const nextDue = addDaysClamped(today, Math.max(1, Math.round(policy.cadenceDays)));
    writes.push(existing === undefined
      ? openItemFor({
        kind: 'conflict',
        id: itemId,
        occasionId: conflict.occasionId,
        occurrence: '',
        now,
        dueOn: nextDue,
      })
      : raisedAgain(existing, now, nextDue));
    conflicts.push(conflict);
  }

  const resumeInterviews: Interview[] = [];
  for (const interview of context.interviews) {
    if (interview.completedAt !== undefined) continue;
    if (interview.occurrence < today) continue;
    const itemId = interviewItemId(interview.occasionId, interview.occurrence);
    const existing = itemsById.get(itemId);
    if (existing !== undefined && !isDue(existing, today)) continue;
    const nextDue = interviewResumeDate(today, interview.occurrence);
    writes.push(existing === undefined
      ? openItemFor({
        kind: 'interview',
        id: itemId,
        occasionId: interview.occasionId,
        occurrence: interview.occurrence,
        now,
        dueOn: nextDue,
        expiresAfter: interview.occurrence,
      })
      : raisedAgain(existing, now, nextDue));
    resumeInterviews.push(interview);
  }

  return { hold: null, due, conflicts, resumeInterviews, openItemWrites: writes };
}

/** The next day this occasion may be raised, after raising it today. */
function nextDueFor(
  today: IsoDate,
  occurrence: IsoDate,
  plans: readonly Plan[],
  policy: OccasionsPolicy,
): IsoDate {
  const base = nextNudgeDue(today, occurrence, policy);
  return policy.awayAdjust ? adjustForAway(base, today, plans) : base;
}

function addDaysClamped(today: IsoDate, days: number, cap?: IsoDate): IsoDate {
  const moved = addDays(today, days);
  return cap !== undefined && moved > cap ? cap : moved;
}

/**
 * The date a `later` comes back on, re-exported at the sweep's boundary.
 *
 * It belongs to the answer path rather than to the sweep, but every caller that
 * records a `later` is a caller of this module, and a second import path for one
 * function is how two callers end up disagreeing about what "later" means.
 */
export { laterReturnDate };
