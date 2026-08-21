/**
 * record-store.ts, the durable inbound-mail record store (docs/inbound-email.md §9.3).
 *
 * Every arriving message the watcher looks at is recorded here, structured
 * fields (sender, subject, delivery evidence, link verdicts, outcome, notice
 * status, receivedAt) plus a bounded body excerpt, so the owner can later ask
 * "why did I get that message" and so `email.inbound.status` has something to
 * disclose. This is NOT the turn-scoped untrusted-content ledger
 * (`platform/security/untrusted-content.ts`): recording here happens at
 * arrival, has no watermark, and never feeds `evaluateOutwardEffect`. See
 * docs/inbound-email.md §5.1, arrival is not ingest.
 *
 * Follows the same five-rule shape as `platform/devices/device-grants.ts`:
 *  1. Reap on recovery, records past their retention window, or past the
 *     count cap, are dropped at load.
 *  2. Bound everything, BOTH `retentionDays` (age) and `maxRecords` (count)
 *     apply; whichever binds first wins. The body excerpt itself is capped at
 *     `MAX_BODY_EXCERPT_CHARS` so a single message cannot make the store an
 *     unbounded copy of the mailbox.
 *  3. Validate by content, every field is re-validated on load; a record
 *     failing any check is discarded, not repaired.
 *  4. Reap periodically, `sweep()` is safe to call on a timer, not only at boot.
 *  5. Disclose what was reaped, every sweep returns an itemised report.
 */
import { randomUUID } from 'node:crypto';
import { PersistentStore, type PersistentStoreCorruption } from '../../state/persistent-store.js';
import { redactCardShapes } from '../../security/card-shapes.js';
import {
  clampDeliveryAddress,
  clampLinkVerdicts,
  clampRecordScope,
  MAX_NOTICE_FAILURE_REASON_CHARS,
  MAX_SENDER_DISPLAY_CHARS,
  MAX_SUBJECT_CHARS,
  validateInboundMailRecord,
} from './record-validation.js';
import { withInboundStoreWriteLock } from './store-write-lock.js';
import {
  MAX_BODY_EXCERPT_CHARS,
  type HousekeepingTrigger,
} from './types.js';
// Type-only, and erased at build time: this file names the refusal vocabulary
// rather than owning it, which is the point (§7.3).
import type { SurfaceNoticeRefusal } from '../../daemon/types.js';

// The validator, its field bounds and its write-time clamps live in
// record-validation.ts and are re-exported here so this module stays the one
// entry point every caller already imports.
export {
  clampDeliveryAddress,
  clampLinkVerdicts,
  clampRecordScope,
  INBOUND_MAIL_OUTCOMES,
  INBOUND_NOTICE_STATUSES,
  MAX_ACCOUNT_CHARS,
  MAX_DELIVERED_TO_CHARS,
  MAX_MAILBOX_CHARS,
  MAX_LINK_REASON_CHARS,
  MAX_LINK_VERDICTS,
  MAX_NOTICE_FAILURE_REASON_CHARS,
  MAX_SENDER_DISPLAY_CHARS,
  MAX_SUBJECT_CHARS,
  validateInboundMailRecord,
} from './record-validation.js';

/** Correlates to `VerificationMatch['kind']` in verification-expectations.ts, plus link-only outcomes that never reach expectation matching. */
export type InboundMailOutcome =
  | 'matched-expectation'
  | 'no-expectation'
  | 'recipient-mismatch'
  | 'expired-expectation'
  | 'ambiguous'
  | 'no-delivery-evidence';

/**
 * `delivered` / `suppressed` / `pending`, the three outcomes that never come
 * back from the transport, plus every reason `deliverSurfaceNotice` refuses
 * with, PROJECTED off `SurfaceNoticeRefusal` rather than restated (§7.3).
 *
 * It was restated, and it had already drifted: the hand-written list omitted
 * `empty-text` and `unsupported-delivery-surface`, both of which
 * `deliverSurfaceNotice` really does return. A notice refused for either of
 * them could not be recorded, `validateInboundMailRecord` would reject the
 * record on load and drop it, so the one case the owner most needs to see
 * ("mail arrived and could not be announced") was the case that vanished.
 * A projection cannot drift, because there is nothing to keep in sync.
 *
 * `pending` is the state a record is written in BEFORE the notice is attempted,
 * and it is what makes the ordering in `intake.ts` possible: the record is the
 * thing that can fail, so it goes first, and the notice, the one step nothing
 * can undo, goes after it. A record sitting at `pending` means exactly what it
 * says: the message was recorded and the notice for it has not resolved. It is
 * reached in two real situations, the transport is refusing with
 * `delivery-failed` and the message is being retried, or the daemon died
 * between the record and the send, and in both of them `pending` is the true
 * answer where `suppressed` or `delivered` would be a guess.
 */
export type InboundNoticeStatus = 'delivered' | 'suppressed' | 'pending' | SurfaceNoticeRefusal;

/** A link's registrable domain plus verdict only, never the raw URL the message assembled (§7). */
export interface InboundLinkVerdict {
  readonly registrableDomain: string;
  readonly verdict: 'allowed' | 'refused' | 'unresolved';
  /** Bounded at `MAX_LINK_REASON_CHARS`, sixty-four unbounded strings is an unbounded record. */
  readonly reason?: string | undefined;
}

/** Structured fields for one inbound message, plus a bounded body excerpt. */
/** Everything a record carries regardless of which source found the message. */
export interface InboundMailRecordCommon {
  readonly id: string;
  readonly account: string;
  readonly mailbox: string;
  /** Attacker-written `From:` text. Card shapes redacted and length-bounded at write time (§11.0). */
  readonly senderDisplay: string;
  /** Sanitized/truncated (§7): newlines and control characters removed before this is ever stored. Card shapes redacted (§11.0). */
  readonly subject: string;
  /** The alias the message landed at. Sender-chosen on a catch-all domain, so card shapes are redacted here too (§11.0). */
  readonly deliveredToAddress: string | null;
  readonly deliveryEvidenceSource: 'alias-mailbox' | 'delivered-to-header' | 'x-original-to-header' | 'none';
  readonly links: readonly InboundLinkVerdict[];
  readonly outcome: InboundMailOutcome;
  readonly noticeStatus: InboundNoticeStatus;
  readonly noticeFailureReason?: string | undefined;
  /** Bounded to MAX_BODY_EXCERPT_CHARS. Never rendered to the owner (§7), retained for the owner's own later inspection / debugging only. */
  readonly bodyExcerpt: string;
  readonly receivedAt: string;
}

/** A record of a message an IMAP source found. */
export interface ImapInboundMailRecord extends InboundMailRecordCommon {
  readonly source: 'imap';
  readonly uidValidity: number;
  readonly uid: number;
}

/** A record of a message a Gmail source found. */
export interface GmailInboundMailRecord extends InboundMailRecordCommon {
  readonly source: 'gmail';
  /** Gmail's opaque message resource id. Not a number, never coerced to one. */
  readonly resourceId: string;
  /**
   * The delta's high-water mark, a decimal uint64 STRING.
   *
   * Never parsed to a number. `18446744073709551615` does not survive a
   * round trip through a JS double, and a position that silently shifts is a
   * position that re-reads or skips history. `source-cursor.ts` already made
   * that impossible for the cursor; this is the same value in the same
   * shape, validated by the same predicate rather than a second copy of it.
   */
  readonly historyId: string;
}

/**
 * One stored record, discriminated on the source that found the message.
 *
 * A union rather than a widened record with optional `uid` / `historyId`, and
 * the reason is the defect this replaced: `validateInboundMailRecord` required
 * a positive `uidValidity` and `uid` unconditionally, so EVERY Gmail message
 * failed validation and was dropped, on the path automatic selection makes
 * the default once Google is adopted. Mail arrived, matched, was announced,
 * and nothing was ever written. §9.3's retention had nothing to retain,
 * §11.0's card redaction had nothing to redact, and `email.inbound.status`
 * truthfully reported zero records, which reads as "no mail" rather than
 * "cannot store mail".
 *
 * Same discriminant and same rule as `InboundSourceCursor`.
 */
export type InboundMailRecord = ImapInboundMailRecord | GmailInboundMailRecord;

/**
 * A record's identity as one readable string, for disclosure only.
 *
 * `imap:<uidValidity>:<uid>` / `gmail:<resourceId>`. Never a key and never
 * parsed back apart, a sweep report exists to tell the owner WHICH message
 * went, and a report that carried `uid: 0` for every Gmail record (which is
 * what an IMAP-shaped field would have to do) tells him nothing while looking
 * like it told him something.
 */
export function describeRecordIdentity(record: InboundMailRecord): string {
  return record.source === 'gmail'
    ? `gmail:${record.resourceId}`
    : `imap:${String(record.uidValidity)}:${String(record.uid)}`;
}

/**
 * `Pick` distributed across the union, for the same reason `DistributiveOmit`
 * exists below: a plain `Pick` over a union collapses to the SHARED keys, so
 * `uid`, `uidValidity` and `resourceId` would all vanish and the resulting
 * "key" would identify nothing.
 */
type DistributivePick<T, K extends PropertyKey> = T extends unknown
  ? Pick<T, Extract<K, keyof T>>
  : never;

/**
 * One message's natural key: the mailbox it landed in, plus the identity the
 * receiving server assigned it.
 *
 * Projected off `InboundMailRecord` rather than restated, so it cannot describe
 * a field the record does not have. This is the key `record()` upserts on and
 * `findByMessage()` looks up, deliberately NOT the record `id`, which is a
 * fresh UUID per write and therefore identifies a WRITE rather than a MESSAGE.
 *
 * Never the `Message-ID` header, for the reason `sink.ts` states at length: the
 * sender writes it, so two different messages can carry the same one, and a key
 * a sender can choose is a key a sender can collide with.
 */
export type InboundMailMessageKey = DistributivePick<
  InboundMailRecord,
  'source' | 'account' | 'mailbox' | 'uidValidity' | 'uid' | 'resourceId'
>;

/** Whether a stored record is a record OF the message this key names. */
function isSameMessage(record: InboundMailRecord, key: InboundMailMessageKey): boolean {
  if (record.account !== key.account || record.mailbox !== key.mailbox) return false;
  if (record.source === 'gmail') {
    return key.source === 'gmail' && record.resourceId === key.resourceId;
  }
  return key.source === 'imap'
    && record.uidValidity === key.uidValidity
    && record.uid === key.uid;
}

/** `file-unreadable` is the whole-file counterpart of `malformed`, see `CursorDiscardReason`. */
export type InboundMailDiscardReason = 'malformed' | 'file-unreadable' | 'expired' | 'over-cap';


export interface InboundMailDiscard {
  readonly id: string;
  readonly account: string;
  readonly mailbox: string;
  /** See `describeRecordIdentity`. Disclosure, not a key. */
  readonly messageRef: string;
  readonly reason: InboundMailDiscardReason;
  readonly removedAt: number;
  /** Present where the removal needs a sentence rather than a reason word. */
  readonly note?: string | undefined;
}

export interface InboundMailRecordSweepReport {
  readonly sweptAt: number;
  readonly removed: readonly InboundMailDiscard[];
  readonly retained: number;
}

export interface InboundMailRecordPolicy {
  /** Age bound. Records older than this are reaped regardless of count. */
  readonly retentionMs: number;
  /** Count bound. Oldest-by-receivedAt records past this are reaped regardless of age. */
  readonly maxRecords: number;
  /** Body excerpt cap. Clamped at construction to never exceed MAX_BODY_EXCERPT_CHARS. */
  readonly maxBodyExcerptChars: number;
}

/**
 * What write-time bounding has removed since this process started.
 *
 * §9 rule 5 is "disclose what was reaped", and applying the bounds on write
 * would otherwise delete records with nothing anywhere saying so, the sweep
 * report itemises what IT removed, and a record the write already dropped is a
 * record the sweep never sees. This is the counterpart disclosure.
 *
 * Deliberately in-memory and deliberately labelled `since`: it counts this
 * daemon's own writes, and a restart resets it. Persisting it would make the
 * tally a second store needing its own reaping and bounding, which is the
 * defect two lines up in this same file's history (see housekeeping.ts). A
 * count that says what window it covers is honest; a count that implies "ever"
 * would not be.
 */
export interface InboundMailWriteReapTally {
  /** Records a write dropped for being past `retentionMs`. */
  readonly expired: number;
  /** Records a write dropped for being past `maxRecords`. */
  readonly overCap: number;
  /** When this tally started counting, this store's construction. */
  readonly since: number;
}

export const DEFAULT_INBOUND_MAIL_RECORD_POLICY: InboundMailRecordPolicy = {
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  maxRecords: 5000,
  maxBodyExcerptChars: MAX_BODY_EXCERPT_CHARS,
};

interface InboundMailSnapshot extends Record<string, unknown> {
  readonly version: 1;
  readonly records: readonly InboundMailRecord[];
}


export interface InboundMailStoreOptions {
  readonly policy?: Partial<InboundMailRecordPolicy> | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * `Omit` distributed across the union.
 *
 * A plain `Omit<InboundMailRecord, …>` on a union collapses to the keys the
 * variants SHARE, which would silently drop `uid`, `resourceId` and
 * `historyId` from the input type, every caller would then compile while
 * passing an identity the store cannot use. Distributing keeps each arm whole.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type InboundMailRecordInput =
  DistributiveOmit<InboundMailRecord, 'id' | 'bodyExcerpt'> & { readonly body: string };

/**
 * Durable inbound-mail record store, named to match `InboundMailContext`
 * (docs/inbound-email.md §2.1), which carries it as `records`.
 */
export class InboundMailStore {
  private readonly store: PersistentStore<InboundMailSnapshot>;
  private readonly policy: InboundMailRecordPolicy;
  private readonly now: () => number;
  private writeChain: Promise<void> = Promise.resolve();
  /** The last unreadable-file event, latched so status can name it. */
  private corruption: PersistentStoreCorruption | null = null;
  private writeReapedExpired = 0;
  private writeReapedOverCap = 0;
  private readonly tallySince: number;

  constructor(storeOrPath: PersistentStore<InboundMailSnapshot> | string, options: InboundMailStoreOptions = {}) {
    this.store = typeof storeOrPath === 'string' ? new PersistentStore<InboundMailSnapshot>(storeOrPath) : storeOrPath;
    const merged = { ...DEFAULT_INBOUND_MAIL_RECORD_POLICY, ...(options.policy ?? {}) };
    this.policy = { ...merged, maxBodyExcerptChars: Math.min(merged.maxBodyExcerptChars, MAX_BODY_EXCERPT_CHARS) };
    this.now = options.now ?? (() => Date.now());
    this.tallySince = this.now();
  }

  getPolicy(): InboundMailRecordPolicy {
    return this.policy;
  }

  /** What write-time bounding has removed since this store was constructed. See `InboundMailWriteReapTally`. */
  getWriteReapTally(): InboundMailWriteReapTally {
    return {
      expired: this.writeReapedExpired,
      overCap: this.writeReapedOverCap,
      since: this.tallySince,
    };
  }

  /** The unreadable-file event this store last saw, or null. See `MailboxCursorStore.getCorruption`. */
  getCorruption(): PersistentStoreCorruption | null {
    return this.corruption;
  }

  private async readWithDrops(): Promise<{
    records: InboundMailRecord[];
    malformed: number;
    corrupt: PersistentStoreCorruption | null;
  }> {
    const { data: raw, corruption } = await this.store.loadOrDiscard();
    if (corruption !== null) this.corruption = corruption;
    if (!raw || typeof raw !== 'object') return { records: [], malformed: 0, corrupt: corruption };
    const rawRecords = Array.isArray(raw.records) ? raw.records : [];
    const records = rawRecords.map(validateInboundMailRecord).filter((r): r is InboundMailRecord => r !== null);
    return { records, malformed: rawRecords.length - records.length, corrupt: null };
  }

  private async mutate<T>(
    fn: (
      records: InboundMailRecord[],
      malformed: number,
      corrupt: PersistentStoreCorruption | null,
    ) => Promise<{ next: InboundMailRecord[]; result: T }>,
  ): Promise<T> {
    // The chain orders writers inside THIS process; the lock orders them
    // across processes. Both, because neither alone is "one writer at a time"
    //, see store-write-lock.ts for why a second daemon is reachable here.
    const run = this.writeChain.then(async () => withInboundStoreWriteLock(this.store.lockPath, async () => {
      const { records, malformed, corrupt } = await this.readWithDrops();
      const { next, result } = await fn(records, malformed, corrupt);
      await this.store.persist({ version: 1, records: next });
      return result;
    }));
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * WHAT THE FILE HOLDS, not what a read is willing to serve.
   *
   * `list()` filters by age and by count, so a caller counting its result was
   * counting a VIEW: with `maxRecords: 2`, ten writes left ten records on disk
   * and `list()` answered 2. `email.inbound.status` computed its
   * `retention.records.kept` that way, so the owner was told his store was
   * bounded while the file grew without limit, a disclosure that reads as
   * reassurance and is not one.
   *
   * `stored` counts EVERY entry in the file, malformed ones included: they
   * occupy the file, so a count that skipped them would be the same class of
   * comfortable answer. `live` is what a read serves. Both are returned
   * because the GAP between them is itself the fact worth disclosing,
   * records past their window that no write or sweep has reached yet.
   */
  async count(): Promise<{ readonly stored: number; readonly live: number }> {
    const cutoff = this.now() - this.policy.retentionMs;
    const { records, malformed } = await this.readWithDrops();
    const live = records.filter((r) => Date.parse(r.receivedAt) >= cutoff);
    return { stored: records.length + malformed, live: Math.min(live.length, this.policy.maxRecords) };
  }

  /**
   * Apply BOTH policy bounds to the set about to be written.
   *
   * This is the fix for the finding this store existed for six weeks without:
   * `record()` wrote `[...records, entry]` and nothing else, so the bounds
   * lived only in `sweep()`, and `facade-inbound-mail.ts` runs the sweep every
   * SIX HOURS. Between two sweeps the file was unbounded in both axes, and
   * every read hid it.
   *
   * Age first, then count, so the reason a record went is the bound that
   * actually bound first, the same order and the same precedence `sweep()`
   * uses, because two orders would mean two answers to "why is this gone".
   */
  private applyBounds(
    records: readonly InboundMailRecord[],
    now: number,
  ): { kept: InboundMailRecord[]; expired: number; overCap: number } {
    const cutoff = now - this.policy.retentionMs;
    const withinAge = records.filter((r) => Date.parse(r.receivedAt) >= cutoff);
    const expired = records.length - withinAge.length;
    if (withinAge.length <= this.policy.maxRecords) {
      return { kept: withinAge, expired, overCap: 0 };
    }
    // Oldest-first, drop from the front: the same "oldest by receivedAt goes
    // first" rule `sweep()` applies.
    const oldestFirst = [...withinAge].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
    const overCap = oldestFirst.length - this.policy.maxRecords;
    return { kept: oldestFirst.slice(overCap), expired, overCap };
  }

  /**
   * Live, content-validated records, newest first. Read-time filter for age
   * and count (does not persist the drop, `sweep()` does that), so a read
   * between sweeps never serves a record past either bound.
   */
  async list(input?: { readonly account?: string | undefined; readonly limit?: number | undefined }): Promise<readonly InboundMailRecord[]> {
    const now = this.now();
    const cutoff = now - this.policy.retentionMs;
    const { records } = await this.readWithDrops();
    const live = records
      .filter((r) => Date.parse(r.receivedAt) >= cutoff)
      .filter((r) => !input?.account || r.account === input.account)
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    const bounded = live.slice(0, this.policy.maxRecords);
    return input?.limit ? bounded.slice(0, input.limit) : bounded;
  }

  async get(id: string): Promise<InboundMailRecord | null> {
    const { records } = await this.readWithDrops();
    return records.find((r) => r.id === id) ?? null;
  }

  /**
   * The record of ONE message, by the identity the receiving server assigned.
   *
   * This is the store's answer to "have I already dealt with this message, and
   * what happened to it", a question the in-memory dedup cache cannot answer
   * across a restart, because it is a `Map` in a process that just died. The
   * intake asks it before announcing, so a message redelivered because the
   * cursor had not advanced when the daemon restarted is not announced to the
   * owner a second time (§6).
   *
   * Bounded by the same age filter `list()` applies: a record past the
   * retention window is not a live fact about this message, and answering with
   * one would let a 30-day-old row suppress a notice.
   *
   * Note the consequence of write-time bounding, stated rather than left to be
   * discovered: a record written already past `retentionMs` is bounded out by
   * the same write that made it, so this answers `null` for it. That is the
   * policy working, a record too old to keep is too old to have kept, not an
   * inconsistency between two methods.
   */
  async findByMessage(key: InboundMailMessageKey): Promise<InboundMailRecord | null> {
    const cutoff = this.now() - this.policy.retentionMs;
    const { records } = await this.readWithDrops();
    // Same clamp the write applied, so a long account is one string on both
    // sides of the comparison rather than two.
    const scoped = { ...key, ...clampRecordScope(key) };
    return records.find(
      (record) => isSameMessage(record, scoped) && Date.parse(record.receivedAt) >= cutoff,
    ) ?? null;
  }

  /**
   * Record one inbound message. The body excerpt is redacted of card shapes and
   * then truncated to the policy cap at write time.
   *
   * Redaction happens BEFORE the truncation, over the WHOLE body rather than
   * a window. Truncating first and redacting the result would leave a card
   * number straddling the cap as a still-readable prefix of up to eighteen
   * digits, a shorter leak, not a redaction. A window sized to one span is
   * not enough either, because redaction shortens and several of them slide
   * later text back inside the cap; see the note at the call site.
   *
   * ONE MESSAGE, ONE RECORD. A write whose message key already exists replaces
   * that row in place and keeps its `id`; it does not append a second row. That
   * is not tidiness, it is what makes the intake's ordering safe to retry: the
   * record now goes in BEFORE the notice, in a `pending` state, and every
   * retried pass, a `delivery-failed` transport, a daemon restarted mid-pass,
   * writes the same message again. Appending would turn each retry into another
   * row, and `email.inbound.status` would report five arrivals for one message
   * while the owner's phone had buzzed once. The `id` is kept so a reference
   * taken from an earlier read still resolves through `get()`.
   */
  async record(input: InboundMailRecordInput): Promise<InboundMailRecord> {
    // The identity travels as a unit, chosen by the input's own source, so a
    // new source cannot be half-copied into a record.
    const identity = input.source === 'gmail'
      ? { source: 'gmail' as const, resourceId: input.resourceId, historyId: input.historyId }
      : { source: 'imap' as const, uidValidity: input.uidValidity, uid: input.uid };
    const entry: InboundMailRecord = {
      ...identity,
      id: randomUUID(),
      // Clamped, like every other persisted string. These two were bounded on
      // the load path and nowhere on the write path, so an oversized one was
      // written in full and then discarded whole on the next load, see
      // `clampRecordScope`, which `findByMessage` applies to its key for the
      // same reason.
      ...clampRecordScope(input),
      // `From:`'s display name is written by whoever sent the message, the
      // same standing the subject has, and the same handling. It was left raw
      // while the subject beside it was redacted, so `"4111111111111111"
      // <a@b.test>` put a card number on disk for `retentionDays` and into the
      // owner's notice, through a field nobody thought of as content.
      senderDisplay: redactCardShapes(input.senderDisplay).slice(0, MAX_SENDER_DISPLAY_CHARS),
      // The subject is persisted alongside the excerpt AND rendered to the
      // owner in the notice, so it is the same exposure by a different field.
      // Re-clamped after redacting because a marker is longer than the digits
      // it replaces, and a subject over 998 chars fails validation on load,
      // taking the whole record with it.
      subject: redactCardShapes(input.subject).slice(0, MAX_SUBJECT_CHARS),
      // Sender-chosen too, on the catch-all domain the aliases live on (§7.1):
      // the local part is whatever the message was addressed to, so a PAN can
      // arrive as the alias itself. Clamped by `clampDeliveryAddress` rather
      // than a plain slice, see there for why this one field cannot use the
      // subject's re-clamp.
      deliveredToAddress: input.deliveredToAddress === null
        ? null
        : clampDeliveryAddress(redactCardShapes(input.deliveredToAddress)),
      deliveryEvidenceSource: input.deliveryEvidenceSource,
      // Clamped, not trusted: `reason` is bounded per entry and the array is
      // bounded by count, because sixty-four unbounded strings is an unbounded
      // record. Clamping at write rather than rejecting at load is the same
      // choice the subject and the delivery address make, an oversized field
      // must not take the whole message down with it on the next load.
      links: clampLinkVerdicts(input.links),
      outcome: input.outcome,
      noticeStatus: input.noticeStatus,
      // The one field on this record whose text a REMOTE SERVER wrote:
      // `intake.ts` fills it from `delivery.error`, the notice transport's own
      // refusal body. Bounded here so a chatty push service cannot make one
      // record arbitrarily large inside a store that believes `maxRecords`
      // bounds it.
      ...(input.noticeFailureReason
        ? { noticeFailureReason: input.noticeFailureReason.slice(0, MAX_NOTICE_FAILURE_REASON_CHARS) }
        : {}),
      // SCAN, THEN TRUNCATE, and scan everything that could reach the
      // excerpt, not a window sized to one span.
      //
      // This used to scan `cap + MAX_CARD_SPAN_CHARS` and slice to `cap`, on
      // the reasoning that the overshoot means a span starting just inside the
      // cap is always seen whole. That reasoning is sound for ONE span and
      // wrong for several, because redaction SHORTENS: `[redacted:pan]` is
      // fourteen characters against a nineteen-digit grouped PAN's
      // thirty-seven, so every redaction pulls everything after it leftwards.
      // Enough of them and a span that sat beyond the window, seen only in
      // part, so not matched, so left raw, slides back inside the final
      // `slice(0, cap)` and is persisted verbatim. Fifteen digits of a
      // sixteen-digit number, with the sixteenth recoverable by check digit.
      //
      // REACHABLE TODAY, on the Gmail path. `intake.ts` passes `''` for the
      // IMAP envelope pass, which fetches no body, and the real body for a
      // Gmail history delta, so this runs on the source automatic selection
      // prefers once Google is adopted, which is the owner's own path.
      // `inbound-mail-intake.test.ts` drives a card number through it. The
      // body-fetch round extends this to IMAP; it does not switch it on.
      //
      // This comment previously read "not reachable today: intake.ts passes
      // body: ''". That was true when the window fix was written and false by
      // the time it merged, because the Gmail body arm landed in between. It is
      // recorded rather than quietly corrected because it is the fault class
      // this file already carries a note about: a comment asserting a property
      // the code does not have, which is precisely what stops the next reader
      // checking, and this one would also have read as licence to relax the
      // double pass on the grounds that nothing exercises it.
      //
      // The rule that generalises, because this arrived from a MERGE
      // RESOLUTION rather than from authorship: a reachability claim is a
      // claim about the whole tree, and the tree moves under it. The sentence
      // was accurate against the tree it was written for and false against the
      // tree it landed in, and nothing about the line itself changed. So a
      // reachability claim is something to VERIFY, never to inherit, kept
      // wording carries the same obligation as kept code.
      //
      // Verified rather than asserted this time: the multi-span slide below now
      // has a test. `inbound-mail-card-redaction.test.ts` builds a body whose
      // second card straddles the removed window and, measured against the
      // windowed implementation, put ELEVEN readable digits on disk. Restore
      // the window and that test, and only that test, reddens.
      //
      // The fix is to remove the window, not to widen it. The body is already
      // bounded upstream by the fetch's own byte cap, and `MAX_BODY_EXCERPT_CHARS`
      // bounds what is kept, so scanning the whole of what we were handed costs
      // nothing measurable and leaves no boundary to reason about. The second
      // pass over the truncated result is belt and braces: after this, the
      // stored string provably contains no detectable card shape, whatever the
      // first pass did to the offsets.
      bodyExcerpt: redactCardShapes(
        redactCardShapes(input.body).slice(0, this.policy.maxBodyExcerptChars),
      ),
      receivedAt: input.receivedAt,
    };
    return this.mutate(async (records) => {
      // Matched on the CLAMPED scope, the same one `entry` was built with:
      // comparing a stored (clamped) account against an unclamped input is how
      // a retry stops recognising its own earlier row.
      const key = { ...input, ...clampRecordScope(input) };
      const index = records.findIndex((existing) => isSameMessage(existing, key));
      const appended = index < 0 ? [...records, entry] : records.map((existing, at) => (
        at === index ? { ...entry, id: existing.id } : existing
      ));
      const result = index < 0 ? entry : appended[index]!;
      // BOUNDS ON THE WRITE, not only on the sweep. `record()` used to write
      // `[...records, entry]` and nothing more, so between two six-hourly
      // sweeps the file was bounded by neither `maxRecords` nor `retentionMs`.
      // Applying them here is what makes the file itself bounded; the sweep
      // stays because it also itemises, reaps malformed rows, and reaches
      // records this process never wrote.
      const { kept, expired, overCap } = this.applyBounds(appended, this.now());
      this.writeReapedExpired += expired;
      this.writeReapedOverCap += overCap;
      return { next: kept, result };
    });
  }

  /**
   * One housekeeping pass: drop malformed records, drop records past the age
   * bound, and enforce the count bound (oldest by `receivedAt` first).
   * Whichever bound removes a record first is the reason recorded.
   */
  async sweep(trigger: HousekeepingTrigger = 'manual'): Promise<InboundMailRecordSweepReport> {
    const now = this.now();
    const cutoff = now - this.policy.retentionMs;
    return this.mutate(async (records, malformed, corrupt) => {
      const removed: InboundMailDiscard[] = [];
      if (corrupt !== null) {
        removed.push({
          id: '(unreadable)',
          account: '(unknown)',
          mailbox: '(unknown)',
          messageRef: '(unreadable)',
          reason: 'file-unreadable',
          removedAt: now,
          note: `the inbound record file could not be read (${corrupt.detail}), so its `
            + 'contents were discarded',
        });
      }
      if (malformed > 0) {
        removed.push({ id: '(unreadable)', account: '(unknown)', mailbox: '(unknown)', messageRef: '(unreadable)', reason: 'malformed', removedAt: now });
      }

      const withinAge: InboundMailRecord[] = [];
      for (const record of records) {
        if (Date.parse(record.receivedAt) < cutoff) {
          removed.push({ id: record.id, account: record.account, mailbox: record.mailbox, messageRef: describeRecordIdentity(record), reason: 'expired', removedAt: now });
          continue;
        }
        withinAge.push(record);
      }

      const sorted = [...withinAge].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
      const overflow = sorted.length - this.policy.maxRecords;
      const final: InboundMailRecord[] = [];
      for (let index = 0; index < sorted.length; index += 1) {
        const record = sorted[index];
        if (!record) continue;
        if (index < overflow) {
          removed.push({ id: record.id, account: record.account, mailbox: record.mailbox, messageRef: describeRecordIdentity(record), reason: 'over-cap', removedAt: now });
          continue;
        }
        final.push(record);
      }

      return { next: final, result: { sweptAt: now, removed, retained: final.length } satisfies InboundMailRecordSweepReport };
    });
  }

  async runRecoverySweep(): Promise<InboundMailRecordSweepReport> {
    return this.sweep('recovery');
  }
}
