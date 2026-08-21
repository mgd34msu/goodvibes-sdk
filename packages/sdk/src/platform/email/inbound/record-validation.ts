/**
 * record-validation.ts, content validation and field bounds for one stored
 * inbound-mail record (docs/inbound-email.md §9.3, rule 3: validate by
 * content).
 *
 * Split out of `record-store.ts`, which owns the STORE. This file owns the
 * answer to "is this thing on disk a record, and is it a record small enough
 * to have been written by us", the two questions a loader asks and a writer
 * has to satisfy in the same terms, which is why the write-time clamps live
 * beside the load-time checks rather than across the file from them.
 *
 * Every field bound here is a bound on the FILE. `maxRecords` bounds how many
 * records the store keeps and nothing bounded how big one could be, so a
 * count-bounded store was bounded in the axis nobody attacks, the same
 * finding `verification-expectations.ts` records for the expectation book, in
 * the same words, because it is the same defect in the neighbouring store.
 *
 * The types are imported TYPE-ONLY from `record-store.ts` and are erased at
 * build time, so this file names the record shape without owning it and the
 * import cycle exists only for the type checker.
 */
import { isHistoryId } from './source-cursor.js';
import {
  isNonEmptyTrimmedString,
  isParsableIsoDate,
  isPositiveInteger,
  MAX_BODY_EXCERPT_CHARS,
} from './types.js';
import type {
  GmailInboundMailRecord,
  ImapInboundMailRecord,
  InboundLinkVerdict,
  InboundMailOutcome,
  InboundMailRecord,
  InboundMailRecordCommon,
  InboundNoticeStatus,
} from './record-store.js';
// Type-only, and erased at build time: this module names the refusal
// vocabulary rather than owning it (§7.3).
import type { SurfaceNoticeRefusal } from '../../daemon/types.js';

/** What `validateInboundMailRecord` accepts for `subject`; redaction must not exceed it. */
export const MAX_SUBJECT_CHARS = 998;

/** What `validateInboundMailRecord` accepts for `senderDisplay`; same rule as the subject. */
export const MAX_SENDER_DISPLAY_CHARS = 998;

/** What `validateInboundMailRecord` accepts for `deliveredToAddress`. */
export const MAX_DELIVERED_TO_CHARS = 320;

/**
 * What `validateInboundMailRecord` accepts for `noticeFailureReason`.
 *
 * This field had NO bound, and it is the one field on the record whose text a
 * REMOTE SERVER writes: `intake.ts` sets it from `delivery.error`, which is
 * whatever the notice transport handed back, a Telegram or Slack error body,
 * verbatim. A push service answering a refusal with a megabyte of HTML put a
 * megabyte on disk, per message, inside a store that believed `maxRecords`
 * bounded it. 512 characters is longer than any refusal worth reading and
 * shorter than anything worth storing.
 */
export const MAX_NOTICE_FAILURE_REASON_CHARS = 512;

/**
 * What `isValidLinkVerdict` accepts for a verdict's `reason`.
 *
 * Bounded for the same reason and with less excuse: `links` was capped at 64
 * entries with `registrableDomain` capped at 253, so the array LOOKED bounded
 *, and then each entry carried an unbounded `reason`. Sixty-four unbounded
 * strings is an unbounded record. No production path fills `links` yet
 * (`intake.ts` passes `[]` until the body-fetch round), so this is closed
 * before it is reachable rather than after.
 */
export const MAX_LINK_REASON_CHARS = 256;

/** How many link verdicts one record may carry. */
export const MAX_LINK_VERDICTS = 64;

/**
 * What `validateInboundMailRecord` accepts for `account` and `mailbox`.
 *
 * These two were bounded on the LOAD path and clamped nowhere on the write
 * path, which is the worst of the two arrangements: a megabyte `mailbox` was
 * written to disk in full and then failed its own validation on the very next
 * load, taking the whole record with it. Measured, a record built from
 * megabyte fields was two megabytes on disk, and every other field was already
 * clamped, so this pair was the entire remainder.
 *
 * Not attacker-written today (both come from the daemon's own configuration),
 * which is exactly why it survived review: the bound that is never exercised
 * is the bound nobody notices is missing on one of its two paths.
 */
export const MAX_ACCOUNT_CHARS = 256;
export const MAX_MAILBOX_CHARS = 512;

/**
 * Clamp the account/mailbox pair a record is scoped by, at WRITE time and at
 * LOOKUP time, so both sides of a comparison get the same treatment.
 *
 * Applied in two places on purpose. `record()` clamps what it stores;
 * `findByMessage()` clamps the key it is asked about. Clamping only the write
 * would make a long account store as one string and look up as another, and
 * dedup, which is what `findByMessage` exists for, would miss and announce
 * the same message twice.
 */
export function clampRecordScope(scope: { readonly account: string; readonly mailbox: string }): {
  readonly account: string;
  readonly mailbox: string;
} {
  return {
    account: scope.account.slice(0, MAX_ACCOUNT_CHARS),
    mailbox: scope.mailbox.slice(0, MAX_MAILBOX_CHARS),
  };
}

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
 * validation on the very next load and be discarded WHOLE, the mail would
 * vanish from the store entirely, which is a worse outcome than the exposure
 * this redaction exists to close.
 *
 * So the domain is kept intact and the local part gives up the characters. The
 * part that is truncated is the part that had already been overwritten with
 * markers, and the part that identifies where the message landed survives.
 */
export function clampDeliveryAddress(value: string): string {
  if (value.length <= MAX_DELIVERED_TO_CHARS) return value;
  const at = value.indexOf('@');
  if (at < 0) return value.slice(0, MAX_DELIVERED_TO_CHARS);
  const domain = value.slice(at);
  return domain.length >= MAX_DELIVERED_TO_CHARS
    ? domain.slice(0, MAX_DELIVERED_TO_CHARS)
    : value.slice(0, MAX_DELIVERED_TO_CHARS - domain.length) + domain;
}

/**
 * Clamp a link verdict list to what the loader accepts, at WRITE time.
 *
 * Both bounds, not one: the entry count and each entry's `reason`. A write
 * that exceeded either produced a record the very next load would discard
 * whole, losing the message rather than the oversized field, which is the
 * failure mode `clampDeliveryAddress` exists to avoid on its own field.
 */
export function clampLinkVerdicts(links: readonly InboundLinkVerdict[]): readonly InboundLinkVerdict[] {
  return links.slice(0, MAX_LINK_VERDICTS).map((link) => (
    link.reason === undefined || link.reason.length <= MAX_LINK_REASON_CHARS
      ? link
      : { ...link, reason: link.reason.slice(0, MAX_LINK_REASON_CHARS) }
  ));
}

export const INBOUND_MAIL_OUTCOMES: readonly InboundMailOutcome[] = [
  'matched-expectation',
  'no-expectation',
  'recipient-mismatch',
  'expired-expectation',
  'ambiguous',
  'no-delivery-evidence',
];

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

export const INBOUND_NOTICE_STATUSES: readonly InboundNoticeStatus[] = [
  'delivered',
  'suppressed',
  'pending',
  ...(Object.keys(NOTICE_REFUSAL_STATUSES) as readonly SurfaceNoticeRefusal[]),
];

const LINK_VERDICTS: readonly InboundLinkVerdict['verdict'][] = ['allowed', 'refused', 'unresolved'];

function isValidLinkVerdict(value: unknown): value is InboundLinkVerdict {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!isNonEmptyTrimmedString(record.registrableDomain, 253)) return false;
  if (typeof record.verdict !== 'string' || !LINK_VERDICTS.includes(record.verdict as InboundLinkVerdict['verdict'])) return false;
  if (record.reason !== undefined
    && (typeof record.reason !== 'string' || record.reason.length > MAX_LINK_REASON_CHARS)) return false;
  return true;
}

/**
 * The identity half of a record, chosen by the record's OWN `source` field.
 *
 * Returns `null` for a payload that does not match the source it declares,
 * discarded, never coerced. §9's rule is that a torn record is dropped rather
 * than repaired, and coercion here is the specific repair that caused the bug
 * this replaced: reading a Gmail record against IMAP rules and rejecting it.
 *
 * A record with NO `source` is read as IMAP. That is deliberate backward
 * compatibility, not inference: every record written before the union existed
 * is an IMAP record, and treating absence as unknown would discard the whole
 * existing store on first load. Gmail is never inferred from absence, it must
 * say so, which is the same asymmetry `validateGmailCursor` uses and for the
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
    // restated, a second copy of a uint64 rule is a second chance to get it
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

/**
 * Validate a record by its parsed content, not by its presence in the file.
 * Returns `null` for anything torn, oversized, or out of range. Never throws,
 * never repairs, a body excerpt that somehow exceeds the hard cap is a
 * reason to discard the whole record, not to truncate it again on read.
 */
export function validateInboundMailRecord(value: unknown): InboundMailRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (!isNonEmptyTrimmedString(record.id, 128)) return null;
  if (!isNonEmptyTrimmedString(record.account, MAX_ACCOUNT_CHARS)) return null;
  if (!isNonEmptyTrimmedString(record.mailbox, MAX_MAILBOX_CHARS)) return null;
  // Discriminate FIRST. Validating identity fields before knowing which source
  // wrote them is exactly how every Gmail record came to be discarded.
  const identity = validateRecordIdentity(record);
  if (identity === null) return null;
  if (typeof record.senderDisplay !== 'string' || record.senderDisplay.length > MAX_SENDER_DISPLAY_CHARS) return null;
  if (typeof record.subject !== 'string' || record.subject.length > MAX_SUBJECT_CHARS) return null;

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
  } else if (
    typeof deliveredToAddress !== 'string'
    || !deliveredToAddress.includes('@')
    || deliveredToAddress.length > MAX_DELIVERED_TO_CHARS
  ) {
    return null;
  }

  if (!Array.isArray(record.links) || record.links.length > MAX_LINK_VERDICTS || !record.links.every(isValidLinkVerdict)) return null;

  if (typeof record.outcome !== 'string' || !INBOUND_MAIL_OUTCOMES.includes(record.outcome as InboundMailOutcome)) return null;
  if (typeof record.noticeStatus !== 'string' || !INBOUND_NOTICE_STATUSES.includes(record.noticeStatus as InboundNoticeStatus)) return null;
  // Bounded, not merely typed. See MAX_NOTICE_FAILURE_REASON_CHARS: this is
  // the one field on the record a remote server writes.
  if (record.noticeFailureReason !== undefined
    && (typeof record.noticeFailureReason !== 'string'
      || record.noticeFailureReason.length > MAX_NOTICE_FAILURE_REASON_CHARS)) return null;

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
