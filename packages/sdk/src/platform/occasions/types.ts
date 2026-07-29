/**
 * types.ts — the shapes of occasions, plans, acknowledgements and nudges.
 *
 * Two things live here, and they are deliberately not one thing (docs/occasions.md §2):
 *
 *  - An **occasion** is dated, usually recurring, and NEEDS AN ACTION. A birthday,
 *    an anniversary. It prompts, and the answer is remembered.
 *  - A **plan** is a dated range with attributes and is AMBIENT. "Vacation,
 *    12–19 September, Lisbon." There is nothing to decide; the system needs to
 *    know so it can stop suggesting things into that window, and so it can move
 *    a nudge that would otherwise land while he is away.
 *
 * Both are declarations the owner owns, so both live as prose lines in his
 * profile file. Nothing machine-written goes there — the acknowledgement state
 * below is a separate machine-owned store, because the profile design's whole
 * guarantee is that a validator never rewrites a line he wrote.
 */
import type { IsoDate, OccasionDate, OccasionRecurrence } from './dates.js';

export type { IsoDate, OccasionDate, OccasionRecurrence } from './dates.js';

/**
 * What an occasion wants, chosen by the owner at capture and NEVER inferred.
 *
 * The reason this is not a guess: a parent's death anniversary is worth
 * remembering, and a cheerful "you'll probably want to sort something" against
 * it would be genuinely bad. There is no heuristic that gets that right from a
 * label, so there is no heuristic.
 *
 *  - `gift-giving`  — raise it, and a yes opens the gift interview.
 *  - `remember-only`— raise it, and never mention a gift.
 *  - `neither`      — never raise it. It is recorded so the date can be
 *                     answered when he asks, and for nothing else.
 */
export type OccasionKind = 'gift-giving' | 'remember-only' | 'neither';

export const OCCASION_KINDS: readonly OccasionKind[] = ['gift-giving', 'remember-only', 'neither'];

export function isOccasionKind(value: string): value is OccasionKind {
  return (OCCASION_KINDS as readonly string[]).includes(value);
}

/**
 * One occasion, as declared in the profile.
 *
 * `id` is derived from the title rather than minted, so the same line reloaded
 * after a hand edit is the same occasion and its acknowledgement state survives.
 * Editing the TITLE does orphan the state — and orphaned state is reaped, which
 * is the honest outcome: he renamed the thing, and last year's "no" was about
 * something with a different name.
 */
export interface Occasion {
  /** Normalised title. Stable across date, kind and lead edits. */
  readonly id: string;
  /** The title exactly as written. */
  readonly title: string;
  readonly date: OccasionDate;
  readonly recurrence: OccasionRecurrence;
  readonly kind: OccasionKind;
  /** The person it is about, as a plain label. Empty when the title carries it. */
  readonly person: string;
  /** Per-occasion lead override in days, or `null` for the configured default. */
  readonly leadDays: number | null;
  /** True when this occasion has been mirrored out to a calendar. */
  readonly mirrored: boolean;
  /** Segments this module did not recognise, preserved so nothing is lost. */
  readonly extras: readonly string[];
  /** Index of the line in the profile document, for a surgical removal. */
  readonly lineIndex: number;
  /** The line's text as written, minus its provenance suffix. */
  readonly text: string;
}

/**
 * A line under the dates heading that did not parse as an occasion.
 *
 * Reported, never rewritten and never dropped — the same contract the profile's
 * mechanical fields have. A line the parser dislikes is still his line.
 */
export interface UnparsedOccasionLine {
  readonly lineIndex: number;
  readonly text: string;
  readonly reason: string;
}

/** One plan: a dated range with attributes. Ambient; never prompts. */
export interface Plan {
  readonly id: string;
  readonly title: string;
  readonly from: IsoDate;
  readonly to: IsoDate;
  /** True when the owner is away from home for this plan. Feeds nudge timing. */
  readonly away: boolean;
  /** Where, when he said. Empty when he did not. */
  readonly destination: string;
  readonly extras: readonly string[];
  readonly lineIndex: number;
  readonly text: string;
}

/** A line under the plans heading that did not parse. Same contract as above. */
export interface UnparsedPlanLine {
  readonly lineIndex: number;
  readonly text: string;
  readonly reason: string;
}

/**
 * Two declarations of the same occasion that disagree about the date.
 *
 * Raised immediately and re-raised if ignored. The newer value is NEVER taken
 * silently: he said two different things and only he knows which was right.
 */
export interface OccasionConflict {
  readonly occasionId: string;
  readonly title: string;
  /** Every distinct date declared for this occasion, in document order. */
  readonly dates: readonly string[];
  readonly lineIndexes: readonly number[];
}

/** What the owner answered when asked about an occasion. */
export type OccasionAnswer = 'yes' | 'no' | 'later';

export const OCCASION_ANSWERS: readonly OccasionAnswer[] = ['yes', 'no', 'later'];

export function isOccasionAnswer(value: string): value is OccasionAnswer {
  return (OCCASION_ANSWERS as readonly string[]).includes(value);
}

/**
 * One recorded answer, for ONE occurrence.
 *
 * Keyed by occurrence rather than by occasion, which is what makes "declining
 * goes silent until the date passes, then asks fresh next year" a property of
 * the data rather than a rule someone has to remember to apply. Next year's
 * occurrence has no record, so next year asks, carrying no memory of the refusal.
 *
 * `expiresAfter` is the occurrence date for a recurring occasion and absent for
 * a one-off, where "handled" is permanent.
 */
export interface OccasionAcknowledgement {
  readonly id: string;
  readonly occasionId: string;
  readonly occurrence: IsoDate;
  readonly answer: OccasionAnswer;
  readonly answeredAt: number;
  /** Absent ⇒ permanent. Present ⇒ reaped once this date has passed. */
  readonly expiresAfter?: IsoDate | undefined;
  /** For `later`: the date the question comes back. */
  readonly returnOn?: IsoDate | undefined;
}

/**
 * What he landed on, not merely that he said yes.
 *
 * Kept so year three does not steer where year one did. It outlives the
 * acknowledgement deliberately: the answer expires with its occurrence, the
 * history is the point.
 */
export interface GiftRecord {
  readonly occasionId: string;
  readonly occurrence: IsoDate;
  readonly recordedAt: number;
  /** What he settled on, in his words. */
  readonly landedOn: string;
  readonly notes?: string | undefined;
}

/**
 * One occasion written out to a calendar, remembered so it is written once.
 *
 * The mirror is not the record and this is not a second source of truth: it
 * holds the external id of an entry this system CREATED, and it exists so the
 * mirror is idempotent — re-writing the same occasion each year must not
 * accumulate duplicates. Nothing reads a calendar to build an occasion, so
 * deleting the calendar entry does not delete anything here; the next mirror
 * pass simply writes it again.
 */
export interface OccasionMirrorRecord {
  readonly occasionId: string;
  readonly occurrence: IsoDate;
  /** The external calendar's own id for the entry this system created. */
  readonly externalId: string;
  readonly mirroredAt: number;
}

/** Which unresolved thing an open item is. One mechanism, three cases. */
export type OpenItemKind = 'nudge' | 'conflict' | 'interview';

/**
 * Something raised and not yet resolved.
 *
 * The governing principle is that nothing unresolved is ever dropped, and this
 * is the one mechanism behind all three of its cases: an unanswered nudge, a
 * conflict he ignored, and an interview he walked away from mid-thread. Silence
 * ends nothing; it only moves `dueAt`.
 */
export interface OpenItem {
  readonly id: string;
  readonly kind: OpenItemKind;
  /** The occasion this concerns. */
  readonly occasionId: string;
  /** The occurrence, for a nudge or an interview. Empty for a conflict. */
  readonly occurrence: IsoDate;
  readonly openedAt: number;
  readonly lastRaisedAt: number;
  readonly raiseCount: number;
  /** The calendar day this may be raised again. */
  readonly dueOn: IsoDate;
  /** The occurrence this item dies with; absent ⇒ it lives until resolved. */
  readonly expiresAfter?: IsoDate | undefined;
}

/** One occasion inside a nudge. Carries the person; never carries the date. */
export interface NudgeSubject {
  readonly occasionId: string;
  readonly title: string;
  readonly person: string;
  readonly kind: OccasionKind;
  /** How close it is, as a word. Never a count of days and never a date. */
  readonly proximity: 'approaching' | 'soon' | 'imminent';
}

/**
 * A nudge, ready to render.
 *
 * `message` is the rendered text and `subjects` is the same content structured,
 * so a surface can lay it out its own way without re-deriving anything. Neither
 * carries a date: the date is a closed-tier read, disclosed only on an explicit
 * ask, and a reminder delivered to a message channel must not put a family
 * member's birth date into that channel.
 */
export interface OccasionNudge {
  readonly id: string;
  readonly raisedAt: number;
  readonly subjects: readonly NudgeSubject[];
  readonly message: string;
  /** True when this batch invites a yes/no/later answer. */
  readonly answerable: boolean;
}

/** One question in the gift interview, and why it is being asked. */
export interface InterviewStep {
  readonly id: string;
  readonly prompt: string;
  /** The profile prose this question was opened from, verbatim. Empty when none. */
  readonly opensFrom: string;
}

/** An interview in progress, or one that was walked away from. */
export interface Interview {
  readonly id: string;
  readonly occasionId: string;
  readonly occurrence: IsoDate;
  readonly startedAt: number;
  readonly steps: readonly InterviewStep[];
  /** Answers keyed by step id, in the order they were given. */
  readonly answers: readonly InterviewAnswer[];
  /** Set when he landed on something; the interview is then complete. */
  readonly landedOn?: string | undefined;
  readonly completedAt?: number | undefined;
}

export interface InterviewAnswer {
  readonly stepId: string;
  readonly text: string;
  readonly answeredAt: number;
}

/** What the acknowledgement store discloses about itself. */
export interface OccasionStateDisclosure {
  readonly path: string;
  readonly acknowledgements: number;
  readonly giftRecords: number;
  readonly openItems: number;
  readonly interviews: number;
  readonly mirrors: number;
  /** Records dropped by the last sweep, by reason. */
  readonly lastSweep: OccasionSweepReport | null;
  /** Non-null when the file existed and could not be read. */
  readonly corruption: string | null;
}

/** What a housekeeping pass removed, and why. */
export interface OccasionSweepReport {
  readonly sweptAt: number;
  /** Answers whose occurrence has passed, so next cycle asks fresh. */
  readonly expiredAcknowledgements: number;
  /** State whose occasion is no longer declared in the profile. */
  readonly orphanedRecords: number;
  /** Open items whose occurrence has passed unanswered. */
  readonly expiredOpenItems: number;
  /** Gift records older than the configured retention. */
  readonly agedGiftRecords: number;
  /** Interviews dropped with their occasion or occurrence. */
  readonly droppedInterviews: number;
  /** Mirror records whose occurrence has passed or whose occasion is gone. */
  readonly staleMirrors: number;
}

export const OCCASIONS_CONFIG_KEYS = {
  enabled: 'occasions.enabled',
  leadDays: 'occasions.leadDays',
  activeHours: 'occasions.activeHours',
  nudgeChannel: 'occasions.nudgeChannel',
  cadenceDays: 'occasions.cadenceDays',
  finalStretchDays: 'occasions.finalStretchDays',
  awayAdjust: 'occasions.awayAdjust',
  calendarMirror: 'occasions.calendarMirror',
  suppressMirroredNudges: 'occasions.suppressMirroredNudges',
  interviewQuestions: 'occasions.interviewQuestions',
  giftHistoryYears: 'occasions.giftHistoryYears',
  sweepIntervalMinutes: 'occasions.sweepIntervalMinutes',
} as const;

/** The heading occasions are declared under. A canonical profile section. */
export const OCCASIONS_SECTION = 'Important dates';

/** The heading plans are declared under. A canonical profile section. */
export const PLANS_SECTION = 'Plans';
