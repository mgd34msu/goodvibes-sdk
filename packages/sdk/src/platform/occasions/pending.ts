/**
 * pending.ts, what is outstanding, for a surface that ASKS rather than receives.
 *
 * The pull half of the feature, and under the two-boundary cadence it carries
 * considerably more weight than it used to. A nudge now pushes twice: at the
 * top of its lead window and on the day itself. For the whole stretch between
 * those two moments the occasion is open, quiet, and reachable only through
 * here, "anything coming up?" is the way the owner finds out, and that is the
 * design rather than a gap in it. Nothing unresolved drops; it simply stops
 * shouting.
 *
 * Three things are enumerated that a push would never send the owner:
 *
 *  - Occurrences the owner has ACKNOWLEDGED. Muted for push, still listed, and
 *    listed as acknowledged so a surface can show them that they are the
 *    reason it is quiet rather than leaving them to wonder.
 *  - Occurrences about THE OWNER that they only have to remember. Never pushed
 *    at all; always here.
 *  - Occurrences between their two boundaries, which is most of them, most of
 *    the time.
 */
import { composeConflictMessage, composeNudge, subjectFor } from './nudge.js';
import { daysBetween, type IsoDate } from './dates.js';
import type {
  NudgeSubject,
  Occasion,
  OccasionAcknowledgement,
  OccasionConflict,
  OccasionNudge,
  OpenItem,
} from './types.js';

/** Everything outstanding, for a surface that pulls rather than receives. */
export interface PendingResult {
  readonly today: IsoDate;
  /** What is coming up and has NOT been acknowledged. */
  readonly nudge: OccasionNudge | null;
  /**
   * Open occurrences the owner has already acknowledged.
   *
   * Kept out of `nudge` on purpose. The nudge is composed as something to say
   * to the owner, and saying an acknowledged occasion back at them is the
   * badgering this whole round exists to stop, but they asked what is coming
   * up, and an honest answer includes the one they told us they have in hand.
   */
  readonly acknowledged: readonly NudgeSubject[];
  readonly conflicts: readonly { readonly occasionId: string; readonly message: string }[];
}

export interface PendingInput {
  readonly today: IsoDate;
  readonly now: number;
  readonly leadDays: number;
  readonly occasions: readonly Occasion[];
  readonly conflicts: readonly OccasionConflict[];
  readonly openItems: readonly OpenItem[];
  readonly acknowledgements: readonly OccasionAcknowledgement[];
  /** Whether the agent is a configured push destination. */
  readonly agentIsPushed: boolean;
}

/**
 * Compose the pull. Pure: same inputs, same answer.
 *
 * The agent de-duplication is scoped TO THE DAY the push landed, and that
 * narrowing is load-bearing. It used to be permanent, an item the agent had
 * ever been pushed carried a stamp and never appeared here again, which was
 * survivable when a push repeated every few days and is not survivable now that
 * there are only two. Under the old rule, an occasion pushed once at the top of
 * its window would then be invisible to "anything coming up?" for the entire
 * ten days, which is the opposite of what the pull is for. Same day: do not say
 * it twice in one conversation. Any other day: of course it is listed.
 */
export function composePending(input: PendingInput): PendingResult {
  const byId = new Map(input.occasions.map((entry) => [entry.id, entry]));
  const ackByKey = new Map(
    input.acknowledgements.map((entry) => [`${entry.occasionId}@${entry.occurrence}`, entry]),
  );

  const open: NudgeSubject[] = [];
  const acknowledged: NudgeSubject[] = [];

  for (const item of input.openItems) {
    if (item.kind !== 'nudge') continue;
    if (item.occurrence < input.today) continue;
    const occasion = byId.get(item.occasionId);
    if (occasion === undefined) continue;

    const answer = ackByKey.get(`${item.occasionId}@${item.occurrence}`);
    // A `yes` or a `no` resolved the item and it would not be here; a `later`
    // is still an open question. Only an acknowledgement changes which list it
    // lands in.
    const isAcknowledged = answer?.answer === 'acknowledged';
    if (!isAcknowledged && input.agentIsPushed && item.agentPushedOn === input.today) continue;

    const daysUntil = daysBetween(input.today, item.occurrence);
    const subject = subjectFor(
      occasion,
      Number.isFinite(daysUntil) ? daysUntil : input.leadDays,
      isAcknowledged,
    );
    if (isAcknowledged) acknowledged.push(subject);
    else open.push(subject);
  }

  const openConflictIds = new Set(
    input.openItems.filter((item) => item.kind === 'conflict').map((item) => item.occasionId),
  );

  return {
    today: input.today,
    nudge: open.length === 0
      ? null
      : composeNudge({ id: `occasions-pending-${input.today}`, now: input.now, subjects: open }),
    acknowledged,
    conflicts: input.conflicts
      .filter((conflict) => openConflictIds.has(conflict.occasionId))
      .map((conflict) => ({
        occasionId: conflict.occasionId,
        message: composeConflictMessage(conflict.title, conflict.dates),
      })),
  };
}
