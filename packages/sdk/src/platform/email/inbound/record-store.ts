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
 * `delivered` / `suppressed` — the two outcomes that never call the transport
 * — plus every reason `deliverSurfaceNotice` refuses with, PROJECTED off
 * `SurfaceNoticeRefusal` rather than restated (§7.3).
 *
 * It was restated, and it had already drifted: the hand-written list omitted
 * `empty-text` and `unsupported-delivery-surface`, both of which
 * `deliverSurfaceNotice` really does return. A notice refused for either of
 * them could not be recorded — `validateInboundMailRecord` would reject the
 * record on load and drop it — so the one case the owner most needs to see
 * ("mail arrived and could not be announced") was the case that vanished.
 * A projection cannot drift, because there is nothing to keep in sync.
 */
export type InboundNoticeStatus = 'delivered' | 'suppressed' | SurfaceNoticeRefusal;

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
export interface InboundMailRecord {
  readonly id: string;
  readonly account: string;
  readonly mailbox: string;
  readonly uidValidity: number;
  readonly uid: number;
  /** Sanitized: sender's registrable domain + local part, never raw untrusted text (§7). */
  readonly senderDisplay: string;
  /** Sanitized/truncated (§7): newlines and control characters removed before this is ever stored. */
  readonly subject: string;
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

/** `file-unreadable` is the whole-file counterpart of `malformed` — see `CursorDiscardReason`. */
export type InboundMailDiscardReason = 'malformed' | 'file-unreadable' | 'expired' | 'over-cap';

export interface InboundMailDiscard {
  readonly id: string;
  readonly account: string;
  readonly mailbox: string;
  readonly uid: number;
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
export function validateInboundMailRecord(value: unknown): InboundMailRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (!isNonEmptyTrimmedString(record.id, 128)) return null;
  if (!isNonEmptyTrimmedString(record.account, 256)) return null;
  if (!isNonEmptyTrimmedString(record.mailbox, 512)) return null;
  if (!isPositiveInteger(record.uidValidity)) return null;
  if (!isPositiveInteger(record.uid)) return null;
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

  return {
    id: (record.id as string).trim(),
    account: (record.account as string).trim(),
    mailbox: (record.mailbox as string).trim(),
    uidValidity: record.uidValidity as number,
    uid: record.uid as number,
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
}

export interface InboundMailStoreOptions {
  readonly policy?: Partial<InboundMailRecordPolicy> | undefined;
  readonly now?: (() => number) | undefined;
}

export type InboundMailRecordInput = Omit<InboundMailRecord, 'id' | 'bodyExcerpt'> & { readonly body: string };

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
   */
  async record(input: InboundMailRecordInput): Promise<InboundMailRecord> {
    const entry: InboundMailRecord = {
      id: randomUUID(),
      account: input.account,
      mailbox: input.mailbox,
      uidValidity: input.uidValidity,
      uid: input.uid,
      senderDisplay: input.senderDisplay,
      // The subject is persisted alongside the excerpt AND rendered to the
      // owner in the notice, so it is the same exposure by a different field.
      // Re-clamped after redacting because a marker is longer than the digits
      // it replaces, and a subject over 998 chars fails validation on load —
      // taking the whole record with it.
      subject: redactCardShapes(input.subject).slice(0, MAX_SUBJECT_CHARS),
      deliveredToAddress: input.deliveredToAddress,
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
    return this.mutate(async (records) => ({ next: [...records, entry], result: entry }));
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
          uid: 0,
          reason: 'file-unreadable',
          removedAt: now,
          note: `the inbound record file could not be read (${corrupt.detail}), so its `
            + 'contents were discarded',
        });
      }
      if (malformed > 0) {
        removed.push({ id: '(unreadable)', account: '(unknown)', mailbox: '(unknown)', uid: 0, reason: 'malformed', removedAt: now });
      }

      const withinAge: InboundMailRecord[] = [];
      for (const record of records) {
        if (Date.parse(record.receivedAt) < cutoff) {
          removed.push({ id: record.id, account: record.account, mailbox: record.mailbox, uid: record.uid, reason: 'expired', removedAt: now });
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
          removed.push({ id: record.id, account: record.account, mailbox: record.mailbox, uid: record.uid, reason: 'over-cap', removedAt: now });
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
