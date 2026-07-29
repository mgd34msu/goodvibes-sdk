/**
 * cadence.ts — when an unresolved thing is raised again.
 *
 * The governing principle is that nothing unresolved is ever dropped. Silence
 * does not end anything: there is no give-up-after-one-retry anywhere in this
 * feature. Silence only moves a date.
 *
 * The SHAPE of the cadence was my choice rather than the owner's, flagged to him
 * and not objected to: first at the top of the lead window, then roughly every
 * third day, then daily for the last two. It is expressed here as two settings
 * with those defaults rather than as constants, so changing his mind about it is
 * a setting rather than a release.
 *
 * Everything in this file is pure date arithmetic. It takes a calendar day and
 * gives back a calendar day; it never reads a clock, so the sweep's behaviour is
 * reproducible from its inputs alone.
 */
import { addDays, daysBetween, type IsoDate } from './dates.js';
import { awayPlanOn } from './reader.js';
import type { OpenItem, OpenItemKind, Plan } from './types.js';

/** The two knobs the nudge rhythm is built from. */
export interface CadencePolicy {
  /** Ordinary gap between nudges, in days. Default 3. */
  readonly cadenceDays: number;
  /** How many days before the occurrence the rhythm goes daily. Default 2. */
  readonly finalStretchDays: number;
}

export function nudgeItemId(occasionId: string, occurrence: IsoDate): string {
  return `nudge:${occasionId}@${occurrence}`;
}

/**
 * A conflict's id carries no occurrence.
 *
 * Two declared dates disagreeing is not a fact about this year's birthday, it is
 * a fact about the record — and it stays open until he fixes the file, across
 * however many occurrences pass in the meantime.
 */
export function conflictItemId(occasionId: string): string {
  return `conflict:${occasionId}`;
}

export function interviewItemId(occasionId: string, occurrence: IsoDate): string {
  return `interview:${occasionId}@${occurrence}`;
}

/**
 * The next day a nudge may be raised, given today and the occurrence.
 *
 * Never later than the occurrence itself: a gap that stepped past the date would
 * mean the last thing he heard about his wife's birthday was four days before
 * it, which is the failure mode of every reminder that "backs off politely".
 */
export function nextNudgeDue(today: IsoDate, occurrence: IsoDate, policy: CadencePolicy): IsoDate {
  const remaining = daysBetween(today, occurrence);
  if (!Number.isFinite(remaining) || remaining <= 0) return occurrence;
  const gap = remaining <= Math.max(0, policy.finalStretchDays)
    ? 1
    : Math.max(1, Math.round(policy.cadenceDays));
  const due = addDays(today, gap);
  return due > occurrence ? occurrence : due;
}

/**
 * When a "later" comes back.
 *
 * "Not yet" three weeks out is not a decline, and returning it the next morning
 * would make "later" mean nothing. It comes back roughly halfway to the date —
 * far enough that it reads as having been listened to, near enough that there is
 * still time to order something. Never sooner than tomorrow, never past the day
 * itself.
 */
export function laterReturnDate(today: IsoDate, occurrence: IsoDate): IsoDate {
  const remaining = daysBetween(today, occurrence);
  if (!Number.isFinite(remaining) || remaining <= 1) return occurrence;
  const half = Math.max(1, Math.ceil(remaining / 2));
  const due = addDays(today, half);
  return due > occurrence ? occurrence : due;
}

/**
 * A dropped interview resumes the next day, and never after the date itself.
 *
 * He was mid-thread, so this is a live conversation he walked away from rather
 * than a question he has not engaged with. One day is the shortest gap that is
 * not badgering, and it was my call — the plan says "nudge again later and
 * resume" without naming an interval.
 *
 * The clamp lives HERE rather than at the call site. The sweep used to add a day
 * and clamp inline, which made this function a second, unused definition of the
 * same rule sitting next to the real one — the drift class every other comment
 * in this module argues against, and the kind that survives review because both
 * copies are correct on the day they are written.
 */
export function interviewResumeDate(today: IsoDate, occurrence?: IsoDate): IsoDate {
  const due = addDays(today, 1);
  return occurrence !== undefined && due > occurrence ? occurrence : due;
}

/**
 * Move a nudge that would land while he is away.
 *
 * The owner's ruling was that being somewhere is trackable state and may modify
 * nudge times. The useful modification is EARLIER, not later: he cannot have
 * something delivered to a house he is not in, so a reminder that arrives while
 * he is abroad has already missed the window it existed to protect. So a nudge
 * due inside an away window moves to the day before he leaves.
 *
 * When he has ALREADY left — the window started before today — there is nothing
 * earlier to move to, and the nudge stands. Holding it until he is back would be
 * the system quietly deciding his wife's birthday can wait.
 */
export function adjustForAway(
  due: IsoDate,
  today: IsoDate,
  plans: readonly Plan[],
): IsoDate {
  const plan = awayPlanOn(plans, due);
  if (plan === undefined) return due;
  const beforeDeparture = addDays(plan.from, -1);
  return beforeDeparture >= today ? beforeDeparture : due;
}

/** True when an open item may be raised on `today`. */
export function isDue(item: OpenItem, today: IsoDate): boolean {
  return item.dueOn <= today;
}

/** Build the open item a first raise creates. */
export function openItemFor(input: {
  readonly kind: OpenItemKind;
  readonly id: string;
  readonly occasionId: string;
  readonly occurrence: IsoDate;
  readonly now: number;
  readonly dueOn: IsoDate;
  readonly expiresAfter?: IsoDate | undefined;
}): OpenItem {
  return {
    id: input.id,
    kind: input.kind,
    occasionId: input.occasionId,
    occurrence: input.occurrence,
    openedAt: input.now,
    lastRaisedAt: input.now,
    raiseCount: 1,
    dueOn: input.dueOn,
    ...(input.expiresAfter === undefined ? {} : { expiresAfter: input.expiresAfter }),
  };
}

/** The same item, raised once more. */
export function raisedAgain(item: OpenItem, now: number, dueOn: IsoDate): OpenItem {
  return { ...item, lastRaisedAt: now, raiseCount: item.raiseCount + 1, dueOn };
}
