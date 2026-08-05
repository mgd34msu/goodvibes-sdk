/**
 * cadence.ts — when an unresolved thing speaks.
 *
 * The governing principle is that nothing unresolved is ever DROPPED. It is
 * worth stating what that does and does not mean, because the difference cost
 * the owner a day of being told about his own birthday every hour:
 *
 *  - It means the OPEN ITEM survives. It stays in the store, it stays
 *    enumerable, and asking "anything coming up?" finds it. Silence from him
 *    never deletes it.
 *  - It does NOT mean the push repeats. An unanswered thing is not a thing to
 *    say again, and again, and again. It was read that way, and on an hourly
 *    sweep "raise anything whose due date has arrived" plus "a due date that
 *    cannot move past the occurrence" is an unbounded loop wearing the costume
 *    of a policy.
 *
 * So a nudge speaks at TWO NAMED MOMENTS and no others: the day it enters its
 * lead window, and the day itself. Each is recorded as served the moment it is
 * used, and a served boundary is never served twice. The ceiling is therefore a
 * property of the record rather than a rule someone has to remember to apply —
 * there is no counter to overflow, no timestamp to compare, and no arrangement
 * of restarts, clock changes or sweep intervals that produces a third push.
 *
 * Conflicts and interviews keep the older repeating rhythm, and deliberately: a
 * conflict is a fact about his FILE that stays wrong until he fixes it, and an
 * interview is a conversation he walked out of mid-sentence. Neither is a
 * countdown to a date, and neither was the thing drowning him.
 *
 * Everything in this file is pure. It takes calendar days and record state and
 * gives back calendar days and record state; it never reads a clock, so the
 * sweep's behaviour is reproducible from its inputs alone.
 */
import { addDays, daysBetween, type IsoDate } from './dates.js';
import { awayPlanOn } from './reader.js';
import {
  MAX_NUDGE_RAISES,
  type OpenItem,
  type OpenItemKind,
  type Plan,
  type RaiseBoundary,
} from './types.js';

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
 * The day the `day-of` boundary actually falls on.
 *
 * The occurrence, unless he will be AWAY on it and the away adjustment is on,
 * in which case it moves to the day before he leaves. That is the owner's own
 * ruling about being somewhere applied to the one boundary it can apply to: a
 * reminder that arrives while he is abroad has already missed the window it
 * existed to protect, and there is nothing useful about being told on the day
 * when the useful day was before the flight.
 *
 * The `lead` boundary is not adjustable — it is the top of the window, and
 * there is nothing earlier to move it to.
 */
export function dayOfBoundaryDate(
  occurrence: IsoDate,
  today: IsoDate,
  plans: readonly Plan[],
  awayAdjust: boolean,
): IsoDate {
  return awayAdjust ? adjustForAway(occurrence, today, plans) : occurrence;
}

/**
 * Which boundary TODAY is, for an occurrence already inside its lead window.
 *
 * Two moments, so two answers. On or after the day-of date it is `day-of`;
 * anywhere else inside the window it is `lead`. The caller has already
 * established that the window is open — this does not decide whether to speak,
 * only which of the two moments a decision to speak would be spending.
 */
export function boundaryOn(today: IsoDate, dayOfDate: IsoDate): RaiseBoundary {
  return today >= dayOfDate ? 'day-of' : 'lead';
}

/** True when this item has already spoken at that boundary. */
export function hasServed(item: OpenItem, boundary: RaiseBoundary): boolean {
  return item.servedBoundaries.includes(boundary);
}

/** True when both boundaries are spent and this item can never push again. */
export function isSpent(item: OpenItem): boolean {
  return item.servedBoundaries.length >= MAX_NUDGE_RAISES;
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
  /** The boundary this first raise is spending. Nudges only. */
  readonly boundary?: RaiseBoundary | undefined;
}): OpenItem {
  return {
    id: input.id,
    kind: input.kind,
    occasionId: input.occasionId,
    occurrence: input.occurrence,
    openedAt: input.now,
    lastRaisedAt: input.now,
    raiseCount: 1,
    servedBoundaries: input.boundary === undefined ? [] : [input.boundary],
    dueOn: input.dueOn,
    ...(input.expiresAfter === undefined ? {} : { expiresAfter: input.expiresAfter }),
  };
}

/**
 * The same item, raised once more. Conflicts and interviews only.
 *
 * Takes no boundary because neither of those has one: they repeat on a date, as
 * they always did. A nudge goes through {@link raisedAtBoundary} instead, which
 * is the only way a nudge's raise count ever moves.
 */
export function raisedAgain(item: OpenItem, now: number, dueOn: IsoDate): OpenItem {
  return { ...item, lastRaisedAt: now, raiseCount: item.raiseCount + 1, dueOn };
}

/**
 * The same nudge, having now spoken at one boundary — and spent it.
 *
 * The boundary is added to the served list in the SAME write that increments
 * the count, so there is no window in which a raise happened but was not
 * recorded as spending its boundary. Adding a boundary already present is a
 * no-op rather than an error: the caller should not have asked, and duplicating
 * it would be the one way to smuggle a third push past the ceiling.
 */
export function raisedAtBoundary(
  item: OpenItem,
  now: number,
  dueOn: IsoDate,
  boundary: RaiseBoundary,
): OpenItem {
  if (hasServed(item, boundary)) return item;
  return {
    ...item,
    lastRaisedAt: now,
    raiseCount: item.raiseCount + 1,
    servedBoundaries: [...item.servedBoundaries, boundary],
    dueOn,
  };
}

/**
 * Rebuild the raise ledger of an item written before boundaries existed.
 *
 * A machine that has been running the old repeating cadence holds nudge items
 * with a raise count and no served boundaries — the owner's own birthday, at
 * the time this was written, sat at five raises and climbing. Those items are
 * not deleted and not resolved: nothing about them was resolved, and dropping
 * them would trade one broken promise for another. They are marked as having
 * already spoken, and they go quiet.
 *
 * The mapping is the conservative reading of what already happened to him:
 *
 *  - one raise  → the lead boundary is spent, the day itself is still owed.
 *    He was told once, at the top of the window, which is exactly what the new
 *    rule would have done.
 *  - two or more → both are spent. He has already heard about this occurrence
 *    at least as often as the ceiling allows, and the honest correction is
 *    silence, not one more.
 *
 * Returns `null` when there is nothing to reconcile, so the caller can count
 * and receipt only the items it actually changed.
 */
export function reconcileRaiseLedger(item: OpenItem): OpenItem | null {
  if (item.kind !== 'nudge') return null;
  if (item.servedBoundaries.length > 0) return null;
  if (item.raiseCount < 1) return null;
  const served: readonly RaiseBoundary[] = item.raiseCount >= MAX_NUDGE_RAISES
    ? ['lead', 'day-of']
    : ['lead'];
  return { ...item, servedBoundaries: served };
}
