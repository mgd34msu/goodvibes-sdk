/**
 * state-store.ts — everything the MACHINE knows about occasions.
 *
 * The split this file exists for: an occasion declaration is a durable fact
 * about the owner's life, so it lives in his profile where he can hand-edit it.
 * "Asked on the 3rd, he said no" is machine-written bookkeeping, and the profile
 * design's whole guarantee is that nothing rewrites a line he wrote. Putting
 * acknowledgement state in that file would break the guarantee to save one file,
 * so it does not go there. It goes here.
 *
 * ── The persisted-state treatment, in full ────────────────────────────────
 *
 * Anything persisted across restarts reaps, bounds, validates by content, sweeps
 * periodically, and discloses. All five, not four:
 *
 *  - **Bounded.** Every collection has a cap and the oldest go first, so a
 *    long-lived daemon cannot grow this file without limit.
 *  - **Validated by content.** Records are checked one at a time and a bad one
 *    is DROPPED AND COUNTED rather than throwing the file away. A single
 *    malformed record must not cost him a decade of gift history.
 *  - **Reaped on schedule.** An answer dies with its occurrence, which is what
 *    makes "declining goes silent until the date passes, then asks fresh next
 *    year" a property of the data rather than a rule someone must remember.
 *  - **Swept.** {@link OccasionStateStore.sweep} drops orphans — state whose
 *    occasion is no longer declared — and ages out gift history past its
 *    retention.
 *  - **Discloses.** {@link OccasionStateStore.disclose} says what it is holding
 *    and what the last sweep removed, including whether the file was found
 *    unreadable.
 *
 * ── Write ordering ────────────────────────────────────────────────────────
 *
 * Every write goes through a {@link StoreWriteQueue}. `PersistentStore.persist`
 * is atomic and says nothing about ORDER, and this store has genuinely
 * concurrent writers: the sweep runs on a timer while an answer arrives over a
 * channel and an interview step lands from the agent. Unordered, the sweep's
 * snapshot — taken before the answer existed — can land second and put the file
 * back without it. The owner then gets asked again about something he already
 * answered, which is the exact failure the acknowledgement store was built to
 * stop.
 */
import { PersistentStore } from '../state/persistent-store.js';
import { StoreWriteQueue } from '../state/store-write-queue.js';
import { logger } from '../utils/logger.js';
import { reconcileRaiseLedger } from './cadence.js';
import { addDays, isIsoDate, type IsoDate } from './dates.js';
import {
  isOccasionAckSource,
  isOccasionAnswer,
  isRaiseBoundary,
  type GiftRecord,
  type Interview,
  type InterviewAnswer,
  type InterviewStep,
  type OccasionAcknowledgement,
  type OccasionMirrorRecord,
  type OccasionStateDisclosure,
  type OccasionSweepReport,
  type OpenItem,
  type OpenItemKind,
  type RaiseBoundary,
} from './types.js';

/** Caps. Generous against any real life, finite against an unbounded file. */
export const MAX_ACKNOWLEDGEMENTS = 2000;
export const MAX_GIFT_RECORDS = 2000;
export const MAX_OPEN_ITEMS = 500;
export const MAX_INTERVIEWS = 200;
export const MAX_MIRRORS = 2000;

interface OccasionStateSnapshot extends Record<string, unknown> {
  version: 1;
  acknowledgements: OccasionAcknowledgement[];
  gifts: GiftRecord[];
  openItems: OpenItem[];
  interviews: Interview[];
  mirrors: OccasionMirrorRecord[];
  lastSweep: OccasionSweepReport | null;
}

function emptySnapshot(): OccasionStateSnapshot {
  return {
    version: 1,
    acknowledgements: [],
    gifts: [],
    openItems: [],
    interviews: [],
    mirrors: [],
    lastSweep: null,
  };
}

// ---------------------------------------------------------------------------
// Content validation — one record at a time
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function validAcknowledgement(value: unknown): OccasionAcknowledgement | null {
  if (!isRecord(value)) return null;
  const occasionId = str(value['occasionId']);
  const occurrence = str(value['occurrence']);
  const answer = str(value['answer']);
  const answeredAt = num(value['answeredAt']);
  if (occasionId === null || occurrence === null || answer === null || answeredAt === null) return null;
  if (!isIsoDate(occurrence) || !isOccasionAnswer(answer)) return null;
  const expiresAfter = str(value['expiresAfter']);
  const returnOn = str(value['returnOn']);
  const source = str(value['source']);
  return {
    id: str(value['id']) ?? `${occasionId}@${occurrence}`,
    occasionId,
    occurrence,
    answer,
    answeredAt,
    // An unrecognised source is dropped and the ANSWER IS KEPT. The source
    // explains a mute; the answer is the mute. Losing the whole record over a
    // provenance label would start pushing at him again to punish a typo.
    ...(source !== null && isOccasionAckSource(source) ? { source } : {}),
    ...(expiresAfter !== null && isIsoDate(expiresAfter) ? { expiresAfter } : {}),
    ...(returnOn !== null && isIsoDate(returnOn) ? { returnOn } : {}),
  };
}

function validGift(value: unknown): GiftRecord | null {
  if (!isRecord(value)) return null;
  const occasionId = str(value['occasionId']);
  const occurrence = str(value['occurrence']);
  const landedOn = str(value['landedOn']);
  const recordedAt = num(value['recordedAt']);
  if (occasionId === null || occurrence === null || landedOn === null || recordedAt === null) return null;
  if (!isIsoDate(occurrence)) return null;
  const notes = str(value['notes']);
  return { occasionId, occurrence, landedOn, recordedAt, ...(notes === null ? {} : { notes }) };
}

const OPEN_ITEM_KINDS: readonly OpenItemKind[] = ['nudge', 'conflict', 'interview'];

function validOpenItem(value: unknown): OpenItem | null {
  if (!isRecord(value)) return null;
  const id = str(value['id']);
  const kind = str(value['kind']);
  const occasionId = str(value['occasionId']);
  const dueOn = str(value['dueOn']);
  const openedAt = num(value['openedAt']);
  const lastRaisedAt = num(value['lastRaisedAt']);
  const raiseCount = num(value['raiseCount']);
  if (id === null || kind === null || occasionId === null || dueOn === null) return null;
  if (openedAt === null || lastRaisedAt === null || raiseCount === null) return null;
  if (!(OPEN_ITEM_KINDS as readonly string[]).includes(kind) || !isIsoDate(dueOn)) return null;
  const occurrence = typeof value['occurrence'] === 'string' ? value['occurrence'] : '';
  const expiresAfter = str(value['expiresAfter']);
  // Absent on every item written before boundaries existed, and absent is read
  // as EMPTY rather than as "unknown": an empty ledger plus a raise count is
  // exactly the signature the reconciliation looks for, so a legacy item is
  // recognised by its shape instead of by a version number nobody bumped.
  const rawBoundaries = Array.isArray(value['servedBoundaries']) ? value['servedBoundaries'] : [];
  const servedBoundaries = [
    ...new Set(
      rawBoundaries.filter((entry): entry is RaiseBoundary =>
        typeof entry === 'string' && isRaiseBoundary(entry)),
    ),
  ];
  // A stamp that is not a date is dropped rather than believed: it governs
  // whether the pull stays quiet about this item, and a bad value would either
  // silence a nudge or repeat one.
  const agentPushedOn = str(value['agentPushedOn']);
  return {
    id,
    kind: kind as OpenItemKind,
    occasionId,
    occurrence,
    openedAt,
    lastRaisedAt,
    raiseCount,
    servedBoundaries,
    dueOn,
    ...(expiresAfter !== null && isIsoDate(expiresAfter) ? { expiresAfter } : {}),
    ...(agentPushedOn !== null && isIsoDate(agentPushedOn) ? { agentPushedOn } : {}),
  };
}

function validInterviewStep(value: unknown): InterviewStep | null {
  if (!isRecord(value)) return null;
  const id = str(value['id']);
  const prompt = str(value['prompt']);
  if (id === null || prompt === null) return null;
  return { id, prompt, opensFrom: typeof value['opensFrom'] === 'string' ? value['opensFrom'] : '' };
}

function validInterviewAnswer(value: unknown): InterviewAnswer | null {
  if (!isRecord(value)) return null;
  const stepId = str(value['stepId']);
  const answeredAt = num(value['answeredAt']);
  if (stepId === null || answeredAt === null) return null;
  return { stepId, text: typeof value['text'] === 'string' ? value['text'] : '', answeredAt };
}

function validInterview(value: unknown): Interview | null {
  if (!isRecord(value)) return null;
  const id = str(value['id']);
  const occasionId = str(value['occasionId']);
  const occurrence = str(value['occurrence']);
  const startedAt = num(value['startedAt']);
  if (id === null || occasionId === null || occurrence === null || startedAt === null) return null;
  if (!isIsoDate(occurrence)) return null;
  const rawSteps = Array.isArray(value['steps']) ? value['steps'] : [];
  const rawAnswers = Array.isArray(value['answers']) ? value['answers'] : [];
  const steps = rawSteps.map(validInterviewStep).filter((step): step is InterviewStep => step !== null);
  const answers = rawAnswers
    .map(validInterviewAnswer)
    .filter((answer): answer is InterviewAnswer => answer !== null);
  // An interview with no questions left cannot be resumed and is not a thread
  // he can be asked to continue, so it does not survive the read.
  if (steps.length === 0) return null;
  const landedOn = str(value['landedOn']);
  const completedAt = num(value['completedAt']);
  return {
    id,
    occasionId,
    occurrence,
    startedAt,
    steps,
    answers,
    ...(landedOn === null ? {} : { landedOn }),
    ...(completedAt === null ? {} : { completedAt }),
  };
}

function validMirror(value: unknown): OccasionMirrorRecord | null {
  if (!isRecord(value)) return null;
  const occasionId = str(value['occasionId']);
  const occurrence = str(value['occurrence']);
  const externalId = str(value['externalId']);
  const mirroredAt = num(value['mirroredAt']);
  if (occasionId === null || occurrence === null || externalId === null || mirroredAt === null) return null;
  if (!isIsoDate(occurrence)) return null;
  return { occasionId, occurrence, externalId, mirroredAt };
}

function validSweepReport(value: unknown): OccasionSweepReport | null {
  if (!isRecord(value)) return null;
  const sweptAt = num(value['sweptAt']);
  if (sweptAt === null) return null;
  return {
    sweptAt,
    expiredAcknowledgements: num(value['expiredAcknowledgements']) ?? 0,
    orphanedRecords: num(value['orphanedRecords']) ?? 0,
    expiredOpenItems: num(value['expiredOpenItems']) ?? 0,
    agedGiftRecords: num(value['agedGiftRecords']) ?? 0,
    droppedInterviews: num(value['droppedInterviews']) ?? 0,
    staleMirrors: num(value['staleMirrors']) ?? 0,
  };
}

/**
 * Rebuild a snapshot record by record.
 *
 * Nothing throws. A file that is JSON but holds the wrong shape yields whatever
 * of it was well formed, and the count of what was not is logged — so a
 * half-corrupt file costs him the corrupt half, not the whole history.
 */
export function validateOccasionState(
  raw: unknown,
): { snapshot: OccasionStateSnapshot; dropped: number; reconciled: number } {
  if (!isRecord(raw)) return { snapshot: emptySnapshot(), dropped: 0, reconciled: 0 };
  let dropped = 0;
  const take = <T>(key: string, validate: (value: unknown) => T | null): T[] => {
    const list = Array.isArray(raw[key]) ? (raw[key] as readonly unknown[]) : [];
    const out: T[] = [];
    for (const entry of list) {
      const valid = validate(entry);
      if (valid === null) dropped += 1;
      else out.push(valid);
    }
    return out;
  };
  // Reconciliation runs at LOAD, before any caller can read an open item and
  // before any sweep can act on one. A machine mid-way through the old
  // repeating cadence therefore goes quiet the moment the fixed daemon boots,
  // rather than one sweep later — which on an hourly sweep would have been one
  // more push about his own birthday, and one more is the whole complaint.
  let reconciled = 0;
  const openItems = take('openItems', validOpenItem).map((item) => {
    const settled = reconcileRaiseLedger(item);
    if (settled === null) return item;
    reconciled += 1;
    return settled;
  });

  return {
    snapshot: {
      version: 1,
      acknowledgements: take('acknowledgements', validAcknowledgement),
      gifts: take('gifts', validGift),
      openItems,
      interviews: take('interviews', validInterview),
      mirrors: take('mirrors', validMirror),
      lastSweep: validSweepReport(raw['lastSweep']),
    },
    dropped,
    reconciled,
  };
}

/** What a sweep needs to know from outside: which occasions still exist. */
export interface OccasionSweepInput {
  readonly today: IsoDate;
  readonly now: number;
  /** Ids still declared in the profile. State for anything else is orphaned. */
  readonly declaredOccasionIds: ReadonlySet<string>;
  /** How long gift history is kept, in years. */
  readonly giftHistoryYears: number;
}

export class OccasionStateStore {
  private readonly store: PersistentStore<OccasionStateSnapshot>;
  private snapshot: OccasionStateSnapshot | null = null;
  private corruption: string | null = null;
  /** How many open nudges had their raise ledger rebuilt at load. Disclosed. */
  private reconciledOpenItems = 0;
  /** Whole-file writes run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();

  constructor(private readonly filePath: string) {
    this.store = new PersistentStore<OccasionStateSnapshot>(filePath);
  }

  get path(): string {
    return this.filePath;
  }

  /**
   * Read the file once, discarding what it cannot understand.
   *
   * `loadOrDiscard` rather than `load`: this store's owner has a rule for a torn
   * record — drop it, record the fact, disclose it — and a store that only threw
   * would make every later call fail forever over one unreadable byte,
   * INCLUDING the disclosure call that exists to explain exactly that state.
   */
  private async state(): Promise<OccasionStateSnapshot> {
    if (this.snapshot !== null) return this.snapshot;
    const read = await this.store.loadOrDiscard();
    if (read.corruption !== null) {
      this.corruption = read.corruption.detail;
      logger.warn('occasions: state file was unreadable and has been discarded', {
        path: this.filePath,
        detail: read.corruption.detail,
      });
      this.snapshot = emptySnapshot();
      return this.snapshot;
    }
    const { snapshot, dropped, reconciled } = validateOccasionState(read.data);
    if (dropped > 0) {
      logger.warn('occasions: dropped malformed records while loading state', {
        path: this.filePath,
        dropped,
      });
    }
    this.snapshot = snapshot;
    if (reconciled > 0) {
      this.reconciledOpenItems = reconciled;
      logger.info(
        'occasions: settled open nudges written under the old repeating cadence — '
        + 'they stay open and stop being pushed',
        { path: this.filePath, reconciled },
      );
      // Written back immediately rather than left to the next write. The
      // rebuilt ledger IS the thing that keeps him from being pushed at again,
      // and a correction that only exists in memory is one crash away from
      // undoing itself.
      await this.persist(snapshot);
    }
    return this.snapshot;
  }

  private async persist(snapshot: OccasionStateSnapshot): Promise<void> {
    await this.writes.run(() => this.store.persist({
      version: 1,
      acknowledgements: [...snapshot.acknowledgements],
      gifts: [...snapshot.gifts],
      openItems: [...snapshot.openItems],
      interviews: [...snapshot.interviews],
      mirrors: [...snapshot.mirrors],
      lastSweep: snapshot.lastSweep,
    }));
  }

  // -------------------------------------------------------------------------
  // Answers
  // -------------------------------------------------------------------------

  /** The answer recorded for one occurrence, if there is one. */
  async answerFor(occasionId: string, occurrence: IsoDate): Promise<OccasionAcknowledgement | undefined> {
    const snapshot = await this.state();
    return snapshot.acknowledgements.find(
      (entry) => entry.occasionId === occasionId && entry.occurrence === occurrence,
    );
  }

  async acknowledgements(): Promise<readonly OccasionAcknowledgement[]> {
    return [...(await this.state()).acknowledgements];
  }

  /**
   * Record an answer, replacing any earlier answer for the SAME occurrence.
   *
   * Replacing rather than appending is the point: "later" then "no" is one
   * decision that changed, not two decisions, and keeping both would leave the
   * sweep reading whichever it found first.
   */
  async recordAnswer(entry: OccasionAcknowledgement): Promise<OccasionAcknowledgement> {
    const snapshot = await this.state();
    const kept = snapshot.acknowledgements.filter(
      (existing) => !(existing.occasionId === entry.occasionId && existing.occurrence === entry.occurrence),
    );
    kept.push(entry);
    if (kept.length > MAX_ACKNOWLEDGEMENTS) kept.splice(0, kept.length - MAX_ACKNOWLEDGEMENTS);
    snapshot.acknowledgements = kept;
    await this.persist(snapshot);
    return entry;
  }

  // -------------------------------------------------------------------------
  // Gift history
  // -------------------------------------------------------------------------

  /** What he landed on for this occasion before, newest first. */
  async giftHistory(occasionId: string): Promise<readonly GiftRecord[]> {
    const snapshot = await this.state();
    return snapshot.gifts
      .filter((entry) => entry.occasionId === occasionId)
      .sort((left, right) => right.recordedAt - left.recordedAt);
  }

  async recordGift(entry: GiftRecord): Promise<GiftRecord> {
    const snapshot = await this.state();
    const kept = snapshot.gifts.filter(
      (existing) => !(existing.occasionId === entry.occasionId && existing.occurrence === entry.occurrence),
    );
    kept.push(entry);
    if (kept.length > MAX_GIFT_RECORDS) kept.splice(0, kept.length - MAX_GIFT_RECORDS);
    snapshot.gifts = kept;
    await this.persist(snapshot);
    return entry;
  }

  // -------------------------------------------------------------------------
  // Open items — the one mechanism behind "nothing unresolved is dropped"
  // -------------------------------------------------------------------------

  async openItems(): Promise<readonly OpenItem[]> {
    return [...(await this.state()).openItems];
  }

  async openItem(id: string): Promise<OpenItem | undefined> {
    return (await this.state()).openItems.find((entry) => entry.id === id);
  }

  /** Create or replace one open item, addressed by its id. */
  async putOpenItem(item: OpenItem): Promise<OpenItem> {
    const snapshot = await this.state();
    const kept = snapshot.openItems.filter((existing) => existing.id !== item.id);
    kept.push(item);
    if (kept.length > MAX_OPEN_ITEMS) kept.splice(0, kept.length - MAX_OPEN_ITEMS);
    snapshot.openItems = kept;
    await this.persist(snapshot);
    return item;
  }

  /**
   * Remove an open item because it is RESOLVED.
   *
   * No tombstone and no resolved flag: a resolved item is gone, matching the
   * profile's own delete-means-delete rule. What survives resolution is the
   * thing that answers "what happened" — the acknowledgement, or the gift
   * record — not a husk of the question.
   */
  async resolveOpenItem(id: string): Promise<boolean> {
    const snapshot = await this.state();
    const before = snapshot.openItems.length;
    snapshot.openItems = snapshot.openItems.filter((entry) => entry.id !== id);
    if (snapshot.openItems.length === before) return false;
    await this.persist(snapshot);
    return true;
  }

  // -------------------------------------------------------------------------
  // Interviews
  // -------------------------------------------------------------------------

  async interview(id: string): Promise<Interview | undefined> {
    return (await this.state()).interviews.find((entry) => entry.id === id);
  }

  /** The unfinished interview for one occurrence, if he walked away from one. */
  async activeInterview(occasionId: string, occurrence: IsoDate): Promise<Interview | undefined> {
    return (await this.state()).interviews.find(
      (entry) => entry.occasionId === occasionId
        && entry.occurrence === occurrence
        && entry.completedAt === undefined,
    );
  }

  async putInterview(interview: Interview): Promise<Interview> {
    const snapshot = await this.state();
    const kept = snapshot.interviews.filter((existing) => existing.id !== interview.id);
    kept.push(interview);
    if (kept.length > MAX_INTERVIEWS) kept.splice(0, kept.length - MAX_INTERVIEWS);
    snapshot.interviews = kept;
    await this.persist(snapshot);
    return interview;
  }

  // -------------------------------------------------------------------------
  // Calendar mirror
  // -------------------------------------------------------------------------

  /** The mirror already written for this occurrence, if there is one. */
  async mirrorFor(occasionId: string, occurrence: IsoDate): Promise<OccasionMirrorRecord | undefined> {
    return (await this.state()).mirrors.find(
      (entry) => entry.occasionId === occasionId && entry.occurrence === occurrence,
    );
  }

  /**
   * Remember that one occurrence has been written out.
   *
   * Keyed by occasion AND occurrence, replacing rather than appending, which is
   * what makes the mirror idempotent: writing the same occasion again next year
   * adds one record, and writing it twice this year replaces one.
   */
  async recordMirror(entry: OccasionMirrorRecord): Promise<OccasionMirrorRecord> {
    const snapshot = await this.state();
    const kept = snapshot.mirrors.filter(
      (existing) => !(existing.occasionId === entry.occasionId && existing.occurrence === entry.occurrence),
    );
    kept.push(entry);
    if (kept.length > MAX_MIRRORS) kept.splice(0, kept.length - MAX_MIRRORS);
    snapshot.mirrors = kept;
    await this.persist(snapshot);
    return entry;
  }

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

  /**
   * Drop every record belonging to one occasion.
   *
   * Called when he removes an occasion. People divorce and people die; removing
   * an occasion takes one sentence and one confirm, and it must not leave last
   * year's "no" and a gift history for a person who is no longer in his life
   * sitting in a file he cannot see.
   */
  async dropOccasion(occasionId: string): Promise<number> {
    const snapshot = await this.state();
    const before = snapshot.acknowledgements.length + snapshot.gifts.length
      + snapshot.openItems.length + snapshot.interviews.length + snapshot.mirrors.length;
    snapshot.acknowledgements = snapshot.acknowledgements.filter((e) => e.occasionId !== occasionId);
    snapshot.gifts = snapshot.gifts.filter((e) => e.occasionId !== occasionId);
    snapshot.openItems = snapshot.openItems.filter((e) => e.occasionId !== occasionId);
    snapshot.interviews = snapshot.interviews.filter((e) => e.occasionId !== occasionId);
    snapshot.mirrors = snapshot.mirrors.filter((e) => e.occasionId !== occasionId);
    const after = snapshot.acknowledgements.length + snapshot.gifts.length
      + snapshot.openItems.length + snapshot.interviews.length + snapshot.mirrors.length;
    if (after !== before) await this.persist(snapshot);
    return before - after;
  }

  /**
   * The periodic reap.
   *
   * Four rules, each with an owner-visible consequence:
   *
   *  - An answer whose occurrence has passed is dropped, so next year asks
   *    fresh and carries no memory of the refusal. A one-off answer has no
   *    expiry and stays: "handled" is permanent for something that happens once.
   *  - State for an occasion no longer declared is orphaned and dropped. This is
   *    the safety net behind the explicit removal path, for the case where he
   *    deleted the line in his editor rather than through a verb.
   *  - An open item whose occurrence has passed stops being raised. Nothing
   *    unresolved is ever dropped WHILE IT CAN STILL MATTER; a birthday that
   *    was three weeks ago cannot.
   *  - Gift history ages out at the configured retention rather than never,
   *    because a persisted store with no reaper is unbounded by design.
   */
  async sweep(input: OccasionSweepInput): Promise<OccasionSweepReport> {
    const snapshot = await this.state();
    const declared = input.declaredOccasionIds;
    const giftCutoff = addDays(input.today, -Math.max(1, Math.round(input.giftHistoryYears * 365)));

    let expiredAcknowledgements = 0;
    let orphanedRecords = 0;
    let expiredOpenItems = 0;
    let agedGiftRecords = 0;
    let droppedInterviews = 0;
    let staleMirrors = 0;

    snapshot.acknowledgements = snapshot.acknowledgements.filter((entry) => {
      if (!declared.has(entry.occasionId)) { orphanedRecords += 1; return false; }
      if (entry.expiresAfter !== undefined && entry.expiresAfter < input.today) {
        expiredAcknowledgements += 1;
        return false;
      }
      return true;
    });

    snapshot.gifts = snapshot.gifts.filter((entry) => {
      if (!declared.has(entry.occasionId)) { orphanedRecords += 1; return false; }
      if (entry.occurrence < giftCutoff) { agedGiftRecords += 1; return false; }
      return true;
    });

    snapshot.openItems = snapshot.openItems.filter((entry) => {
      if (!declared.has(entry.occasionId)) { orphanedRecords += 1; return false; }
      const expiry = entry.expiresAfter ?? (entry.occurrence.length > 0 ? entry.occurrence : undefined);
      if (expiry !== undefined && expiry < input.today) { expiredOpenItems += 1; return false; }
      return true;
    });

    snapshot.interviews = snapshot.interviews.filter((entry) => {
      if (!declared.has(entry.occasionId)) { droppedInterviews += 1; return false; }
      if (entry.occurrence < input.today && entry.completedAt === undefined) {
        droppedInterviews += 1;
        return false;
      }
      return true;
    });

    snapshot.mirrors = snapshot.mirrors.filter((entry) => {
      if (!declared.has(entry.occasionId)) { staleMirrors += 1; return false; }
      // A mirror for an occurrence that has passed has nothing left to keep
      // idempotent. Dropping it is not a deletion in the calendar: the mirror
      // is not the record, and the calendar entry is the calendar's to keep.
      if (entry.occurrence < input.today) { staleMirrors += 1; return false; }
      return true;
    });

    const report: OccasionSweepReport = {
      sweptAt: input.now,
      expiredAcknowledgements,
      orphanedRecords,
      expiredOpenItems,
      agedGiftRecords,
      droppedInterviews,
      staleMirrors,
    };
    snapshot.lastSweep = report;
    await this.persist(snapshot);
    return report;
  }

  /** What this store is holding, and what the last sweep removed. */
  async disclose(): Promise<OccasionStateDisclosure> {
    const snapshot = await this.state();
    return {
      path: this.filePath,
      acknowledgements: snapshot.acknowledgements.length,
      giftRecords: snapshot.gifts.length,
      openItems: snapshot.openItems.length,
      interviews: snapshot.interviews.length,
      mirrors: snapshot.mirrors.length,
      lastSweep: snapshot.lastSweep,
      reconciledOpenItems: this.reconciledOpenItems,
      corruption: this.corruption,
    };
  }

  /** Settles when every queued write has finished. Test and shutdown seam. */
  async drain(): Promise<void> {
    await this.writes.drain();
  }
}
