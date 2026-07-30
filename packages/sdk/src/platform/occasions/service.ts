/**
 * service.ts — the one object every occasions verb goes through.
 *
 * It owns nothing it can compute: the profile is read through a narrow source,
 * the machine state through its own store, the clock through an injected
 * function and delivery through a seam. What it owns is the SEQUENCE — capture
 * confirms once, an answer resolves an open item, a yes opens an interview, a
 * completed interview writes gift history, a removal drops orphaned state.
 *
 * That sequence lives here rather than in a consumer on purpose. A surface's job
 * is to call a verb and render what comes back; anything a surface would have to
 * compute is a second implementation waiting to disagree with this one.
 *
 * ## The TUI is not a destination, structurally
 *
 * The owner's ruling was Telegram and the agent, never the TUI, because *"that's
 * more of a 'get work done' kind of interface."* {@link resolveNudgeDestinations}
 * refuses a TUI target rather than merely not choosing one, so the rule survives
 * a composition root that wires the delivery router optimistically.
 *
 * ## Telegram and the agent, and one thing said once
 *
 * `occasions.nudgeChannel` is a LIST, so his ruling — Telegram and the agent —
 * is expressible rather than a choice between them. Each destination is pushed
 * independently and a failure on one is recorded rather than thrown, so a dead
 * Telegram token cannot silence the agent and a missing agent sender cannot
 * silence Telegram.
 *
 * The agent is also the surface that PULLS through {@link OccasionsService.pending},
 * so it is the one place where a push and a pull could say the same thing twice.
 * They cannot, because both read the same open item: a push that lands on the
 * agent stamps the item, and while the agent is a push destination the pull
 * leaves stamped items out. A push that FAILED stamps nothing, so the pull is
 * still how that nudge gets raised.
 */
import type { AuthoritySurface } from '../security/untrusted-content.js';
import type { ProfileSurface, ProfileWriteResult } from '../owner-profile/types.js';
import { summarizeError } from '../utils/error-display.js';
import { daysBetween, nextOccurrence, todayInZone, minutesOfDayInZone, type IsoDate } from './dates.js';
import { conflictItemId, interviewItemId, laterReturnDate, nudgeItemId } from './cadence.js';
import {
  answerStep,
  completeInterview,
  giftRecordFor,
  interviewIdFor,
  nextStep,
  openInterview,
} from './interview.js';
import { composeConflictMessage, composeNudge, subjectFor } from './nudge.js';
import { readOccasionsPolicy, readOccasionsTimezone, type OccasionsConfigAccess } from './policy.js';
import { readOccasions, readPlans, type OccasionProfileSource } from './reader.js';
import type { OccasionStateStore } from './state-store.js';
import { decideSweep, effectiveLead, type OccasionsPolicy, type SweepHold } from './sweep.js';
import {
  confirmOccasion,
  confirmPlan,
  proposeOccasion,
  proposePlan,
  removeOccasion,
  type ConfirmOccasionInput,
  type ConfirmPlanInput,
  type OccasionProfileWriter,
  type OccasionProposal,
  type OccasionWriteOutcome,
  type ProposeOccasionInput,
  type ProposePlanInput,
} from './capture.js';
import type {
  GiftRecord,
  Interview,
  InterviewStep,
  Occasion,
  OccasionAnswer,
  OccasionConflict,
  OccasionKind,
  OccasionNudge,
  OccasionStateDisclosure,
  OccasionSweepReport,
  OpenItem,
  Plan,
  UnparsedOccasionLine,
  UnparsedPlanLine,
} from './types.js';

/** Surfaces a proactive personal nudge is never delivered to. */
export const NUDGE_FORBIDDEN_SURFACES: readonly string[] = ['tui'];

/** The delivery surface that means the agent's own conversation. */
export const NUDGE_AGENT_SURFACE = 'agent';

/** The surface kind of one destination, lower-cased. */
export function nudgeDestinationSurface(destination: string): string {
  return (destination.split(':', 1)[0] ?? '').trim().toLowerCase();
}

/**
 * The channels a nudge may go to. Empty means pull-only.
 *
 * The setting is a comma-separated list — the same shape `payments.notifyChannels`
 * and the trigger backoff ladder use — because the owner's ruling was Telegram
 * AND the agent, and a single-valued setting would have made that a choice
 * between them. Each entry is `surfaceKind` or `surfaceKind:address`, matching
 * the channel delivery router's own form, so `telegram:12345,agent` is a valid
 * pair. Duplicates collapse: a list that names one destination twice must not
 * push the same nudge to it twice.
 *
 * The TUI is refused HERE rather than left unconfigured, because "nobody set it
 * to the TUI" is not the same guarantee as "it cannot be the TUI", and the
 * owner's ruling generalises beyond this feature: the TUI is a work interface,
 * and life-admin belongs on Telegram and the agent. A list that names the TUI
 * alongside real destinations loses the TUI entry and keeps the rest — the
 * exclusion is structural, not a reason to drop everything he asked for.
 */
export function resolveNudgeDestinations(channel: string): readonly string[] {
  const destinations: string[] = [];
  for (const entry of channel.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (NUDGE_FORBIDDEN_SURFACES.includes(nudgeDestinationSurface(trimmed))) continue;
    if (destinations.includes(trimmed)) continue;
    destinations.push(trimmed);
  }
  return destinations;
}

/** How a nudge leaves the daemon. Bound to the channel delivery router. */
export interface OccasionNudgeDeliverer {
  deliver(input: {
    readonly channel: string;
    readonly nudge: OccasionNudge;
  }): Promise<string | undefined>;
}

/**
 * Writing an occasion out to a calendar. Optional, and one-directional.
 *
 * There is no read counterpart and there never will be: a calendar entry is a
 * single occurrence of an ephemeral thing, and feed content from outside the
 * owner is untrusted content. Sourcing a durable fact about his life from one
 * would be wrong twice over.
 *
 * Implementations must be idempotent for a given `(occasionId, occurrence)`.
 * This service also remembers the external id it was handed, so the ordinary
 * path does not call the implementation twice for the same occurrence at all.
 */
export interface OccasionCalendarMirror {
  mirror(input: {
    readonly occasion: Occasion;
    readonly occurrence: IsoDate;
    /** The id previously returned for this occurrence, when there is one. */
    readonly existingExternalId?: string | undefined;
  }): Promise<string | null>;
}

export interface OccasionsServiceDeps {
  readonly profile: OccasionProfileSource;
  readonly writer: OccasionProfileWriter;
  readonly state: OccasionStateStore;
  readonly config: OccasionsConfigAccess;
  readonly deliverer?: OccasionNudgeDeliverer | undefined;
  readonly calendar?: OccasionCalendarMirror | undefined;
  readonly now?: (() => number) | undefined;
}

/** One occasion with everything a surface needs to render it. */
export interface OccasionView {
  readonly occasion: Occasion;
  readonly nextOccurrence: IsoDate | null;
  /** Whole days away. Present for a surface that IS the owner, never in a nudge. */
  readonly daysUntil: number | null;
  readonly leadDays: number;
  readonly inLeadWindow: boolean;
  readonly answer: OccasionAnswer | null;
  readonly mirrored: boolean;
}

/** What `occasions.list` answers. */
export interface OccasionListResult {
  readonly today: IsoDate;
  readonly timezone: string;
  readonly occasions: readonly OccasionView[];
  readonly unparsed: readonly UnparsedOccasionLine[];
  readonly conflicts: readonly OccasionConflict[];
}

/** What `occasions.plans.list` answers. */
export interface PlanListResult {
  readonly today: IsoDate;
  readonly plans: readonly Plan[];
  readonly unparsed: readonly UnparsedPlanLine[];
  /** The plan that has him away today, if there is one. */
  readonly awayNow: Plan | null;
}

/**
 * One destination a nudge was pushed to, and what came of it.
 *
 * Per destination rather than one verdict for the batch, because with two
 * channels configured "delivered: false" would say nothing about WHICH one went
 * quiet — and a channel he believes is reaching him and is not is the failure
 * this whole feature exists to avoid.
 */
export interface NudgeDelivery {
  /** The destination as configured: `surfaceKind` or `surfaceKind:address`. */
  readonly channel: string;
  readonly delivered: boolean;
  readonly deliveryId: string | null;
  /** Why this one did not land, when it did not. */
  readonly failure: string | null;
}

/** What one sweep did. */
export interface SweepOutcome {
  readonly ranAt: number;
  readonly today: IsoDate;
  readonly hold: SweepHold;
  readonly nudge: OccasionNudge | null;
  readonly conflictMessages: readonly string[];
  readonly resumedInterviews: readonly string[];
  /** True when at least one destination accepted the nudge. */
  readonly delivered: boolean;
  /** Every destination it was addressed to, as configured. Empty ⇒ pull-only. */
  readonly deliveryChannel: string;
  /** The id from the first destination that accepted it. */
  readonly deliveryId: string | null;
  /** One entry per destination attempted, in configured order. */
  readonly deliveries: readonly NudgeDelivery[];
  readonly mirrored: number;
  readonly housekeeping: OccasionSweepReport | null;
}

/** What the interview verbs answer. */
export interface InterviewProgress {
  readonly interviewId: string;
  readonly occasionId: string;
  readonly occurrence: IsoDate;
  readonly steps: readonly InterviewStep[];
  readonly nextStep: InterviewStep | null;
  readonly complete: boolean;
  readonly landedOn: string | null;
}

/** Everything outstanding, for a surface that pulls rather than receives. */
export interface PendingResult {
  readonly today: IsoDate;
  readonly nudge: OccasionNudge | null;
  readonly conflicts: readonly { readonly occasionId: string; readonly message: string }[];
  readonly interviews: readonly InterviewProgress[];
}

export class OccasionsService {
  constructor(private readonly deps: OccasionsServiceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private timezone(): string {
    return readOccasionsTimezone(this.deps.config);
  }

  private today(): IsoDate {
    return todayInZone(this.now(), this.timezone());
  }

  /** The effective policy, read live on every call. */
  policy(): OccasionsPolicy {
    return readOccasionsPolicy(this.deps.config);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Every declared occasion, with what the machine knows about each.
   *
   * This is the answer a surface renders. It DOES carry the date and the day
   * count, and that is not a contradiction of the never-the-date rule: this is
   * the owner asking his own system what it holds, over an authenticated verb,
   * which is exactly the explicit ask that unlocks a closed-tier read. The rule
   * is about what an unprompted message pushes onto a channel.
   */
  async list(): Promise<OccasionListResult> {
    const today = this.today();
    const policy = this.policy();
    const { occasions, unparsed, conflicts } = readOccasions(this.deps.profile);
    const acknowledgements = await this.deps.state.acknowledgements();
    const views: OccasionView[] = occasions.map((occasion) => {
      const occurrence = nextOccurrence(occasion.date, occasion.recurrence, today);
      const daysUntil = occurrence === null ? null : daysBetween(today, occurrence);
      const lead = effectiveLead(occasion, policy);
      const answer = occurrence === null
        ? null
        : acknowledgements.find(
          (entry) => entry.occasionId === occasion.id && entry.occurrence === occurrence,
        )?.answer ?? null;
      return {
        occasion,
        nextOccurrence: occurrence,
        daysUntil,
        leadDays: lead,
        inLeadWindow: daysUntil !== null && Number.isFinite(daysUntil) && daysUntil <= lead,
        answer,
        mirrored: occasion.mirrored,
      };
    });
    return { today, timezone: this.timezone(), occasions: views, unparsed, conflicts };
  }

  /** Every declared plan, and whether one has him away right now. */
  listPlans(): PlanListResult {
    const today = this.today();
    const { plans, unparsed } = readPlans(this.deps.profile);
    const awayNow = plans.find((plan) => plan.away && plan.from <= today && today <= plan.to) ?? null;
    return { today, plans, unparsed, awayNow };
  }

  /** What the machine-owned store is holding, and what the last sweep removed. */
  async disclose(): Promise<OccasionStateDisclosure> {
    return this.deps.state.disclose();
  }

  /** What he landed on before, for one occasion. */
  async giftHistory(occasionId: string): Promise<readonly GiftRecord[]> {
    return this.deps.state.giftHistory(occasionId);
  }

  // -------------------------------------------------------------------------
  // Capture — proposed, confirmed once, then silent (see capture.ts)
  // -------------------------------------------------------------------------

  /** What would be written, and the one line to put to him. Writes nothing. */
  proposeOccasion(input: ProposeOccasionInput): OccasionProposal {
    return proposeOccasion(this.deps.profile, input);
  }

  /** Write the confirmed occasion. Refuses without a kind rather than guessing. */
  async confirmOccasion(input: ConfirmOccasionInput): Promise<OccasionWriteOutcome> {
    return confirmOccasion(this.deps.profile, this.deps.writer, input);
  }

  /** The same two-step capture, for a plan. */
  proposePlan(input: ProposePlanInput): OccasionProposal {
    return proposePlan(input);
  }

  async confirmPlan(input: ConfirmPlanInput): Promise<OccasionWriteOutcome> {
    return confirmPlan(this.deps.writer, input);
  }

  /** Remove an occasion and everything the machine remembered about it. */
  async removeOccasion(input: {
    readonly occasionId: string;
    readonly confirmed: boolean;
    readonly authority: AuthoritySurface;
  }): Promise<OccasionWriteOutcome> {
    return removeOccasion(
      this.deps.profile,
      this.deps.writer,
      (id) => this.deps.state.dropOccasion(id),
      input,
    );
  }

  // -------------------------------------------------------------------------
  // Answers
  // -------------------------------------------------------------------------

  /**
   * Record yes, no or later for one occurrence.
   *
   *  - **no** — silent for the rest of this cycle. The record expires with the
   *    occurrence, so next year asks fresh carrying no memory of the refusal.
   *  - **later** — not a decline. It comes back roughly halfway to the date.
   *  - **yes** — opens the interview, and the answer is what stops the nudging.
   *
   * A one-off carries no expiry: "handled" is permanent for something that
   * happens once.
   */
  async answer(input: {
    readonly occasionId: string;
    readonly answer: OccasionAnswer;
    readonly occurrence?: string | undefined;
  }): Promise<{ readonly ok: boolean; readonly reason: string | null; readonly interview: InterviewProgress | null }> {
    const today = this.today();
    const now = this.now();
    const occasion = readOccasions(this.deps.profile).occasions.find(
      (entry) => entry.id === input.occasionId,
    );
    if (occasion === undefined) {
      return { ok: false, reason: 'There is no occasion by that name.', interview: null };
    }
    const occurrence = input.occurrence ?? nextOccurrence(occasion.date, occasion.recurrence, today);
    if (occurrence === null) {
      return { ok: false, reason: 'That occasion has no upcoming date.', interview: null };
    }

    await this.deps.state.recordAnswer({
      id: `${occasion.id}@${occurrence}`,
      occasionId: occasion.id,
      occurrence,
      answer: input.answer,
      answeredAt: now,
      ...(occasion.recurrence === 'annual' ? { expiresAfter: occurrence } : {}),
      ...(input.answer === 'later' ? { returnOn: laterReturnDate(today, occurrence) } : {}),
    });

    if (input.answer === 'later') {
      // The open item stays OPEN and moves; "later" is an answer to this
      // moment, not to the question.
      const item = await this.deps.state.openItem(nudgeItemId(occasion.id, occurrence));
      if (item !== undefined) {
        await this.deps.state.putOpenItem({ ...item, dueOn: laterReturnDate(today, occurrence) });
      }
      return { ok: true, reason: null, interview: null };
    }

    await this.deps.state.resolveOpenItem(nudgeItemId(occasion.id, occurrence));
    if (input.answer === 'no' || occasion.kind !== 'gift-giving') {
      return { ok: true, reason: null, interview: null };
    }
    const interview = await this.startInterview(occasion, occurrence, now);
    return { ok: true, reason: null, interview: progressOf(interview) };
  }

  // -------------------------------------------------------------------------
  // The interview
  // -------------------------------------------------------------------------

  private async startInterview(
    occasion: Occasion,
    occurrence: IsoDate,
    now: number,
  ): Promise<Interview> {
    const existing = await this.deps.state.activeInterview(occasion.id, occurrence);
    if (existing !== undefined) return existing;
    const policy = this.policy();
    const subject = occasion.person.trim().length > 0 ? occasion.person : occasion.title;
    const interview = openInterview({
      occasion,
      occurrence,
      now,
      personLines: this.deps.profile.person(subject),
      history: await this.deps.state.giftHistory(occasion.id),
      maxQuestions: policy.interviewQuestions,
    });
    await this.deps.state.putInterview(interview);
    return interview;
  }

  /** The interview for one occasion, resumed at the question he did not answer. */
  async interview(interviewId: string): Promise<InterviewProgress | null> {
    const found = await this.deps.state.interview(interviewId);
    return found === undefined ? null : progressOf(found);
  }

  /** Record one answer and hand back the next question, if there is one. */
  async answerInterview(input: {
    readonly interviewId: string;
    readonly stepId: string;
    readonly text: string;
  }): Promise<InterviewProgress | null> {
    const found = await this.deps.state.interview(input.interviewId);
    if (found === undefined) return null;
    const updated = answerStep(found, input.stepId, input.text, this.now());
    await this.deps.state.putInterview(updated);
    return progressOf(updated);
  }

  /**
   * Close the interview with what he landed on, and write the gift history.
   *
   * Recording the OUTCOME is the point: "he said yes in 2026" cannot stop year
   * three steering where year one did, and a history that only holds answers is
   * a history of questions.
   */
  async recordGiftOutcome(input: {
    readonly interviewId: string;
    readonly landedOn: string;
  }): Promise<InterviewProgress | null> {
    const found = await this.deps.state.interview(input.interviewId);
    if (found === undefined) return null;
    const completed = completeInterview(found, input.landedOn.trim(), this.now());
    await this.deps.state.putInterview(completed);
    const record = giftRecordFor(completed);
    if (record !== null) await this.deps.state.recordGift(record);
    await this.deps.state.resolveOpenItem(interviewItemId(completed.occasionId, completed.occurrence));
    return progressOf(completed);
  }

  // -------------------------------------------------------------------------
  // The sweep
  // -------------------------------------------------------------------------

  /**
   * One pass: reap, decide, mirror, deliver, remember.
   *
   * Housekeeping runs FIRST and unconditionally — before the enabled check and
   * before quiet hours — because a store that only reaps when the feature is
   * allowed to speak is a store that never reaps on a machine where he turned
   * nudging off.
   */
  async sweep(): Promise<SweepOutcome> {
    const now = this.now();
    const today = todayInZone(now, this.timezone());
    const policy = this.policy();
    const { occasions, conflicts } = readOccasions(this.deps.profile);
    const { plans } = readPlans(this.deps.profile);

    const housekeeping = await this.deps.state.sweep({
      today,
      now,
      declaredOccasionIds: new Set(occasions.map((entry) => entry.id)),
      giftHistoryYears: policy.giftHistoryYears,
    });

    const decision = decideSweep({
      now,
      today,
      minutesOfDay: minutesOfDayInZone(now, this.timezone()),
      occasions,
      conflicts,
      plans,
      acknowledgements: await this.deps.state.acknowledgements(),
      openItems: await this.deps.state.openItems(),
      interviews: await this.interviewsInFlight(),
      policy,
    });

    const mirrored = policy.calendarMirror ? await this.runMirror(occasions, today, now) : 0;

    if (decision.hold !== null) {
      return {
        ranAt: now,
        today,
        hold: decision.hold,
        nudge: null,
        conflictMessages: [],
        resumedInterviews: [],
        delivered: false,
        deliveryChannel: '',
        deliveryId: null,
        deliveries: [],
        mirrored,
        housekeeping,
      };
    }

    for (const item of decision.openItemWrites) await this.deps.state.putOpenItem(item);

    const nudge = decision.due.length === 0
      ? null
      : composeNudge({
        id: `occasions-${now}`,
        now,
        subjects: decision.due.map((entry) => subjectFor(entry.occasion, entry.daysUntil)),
      });

    const conflictMessages = decision.conflicts.map(
      (conflict) => composeConflictMessage(conflict.title, conflict.dates),
    );

    const destinations = resolveNudgeDestinations(policy.nudgeChannel);
    const deliveries = nudge === null ? [] : await this.pushNudge(nudge, destinations);
    const landed = deliveries.filter((entry) => entry.delivered);
    // Only a push that ACTUALLY landed on the agent stamps the items. A stamp
    // written on an attempt would silence the pull for a nudge that never
    // arrived anywhere, which is the one outcome this feature cannot have.
    if (landed.some((entry) => nudgeDestinationSurface(entry.channel) === NUDGE_AGENT_SURFACE)) {
      await this.stampSpokenToAgent(decision.openItemWrites, today);
    }

    return {
      ranAt: now,
      today,
      hold: null,
      nudge,
      conflictMessages,
      resumedInterviews: decision.resumeInterviews.map((entry) => entry.id),
      delivered: landed.length > 0,
      deliveryChannel: destinations.join(', '),
      deliveryId: landed[0]?.deliveryId ?? null,
      deliveries,
      mirrored,
      housekeeping,
    };
  }

  /**
   * Push one nudge to every configured destination, independently.
   *
   * A destination that throws is RECORDED and the next one is still tried. The
   * alternative — letting the first failure escape — means an expired Telegram
   * token stops the agent hearing about his wife's birthday, and the two have
   * nothing to do with each other. Nothing is swallowed: each failure comes back
   * in the outcome, the router has already logged it against its surface and
   * strategy, and the sweep's caller logs the count.
   */
  private async pushNudge(
    nudge: OccasionNudge,
    destinations: readonly string[],
  ): Promise<readonly NudgeDelivery[]> {
    const deliverer = this.deps.deliverer;
    if (deliverer === undefined) return [];
    const results: NudgeDelivery[] = [];
    for (const channel of destinations) {
      try {
        const deliveryId = (await deliverer.deliver({ channel, nudge })) ?? null;
        results.push({ channel, delivered: true, deliveryId, failure: null });
      } catch (error) {
        results.push({
          channel,
          delivered: false,
          deliveryId: null,
          failure: summarizeError(error),
        });
      }
    }
    return results;
  }

  /**
   * Remember that the agent has these items in hand.
   *
   * Written AFTER the push rather than folded into the raise, so an item is
   * never marked as spoken by a delivery that had not happened yet. The items
   * were already persisted by the raise above, so this is a second write of the
   * same records with one field added — cheap, ordered through the store's own
   * queue, and the only way the stamp can be honest about what landed.
   */
  private async stampSpokenToAgent(
    raised: readonly OpenItem[],
    today: IsoDate,
  ): Promise<void> {
    for (const item of raised) {
      if (item.kind !== 'nudge') continue;
      await this.deps.state.putOpenItem({ ...item, agentPushedOn: today });
    }
  }

  /** Unfinished interviews, for the resume case. */
  private async interviewsInFlight(): Promise<readonly Interview[]> {
    const items = await this.deps.state.openItems();
    const found: Interview[] = [];
    for (const item of items) {
      if (item.kind !== 'interview') continue;
      const interview = await this.deps.state.interview(
        interviewIdFor(item.occasionId, item.occurrence),
      );
      if (interview !== undefined && interview.completedAt === undefined) found.push(interview);
    }
    // An interview that has no open item yet — one just started by a `yes` —
    // is also in flight, and is what creates the item on the next sweep.
    const started = await this.deps.state.acknowledgements();
    for (const ack of started) {
      if (ack.answer !== 'yes') continue;
      const id = interviewIdFor(ack.occasionId, ack.occurrence);
      if (found.some((entry) => entry.id === id)) continue;
      const interview = await this.deps.state.interview(id);
      if (interview !== undefined && interview.completedAt === undefined) found.push(interview);
    }
    return found;
  }

  /**
   * Write occasions out to the calendar, once each.
   *
   * A previously recorded external id is passed back to the implementation so
   * the mirror is idempotent even where the calendar itself has no natural key,
   * and an occurrence already mirrored is not offered again at all.
   */
  private async runMirror(
    occasions: readonly Occasion[],
    today: IsoDate,
    now: number,
  ): Promise<number> {
    const mirror = this.deps.calendar;
    if (mirror === undefined) return 0;
    let count = 0;
    for (const occasion of occasions) {
      if (occasion.kind === 'neither') continue;
      const occurrence = nextOccurrence(occasion.date, occasion.recurrence, today);
      if (occurrence === null) continue;
      const existing = await this.deps.state.mirrorFor(occasion.id, occurrence);
      if (existing !== undefined) continue;
      const externalId = await mirror.mirror({ occasion, occurrence });
      if (externalId === null) continue;
      await this.deps.state.recordMirror({
        occasionId: occasion.id,
        occurrence,
        externalId,
        mirroredAt: now,
      });
      count += 1;
    }
    return count;
  }

  /**
   * Everything outstanding, without delivering anything.
   *
   * This is how a surface that is not a push destination receives a nudge: it
   * pulls what is open at the top of a turn rather than being pushed at. A
   * stored date is the prior scheduling that permits raising something
   * unprompted, which is what keeps this consistent with the agent being
   * conversation-first.
   *
   * When the agent IS a configured push destination, an item a push has already
   * landed there is left out. The push and the pull are two ways of getting the
   * same thing to the same conversation, and doing both would have the agent
   * raise one birthday twice. The condition is the LANDED push rather than the
   * configuration: with `agent` configured but the sender not registered, or the
   * send failing, nothing is stamped and everything still comes back here — so
   * the guard cannot turn into a way of dropping a nudge.
   */
  async pending(): Promise<PendingResult> {
    const today = this.today();
    const policy = this.policy();
    const { occasions, conflicts } = readOccasions(this.deps.profile);
    const items = await this.deps.state.openItems();
    const byId = new Map(occasions.map((entry) => [entry.id, entry]));
    const agentIsPushed = resolveNudgeDestinations(policy.nudgeChannel).some(
      (destination) => nudgeDestinationSurface(destination) === NUDGE_AGENT_SURFACE,
    );

    const subjects = items
      .filter((item) => item.kind === 'nudge' && item.occurrence >= today)
      .filter((item) => !(agentIsPushed && item.agentPushedOn !== undefined))
      .map((item) => {
        const occasion = byId.get(item.occasionId);
        if (occasion === undefined) return null;
        const daysUntil = daysBetween(today, item.occurrence);
        return subjectFor(occasion, Number.isFinite(daysUntil) ? daysUntil : policy.leadDays);
      })
      .filter((subject): subject is NonNullable<typeof subject> => subject !== null);

    const openConflictIds = new Set(
      items.filter((item) => item.kind === 'conflict').map((item) => item.occasionId),
    );
    return {
      today,
      nudge: subjects.length === 0
        ? null
        : composeNudge({ id: `occasions-pending-${today}`, now: this.now(), subjects }),
      conflicts: conflicts
        .filter((conflict) => openConflictIds.has(conflict.occasionId))
        .map((conflict) => ({
          occasionId: conflict.occasionId,
          message: composeConflictMessage(conflict.title, conflict.dates),
        })),
      interviews: (await this.interviewsInFlight()).map(progressOf),
    };
  }

  /** Mark a conflict as dealt with, so it stops being re-raised. */
  async resolveConflict(occasionId: string): Promise<boolean> {
    return this.deps.state.resolveOpenItem(conflictItemId(occasionId));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function progressOf(interview: Interview): InterviewProgress {
  const step = nextStep(interview);
  return {
    interviewId: interview.id,
    occasionId: interview.occasionId,
    occurrence: interview.occurrence,
    steps: interview.steps,
    nextStep: step ?? null,
    complete: interview.completedAt !== undefined,
    landedOn: interview.landedOn ?? null,
  };
}

