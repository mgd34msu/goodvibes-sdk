/**
 * source-cursor.ts, the persisted position, discriminated by source
 * (docs/inbound-email.md §3.4d, §4).
 *
 * IMAP's position is `UIDVALIDITY` + the highest UID fully processed. Gmail's
 * is a `historyId`, and the two are not the same kind of thing:
 *
 *   - A `historyId` is a **uint64**. `18446744073709551615` does not survive a
 *     trip through a JS number, `Number('18446744073709551615')` is
 *     `18446744073709552000`, and a cursor that came back four hundred larger
 *     than it went in would silently skip everything in between. So it is
 *     carried and persisted as a DECIMAL STRING and never converted.
 *   - A `historyId` is not a UID and has no `UIDVALIDITY` beside it, so
 *     widening `MailboxCursor` to hold both would mean two numeric fields that
 *     are meaningless on one source and one string field meaningless on the
 *     other, a record that is always half-filled, where "half-filled" and
 *     "torn" look identical on load.
 *
 * So the record discriminates on `source`, and the validators below refuse to
 * read one shape as the other. A Gmail cursor asked for as an IMAP cursor is
 * DISCARDED, not coerced: a coerced cursor is a wrong position, and a wrong
 * position either replays the mailbox at the owner or silently skips the
 * message they were waiting for.
 *
 * The one tolerated leniency, stated rather than hidden: a stored record with
 * NO `source` field at all is read as IMAP. That is the only shape that ever
 * existed before this file, every IMAP field is still validated on its way in,
 * and a Gmail record can never take that path because it carries `source`
 * explicitly and has no `uidValidity` to validate. A record that names a
 * source this build does not know is discarded.
 */

import { isNonEmptyTrimmedString, isParsableIsoDate, type MailboxCursor } from './types.js';

/** Which mechanism wrote this position. */
export type InboundCursorSource = 'imap' | 'gmail';

/** An IMAP position: `UIDVALIDITY` plus the highest UID fully processed. */
export interface ImapMailboxCursor extends MailboxCursor {
  readonly source: 'imap';
}

/**
 * A Gmail position: the `historyId` of the last delta fully processed.
 *
 * `mailbox` is the label the source watches (`INBOX` unless configured
 * otherwise), kept so a Gmail cursor is keyed the same way an IMAP one is and
 * the store needs no second index.
 */
export interface GmailMailboxCursor {
  readonly source: 'gmail';
  /** Config account id, not an address. */
  readonly account: string;
  /** The watched label, e.g. `INBOX`. */
  readonly mailbox: string;
  /**
   * Gmail's `historyId`, as Google sends it: a decimal uint64 STRING.
   * Never parsed to a number, see the header.
   */
  readonly historyId: string;
  /** ISO 8601. */
  readonly updatedAt: string;
}

export type InboundSourceCursor = ImapMailboxCursor | GmailMailboxCursor;

/**
 * Longest decimal `historyId` accepted. A uint64 maxes out at
 * `18446744073709551615`, twenty digits, so anything longer is a torn or
 * hand-edited record, not a position Google ever issued.
 */
const HISTORY_ID_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;

/**
 * The ceiling on a UID and on UIDVALIDITY alike: `2^32 - 1`.
 *
 * RFC 3501 §2.3.1.1 defines both as 32-bit values, so a stored number above
 * this names nothing a server can ever hand back. Bounding it is the exact
 * counterpart of `HISTORY_ID_PATTERN` above, a position outside the range the
 * protocol defines is a torn or hand-edited record, not a place to resume from.
 *
 * WHY THE SIGN CHECK ALONE WAS NOT ENOUGH, since that is what this replaces.
 * `lastSeenUid` is a HIGH-WATER MARK and `advance()` moves it with `Math.max`,
 * so it only ever climbs. One absurd value, `9007199254740991`, or the `1e20`
 * a `parseInt` of an over-long SEARCH token produces, therefore has no way
 * back down: `resolve()` answers `resumed` without ever comparing it to the
 * mailbox's real high-water mark, `sweep()` has no rule that reaps it, and
 * `UID SEARCH UID <cursor+1>:*` filtered to `uid > lastSeenUid` then discards
 * every real message forever. The drain reports `complete, found: 0` and the
 * watcher calls itself healthy while no mail is ever delivered again.
 *
 * A value outside the range is DISCARDED, never clamped down to the ceiling.
 * Clamping would invent a position: `4294967295` is not where the daemon
 * actually got to, and resuming from it would skip the whole mailbox just as
 * silently. Discarding sends the record through the same path a torn one
 * takes, dropped at load, disclosed by `sweep()` as `malformed`, and
 * re-established at the current high-water mark by `resolve()`.
 */
export const MAX_IMAP_UID = 4_294_967_295;

/**
 * A UID as a cursor may hold it: an integer in `0 .. MAX_IMAP_UID`.
 *
 * Zero is accepted deliberately, see `validateImapSourceCursor`'s note on why
 * `lastSeenUid` is non-negative rather than positive.
 */
export function isImapUid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_IMAP_UID;
}

/** A UIDVALIDITY as a cursor may hold it: an integer in `1 .. MAX_IMAP_UID` (RFC 3501: non-zero). */
export function isImapUidValidity(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_IMAP_UID;
}

/**
 * A `historyId` as Google writes it: decimal digits, no sign, no exponent, no
 * leading zeros, at most a uint64's worth.
 *
 * Checked as a STRING on purpose. Validating it by round-tripping through
 * `Number` would accept `1.8446744073709552e19` and reject nothing that
 * matters, while quietly blessing exactly the precision loss this shape exists
 * to prevent.
 */
export function isHistoryId(value: unknown): value is string {
  return typeof value === 'string' && HISTORY_ID_PATTERN.test(value);
}

/**
 * Validate an IMAP cursor record by content.
 *
 * Returns `null`, never a repaired record, for anything torn, out of range,
 * or belonging to another source. `lastSeenUid` is validated as NON-NEGATIVE
 * rather than positive: `0` is the honest value for a first run against an
 * empty mailbox, and requiring positivity would make a freshly established
 * cursor fail its own validation on the very next load.
 */
export function validateImapSourceCursor(value: unknown): ImapMailboxCursor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const source = record.source;
  // A record that names a different source is somebody else's position, and
  // reading it as an IMAP one would invent a UID out of a historyId.
  if (source !== undefined && source !== 'imap') return null;
  const imap = validateMailboxCursorFields(record);
  if (imap === null) return null;
  return { source: 'imap', ...imap };
}

/** Validate a Gmail cursor record by content. Returns `null` for a torn record. */
export function validateGmailCursor(value: unknown): GmailMailboxCursor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // Gmail's shape is never inferred from absence: an IMAP record carries no
  // `source` and would otherwise be read here as a Gmail cursor with a missing
  // historyId, which is the coercion this union exists to make impossible.
  if (record.source !== 'gmail') return null;
  if (!isNonEmptyTrimmedString(record.account, 256)) return null;
  if (!isNonEmptyTrimmedString(record.mailbox, 512)) return null;
  if (!isHistoryId(record.historyId)) return null;
  if (!isParsableIsoDate(record.updatedAt)) return null;
  return {
    source: 'gmail',
    account: (record.account as string).trim(),
    mailbox: (record.mailbox as string).trim(),
    historyId: record.historyId,
    updatedAt: record.updatedAt as string,
  };
}

/**
 * Validate a record of either shape, choosing by its own `source` field rather
 * than by which validator happens to accept it first.
 */
export function validateInboundSourceCursor(value: unknown): InboundSourceCursor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = (value as Record<string, unknown>).source;
  if (source === 'gmail') return validateGmailCursor(value);
  if (source === 'imap' || source === undefined) return validateImapSourceCursor(value);
  // A source this build does not know about. Discarded rather than guessed at.
  return null;
}

/** The IMAP field checks, shared with `cursor-store.ts`'s `validateMailboxCursor`. */
export function validateMailboxCursorFields(record: Record<string, unknown>): MailboxCursor | null {
  if (!isNonEmptyTrimmedString(record.account, 256)) return null;
  if (!isNonEmptyTrimmedString(record.mailbox, 512)) return null;
  // Bounded at BOTH ends. The upper bound is the one that was missing, and it
  // is the one that matters, see `MAX_IMAP_UID` for why an unbounded
  // `lastSeenUid` is unrecoverable rather than merely wrong.
  if (!isImapUidValidity(record.uidValidity)) return null;
  if (!isImapUid(record.lastSeenUid)) return null;
  if (!isParsableIsoDate(record.updatedAt)) return null;
  return {
    account: (record.account as string).trim(),
    mailbox: (record.mailbox as string).trim(),
    uidValidity: record.uidValidity,
    lastSeenUid: record.lastSeenUid,
    updatedAt: record.updatedAt as string,
  };
}
