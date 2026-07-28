/**
 * record-store.ts — the durable inbound-mail record store (docs/inbound-email.md §9.3).
 *
 * Every arriving message the watcher looks at is recorded here — structured
 * fields (sender, subject, delivery evidence, link verdicts, outcome, notice
 * status, receivedAt) plus a bounded body excerpt — so the owner can later ask
 * "why did I get that message" and so `email.inbound.status` has something to
 * disclose. This is NOT the turn-scoped untrusted-content ledger
 * (`platform/security/untrusted-content.ts`): recording here happens at
 * arrival, has no watermark, and never feeds `evaluateOutwardEffect`. See
 * docs/inbound-email.md §5.1 — arrival is not ingest.
 *
 * Follows the same five-rule shape as `platform/devices/device-grants.ts`:
 *  1. Reap on recovery — records past their retention window, or past the
 *     count cap, are dropped at load.
 *  2. Bound everything — BOTH `retentionDays` (age) and `maxRecords` (count)
 *     apply; whichever binds first wins. The body excerpt itself is capped at
 *     `MAX_BODY_EXCERPT_CHARS` so a single message cannot make the store an
 *     unbounded copy of the mailbox.
 *  3. Validate by content — every field is re-validated on load; a record
 *     failing any check is discarded, not repaired.
 *  4. Reap periodically — `sweep()` is safe to call on a timer, not only at boot.
 *  5. Disclose what was reaped — every sweep returns an itemised report.
 */
import { randomUUID } from 'node:crypto';
import { PersistentStore, type PersistentStoreCorruption } from '../../state/persistent-store.js';
import { redactCardShapes } from '../../security/card-shapes.js';
import { isHistoryId } from './source-cursor.js';
import {
  isNonEmptyTrimmedString,
  isNonNegativeInteger,
  isParsableIsoDate,
  isPositiveInteger,
  MAX_BODY_EXCERPT_CHARS,
  type HousekeepingTrigger,
} from './types.js';
// Type-only, and erased at build time: this file names the refusal vocabulary
// rather than owning it, which is the point (§7.3).
import type { SurfaceNoticeRefusal } from '../../daemon/types.js';

/**
 * Longest a single card-shaped span can be in written form: nineteen digits
 * with a separator between every pair. The redaction window overshoots the
 * excerpt cap by this much so a span starting just inside the cap is always
 * seen whole rather than half-detected.
 */
const MAX_CARD_SPAN_CHARS = 19 + 18;

/** What `validateInboundMailRecord` accepts for `subject`; redaction must not exceed it. */
const MAX_SUBJECT_CHARS = 998;

/** What `validateInboundMailRecord` accepts for `senderDisplay`; same rule as the subject. */
const MAX_SENDER_DISPLAY_CHARS = 998;

/** What `validateInboundMailRecord` accepts for `deliveredToAddress`. */
const MAX_DELIVERED_TO_CHARS = 320;

/**
 * Clamp a redacted delivery address back inside its bound WITHOUT losing the
 * `@` the loader insists on.
 *
 * The plain `.slice(0, max)` the subject uses is wrong for this one field.
 * `validateInboundMailRecord` requires a `deliveredToAddress` to contain an
 * `@`, and a redaction marker is longer than the digits it replaces
 * (`[redacted:security-code]` is twenty-four characters for three), so a long
 * address carrying card shapes in its local part can grow past the bound and a
 * head-slice would cut the `@` off. The record would then fail its own
 * validation on the very next load and be discarded WHOLE — the mail would
 * vanish from the store entirely, which is a worse outcome than the exposure
 * this redaction exists to close.
 *
 * So the domain is kept intact and the local part gives up the characters. The
 * part that is truncated is the part that had already been overwritten with
 * markers, and the part that identifies where the message landed survives.
 */
function clampDeliveryAddress(value: string): string {
  if (value.length <= MAX_DELIVERED_TO_CHARS) return value;
  const at = value.indexOf('@');
  if (at < 0) return value.slice(0, MAX_DELIVERED_TO_CHARS);
  const domain = value.slice(at);
  return domain.length >= MAX_DELIVERED_TO_CHARS
    ? domain.slice(0, MAX_DELIVERED_TO_CHARS)
    : value.slice(0, MAX_DELIVERED_TO_CHARS - domain.length) + domain;
}

/** Correlates to `VerificationMatch['kind']` in verification-expectations.ts, plus link-only outcomes that never reach expectation matching. */
export type InboundMailOutcome =
  | 'matched-expectation'
  | 'no-expectation'
  | 'recipient-mismatch'
  | 'expired-expectation'
  | 'ambiguous'
  | 'no-delivery-evidence';

const INBOUND_MAIL_OUTCOMES: readonly InboundMailOutcome[] = [
  'matched-expectation',
  'no-expectation',
  'recipient-mismatch',
  'expired-expectation',
  'ambiguous',
  'no-delivery-evidence',
];

/**
 * `delivered` / `suppressed` / `pending` — the three outcomes that never come
 * back from the transport — plus every reason `deliverSurfaceNotice` refuses
 * with, PROJECTED off `SurfaceNoticeRefusal` rather than restated (§7.3).
 *
 * It was restated, and it had already drifted: the hand-written list omitted
 * `empty-text` and `unsupported-delivery-surface`, both of which
 * `deliverSurfaceNotice` really does return. A notice refused for either of
 * them could not be recorded — `validateInboundMailRecord` would reject the
 * record on load and drop it — so the one case the owner most needs to see
 * ("mail arrived and could not be announced") was the case that vanished.
 * A projection cannot drift, because there is nothing to keep in sync.
 *
 * `pending` is the state a record is written in BEFORE the notice is attempted,
 * and it is what makes the ordering in `intake.ts` possible: the record is the
 * thing that can fail, so it goes first, and the notice — the one step nothing
 * can undo — goes after it. A record sitting at `pending` means exactly what it
 * says: the message was recorded and the notice for it has not resolved. It is
 * reached in two real situations — the transport is refusing with
 * `delivery-failed` and the message is being retried, or the daemon died
 * between the record and the send — and in both of them `pending` is the true
 * answer where `suppressed` or `delivered` would be a guess.
 */
export type InboundNoticeStatus = 'delivered' | 'suppressed' | 'pending' | SurfaceNoticeRefusal;

/**
 * Every refusal reason, as a map rather than a list.
 *
 * A `Record<SurfaceNoticeRefusal, true>` is exhaustive by the compiler: adding
 * a reason to `SurfaceNoticeRefusal` stops this object compiling, which is the
 * whole reason the validator's accepted set is derived from it instead of
 * being a second literal list beside the type.
 */
const NOTICE_REFUSAL_STATUSES: Readonly<Record<SurfaceNoticeRefusal, true>> = {
  'no-route-binding': true,
  'empty-text': true,
  'unsupported-delivery-surface': true,
  'surface-delivery-disabled': true,
  'no-deliverable-target': true,
  'delivery-failed': true,
};

const INBOUND_NOTICE_STATUSES: readonly InboundNoticeStatus[] = [
  'delivered',
  'suppressed',
  'pending',
  ...(Object.keys(NOTICE_REFUSAL_STATUSES) as readonly SurfaceNoticeRefusal[]),
];

/** A link's registrable domain plus verdict only — never the raw URL the message assembled (§7). */
export interface InboundLinkVerdict {
  readonly registrableDomain: string;
  readonly verdict: 'allowed' | 'refused' | 'unresolved';
  readonly reason?: string | undefined;
}

const LINK_VERDICTS: readonly InboundLinkVerdict['verdict'][] = ['allowed', 'refused', 'unresolved'];

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
  /** Bounded to MAX_BODY_EXCERPT_CHARS. Never rendered to the owner (§7) — retained for the owner's own later inspection / debugging only. */
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
 * failed validation and was dropped — on the path automatic selection makes
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
 * parsed back apart — a sweep report exists to tell the owner WHICH message
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
 * `findByMessage()` looks up — deliberately NOT the record `id`, which is a
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

/** `file-unreadable` is the whole-file counterpart of `malformed` — see `CursorDiscardReason`. */
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

export const DEFAULT_INBOUND_MAIL_RECORD_POLICY: InboundMailRecordPolicy = {
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  maxRecords: 5000,
  maxBodyExcerptChars: MAX_BODY_EXCERPT_CHARS,
};

interface InboundMailSnapshot extends Record<string, unknown> {
  readonly version: 1;
  readonly records: readonly InboundMailRecord[];
}

function isValidLinkVerdict(value: unknown): value is InboundLinkVerdict {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!isNonEmptyTrimmedString(record.registrableDomain, 253)) return false;
  if (typeof record.verdict !== 'string' || !LINK_VERDICTS.includes(record.verdict as InboundLinkVerdict['verdict'])) return false;
  if (record.reason !== undefined && typeof record.reason !== 'string') return false;
  return true;
}

/**
 * Validate a record by its parsed content, not by its presence in the file.
 * Returns `null` for anything torn, oversized, or out of range. Never throws,
 * never repairs — a body excerpt that somehow exceeds the hard cap is a
 * reason to discard the whole record, not to truncate it again on read.
 */
/**
 * The identity half of a record, chosen by the record's OWN `source` field.
 *
 * Returns `null` for a payload that does not match the source it declares —
 * discarded, never coerced. §9's rule is that a torn record is dropped rather
 * than repaired, and coercion here is the specific repair that caused the bug
 * this replaced: reading a Gmail record against IMAP rules and rejecting it.
 *
 * A record with NO `source` is read as IMAP. That is deliberate backward
 * compatibility, not inference: every record written before the union existed
 * is an IMAP record, and treating absence as unknown would discard the whole
 * existing store on first load. Gmail is never inferred from absence — it must
 * say so — which is the same asymmetry `validateGmailCursor` uses and for the
 * same reason.
 */
function validateRecordIdentity(
  record: Record<string, unknown>,
): Pick<ImapInboundMailRecord, 'source' | 'uidValidity' | 'uid'>
  | Pick<GmailInboundMailRecord, 'source' | 'resourceId' | 'historyId'>
  | null {
  const source = record.source;
  if (source === 'gmail') {
    if (!isNonEmptyTrimmedString(record.resourceId, 256)) return null;
    // The same predicate the cursor validates with, imported rather than
    // restated — a second copy of a uint64 rule is a second chance to get it
    // wrong.
    if (!isHistoryId(record.historyId)) return null;
    return {
      source: 'gmail',
      resourceId: (record.resourceId as string).trim(),
      historyId: record.historyId,
    };
  }
  if (source !== undefined && source !== 'imap') return null;
  if (!isPositiveInteger(record.uidValidity)) return null;
  if (!isPositiveInteger(record.uid)) return null;
  return {
    source: 'imap',
    uidValidity: record.uidValidity,
    uid: record.uid,
  };
}

export function validateInboundMailRecord(value: unknown): InboundMailRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (!isNonEmptyTrimmedString(record.id, 128)) return null;
  if (!isNonEmptyTrimmedString(record.account, 256)) return null;
  if (!isNonEmptyTrimmedString(record.mailbox, 512)) return null;
  // Discriminate FIRST. Validating identity fields before knowing which source
  // wrote them is exactly how every Gmail record came to be discarded.
  const identity = validateRecordIdentity(record);
  if (identity === null) return null;
  if (typeof record.senderDisplay !== 'string' || record.senderDisplay.length > 998) return null;
  if (typeof record.subject !== 'string' || record.subject.length > 998) return null;

  const deliveryEvidenceSource = record.deliveryEvidenceSource;
  if (
    deliveryEvidenceSource !== 'alias-mailbox'
    && deliveryEvidenceSource !== 'delivered-to-header'
    && deliveryEvidenceSource !== 'x-original-to-header'
    && deliveryEvidenceSource !== 'none'
  ) return null;

  const deliveredToAddress = record.deliveredToAddress;
  if (deliveryEvidenceSource === 'none') {
    if (deliveredToAddress !== null) return null;
  } else if (typeof deliveredToAddress !== 'string' || !deliveredToAddress.includes('@') || deliveredToAddress.length > 320) {
    return null;
  }

  if (!Array.isArray(record.links) || record.links.length > 64 || !record.links.every(isValidLinkVerdict)) return null;

  if (typeof record.outcome !== 'string' || !INBOUND_MAIL_OUTCOMES.includes(record.outcome as InboundMailOutcome)) return null;
  if (typeof record.noticeStatus !== 'string' || !INBOUND_NOTICE_STATUSES.includes(record.noticeStatus as InboundNoticeStatus)) return null;
  if (record.noticeFailureReason !== undefined && typeof record.noticeFailureReason !== 'string') return null;

  if (typeof record.bodyExcerpt !== 'string' || record.bodyExcerpt.length > MAX_BODY_EXCERPT_CHARS) return null;
  if (!isParsableIsoDate(record.receivedAt)) return null;

  const common: Omit<InboundMailRecordCommon, 'id'> & { readonly id: string } = {
    id: (record.id as string).trim(),
    account: (record.account as string).trim(),
    mailbox: (record.mailbox as string).trim(),
    senderDisplay: record.senderDisplay,
    subject: record.subject,
    deliveredToAddress: deliveryEvidenceSource === 'none' ? null : (deliveredToAddress as string),
    deliveryEvidenceSource,
    links: record.links as readonly InboundLinkVerdict[],
    outcome: record.outcome as InboundMailOutcome,
    noticeStatus: record.noticeStatus as InboundNoticeStatus,
    ...(typeof record.noticeFailureReason === 'string' ? { noticeFailureReason: record.noticeFailureReason } : {}),
    bodyExcerpt: record.bodyExcerpt,
    receivedAt: record.receivedAt as string,
  };
  return { ...common, ...identity };
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
 * `historyId` from the input type — every caller would then compile while
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

  constructor(storeOrPath: PersistentStore<InboundMailSnapshot> | string, options: InboundMailStoreOptions = {}) {
    this.store = typeof storeOrPath === 'string' ? new PersistentStore<InboundMailSnapshot>(storeOrPath) : storeOrPath;
    const merged = { ...DEFAULT_INBOUND_MAIL_RECORD_POLICY, ...(options.policy ?? {}) };
    this.policy = { ...merged, maxBodyExcerptChars: Math.min(merged.maxBodyExcerptChars, MAX_BODY_EXCERPT_CHARS) };
    this.now = options.now ?? (() => Date.now());
  }

  getPolicy(): InboundMailRecordPolicy {
    return this.policy;
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
    const run = this.writeChain.then(async () => {
      const { records, malformed, corrupt } = await this.readWithDrops();
      const { next, result } = await fn(records, malformed, corrupt);
      await this.store.persist({ version: 1, records: next });
      return result;
    });
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Live, content-validated records, newest first. Read-time filter for age
   * and count (does not persist the drop — `sweep()` does that), so a read
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
   * what happened to it" — a question the in-memory dedup cache cannot answer
   * across a restart, because it is a `Map` in a process that just died. The
   * intake asks it before announcing, so a message redelivered because the
   * cursor had not advanced when the daemon restarted is not announced to the
   * owner a second time (§6).
   *
   * Bounded by the same age filter `list()` applies: a record past the
   * retention window is not a live fact about this message, and answering with
   * one would let a 30-day-old row suppress a notice.
   */
  async findByMessage(key: InboundMailMessageKey): Promise<InboundMailRecord | null> {
    const cutoff = this.now() - this.policy.retentionMs;
    const { records } = await this.readWithDrops();
    return records.find(
      (record) => isSameMessage(record, key) && Date.parse(record.receivedAt) >= cutoff,
    ) ?? null;
  }

  /**
   * Record one inbound message. The body excerpt is redacted of card shapes and
   * then truncated to the policy cap at write time.
   *
   * Redaction happens BEFORE the truncation, over a window slightly longer than
   * the cap. Truncating first and redacting the result would leave a card
   * number that straddles the cap boundary as a still-readable prefix of up to
   * eighteen digits — a shorter leak, not a redaction. The window overshoot is
   * bounded by MAX_CARD_SPAN_CHARS so a span starting just inside the cap is
   * always seen whole; anything starting beyond the cap is dropped by the
   * truncation regardless.
   *
   * ONE MESSAGE, ONE RECORD. A write whose message key already exists replaces
   * that row in place and keeps its `id`; it does not append a second row. That
   * is not tidiness, it is what makes the intake's ordering safe to retry: the
   * record now goes in BEFORE the notice, in a `pending` state, and every
   * retried pass — a `delivery-failed` transport, a daemon restarted mid-pass —
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
      account: input.account,
      mailbox: input.mailbox,
      // `From:`'s display name is written by whoever sent the message — the
      // same standing the subject has, and the same handling. It was left raw
      // while the subject beside it was redacted, so `"4111111111111111"
      // <a@b.test>` put a card number on disk for `retentionDays` and into the
      // owner's notice, through a field nobody thought of as content.
      senderDisplay: redactCardShapes(input.senderDisplay).slice(0, MAX_SENDER_DISPLAY_CHARS),
      // The subject is persisted alongside the excerpt AND rendered to the
      // owner in the notice, so it is the same exposure by a different field.
      // Re-clamped after redacting because a marker is longer than the digits
      // it replaces, and a subject over 998 chars fails validation on load —
      // taking the whole record with it.
      subject: redactCardShapes(input.subject).slice(0, MAX_SUBJECT_CHARS),
      // Sender-chosen too, on the catch-all domain the aliases live on (§7.1):
      // the local part is whatever the message was addressed to, so a PAN can
      // arrive as the alias itself. Clamped by `clampDeliveryAddress` rather
      // than a plain slice — see there for why this one field cannot use the
      // subject's re-clamp.
      deliveredToAddress: input.deliveredToAddress === null
        ? null
        : clampDeliveryAddress(redactCardShapes(input.deliveredToAddress)),
      deliveryEvidenceSource: input.deliveryEvidenceSource,
      links: input.links,
      outcome: input.outcome,
      noticeStatus: input.noticeStatus,
      ...(input.noticeFailureReason ? { noticeFailureReason: input.noticeFailureReason } : {}),
      bodyExcerpt: redactCardShapes(
        input.body.slice(0, this.policy.maxBodyExcerptChars + MAX_CARD_SPAN_CHARS),
      ).slice(0, this.policy.maxBodyExcerptChars),
      receivedAt: input.receivedAt,
    };
    return this.mutate(async (records) => {
      const index = records.findIndex((existing) => isSameMessage(existing, input));
      if (index < 0) return { next: [...records, entry], result: entry };
      const replacement: InboundMailRecord = { ...entry, id: records[index]!.id };
      const next = [...records];
      next[index] = replacement;
      return { next, result: replacement };
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
