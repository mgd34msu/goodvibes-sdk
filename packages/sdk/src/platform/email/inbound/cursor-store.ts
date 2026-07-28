/**
 * cursor-store.ts — the durable per-mailbox cursor, for both sources
 * (docs/inbound-email.md §4, §3.4d).
 *
 * `EXAMINE` + `BODY.PEEK` means the daemon never marks anything `\Seen`, so
 * `SEARCH UNSEEN` would return the same messages forever and "have I handled
 * this?" cannot be asked of the server. This store keeps the daemon's own
 * answer: one record per (account, mailbox), so the file cannot grow with
 * mail traffic.
 *
 * The record is a discriminated union, because IMAP's position and Gmail's are
 * not the same kind of thing — `UIDVALIDITY` + highest UID against a decimal
 * uint64 `historyId` STRING. `source-cursor.ts` holds the shapes and the
 * validators and states the reasoning; this file holds the custody rules over
 * them. Both sources' write paths are here, and both go through ONE
 * establish-at-high-water-mark path (`establishAt`), so `uid-validity-changed`
 * and `history-expired` cannot drift into two different ideas of what to do
 * when we lost our place.
 *
 * Follows the same five-rule shape as `platform/devices/device-grants.ts`:
 *  1. Reap on recovery — cursors for an account no longer configured are
 *     dropped at load. The "is this account configured" predicate is an
 *     injected dependency (`isAccountConfigured`); this module never reads
 *     config directly.
 *  2. Bound everything — one record per mailbox already bounds the file with
 *     traffic; `maxCursors` is a defensive count cap on top of that, in case a
 *     bug or a hand-edited config ever produced more distinct (account,
 *     mailbox) pairs than could plausibly be real.
 *  3. Validate by content — on an IMAP record, `uidValidity` and `lastSeenUid`
 *     must be positive / non-negative integers (see the note on `lastSeenUid`
 *     below); on a Gmail record, `historyId` must be a decimal uint64 string;
 *     on both, `updatedAt` a parseable ISO date and `mailbox` and `account`
 *     non-empty, length-bounded strings. A record failing ANY check is
 *     discarded, not repaired: a corrupt cursor silently coerced to 0 would
 *     replay the entire mailbox at the owner. A record naming a source this
 *     build does not know is discarded rather than read as either shape.
 *  4. Reap periodically — `sweep()` is safe to call on a timer, not only at boot.
 *  5. Disclose what was reaped — every sweep returns an itemised report.
 *
 * The UIDVALIDITY rule and first-run behaviour (§4) live in `resolve()`:
 * establishing or re-establishing a cursor NEVER replays past mail. It always
 * sets `lastSeenUid` to the caller-supplied current high-water mark and
 * reports how many messages were skipped, rather than backfilling.
 *
 * A NOTE ON WHERE THE DESIGN DOC AND THIS IMPLEMENTATION DIVERGE:
 * §9.1 says "`uidValidity` and `lastSeenUid` must be positive integers".
 * `uidValidity` is always positive under IMAP (RFC 3501: a 32-bit
 * non-zero value). `lastSeenUid`, however, is legitimately `0` on first run
 * against a mailbox that currently holds no messages — there is no highest
 * UID to establish, and `0` is the only honest value meaning "nothing seen
 * yet". Requiring `lastSeenUid > 0` would make that record fail its own
 * validation on the very next load, immediately after being written. This
 * store therefore validates `lastSeenUid` as a NON-NEGATIVE integer while
 * keeping `uidValidity` strictly positive. Flagged in the implementation
 * report as a design-doc correction, not silently reinterpreted.
 */
import { PersistentStore } from '../../state/persistent-store.js';
import {
  type HousekeepingTrigger,
  type MailboxCursor,
} from './types.js';
import {
  isHistoryId,
  validateInboundSourceCursor,
  validateMailboxCursorFields,
  type GmailMailboxCursor,
  type ImapMailboxCursor,
  type InboundSourceCursor,
} from './source-cursor.js';

export type CursorDiscardReason = 'malformed' | 'account-not-configured' | 'over-cap';

/** One removal, itemised for disclosure. */
export interface CursorDiscard {
  readonly account: string;
  readonly mailbox: string;
  readonly reason: CursorDiscardReason;
  readonly removedAt: number;
  readonly note?: string | undefined;
}

/** Result of one housekeeping pass over the cursor store. */
export interface CursorSweepReport {
  readonly sweptAt: number;
  readonly removed: readonly CursorDiscard[];
  readonly retained: number;
}

export type CursorResolutionKind = 'resumed' | 'first-run' | 'uid-validity-changed';

/**
 * The Gmail equivalent, with `history-expired` standing exactly where
 * `uid-validity-changed` stands on the IMAP side.
 *
 * Gmail answers `users.history.list` with a 404 when the requested
 * `startHistoryId` has aged out of its retention window — typically about a
 * week, sometimes hours. That means the same thing a changed `UIDVALIDITY`
 * means: the stored position names nothing. Both go through
 * `establishCursor()` below, so there is one implementation of "what to do
 * when we lost our place" and not two that can drift.
 */
export type GmailCursorResolutionKind = 'resumed' | 'first-run' | 'history-expired';

/** The outcome of asking where the Gmail source should resume from. */
export interface GmailCursorResolution {
  readonly kind: GmailCursorResolutionKind;
  /** The cursor to use going forward. Already persisted when this is returned. */
  readonly cursor: GmailMailboxCursor;
  /** The discarded cursor, present only for `history-expired` — disclose this to the owner. */
  readonly previous?: GmailMailboxCursor | undefined;
}

/**
 * The outcome of asking "what cursor should I use for this mailbox right
 * now", given what the server just reported. Never a signal to replay: a
 * `first-run` or `uid-validity-changed` result always establishes
 * `lastSeenUid` at the caller-supplied high-water mark, never at 0 or at the
 * old value.
 */
export interface CursorResolution {
  readonly kind: CursorResolutionKind;
  /** The cursor to use going forward. Already persisted when this is returned. */
  readonly cursor: MailboxCursor;
  /** Messages that existed before this mailbox was watched (or before its UIDVALIDITY changed) and were deliberately NOT replayed. Always 0 for `resumed`. */
  readonly skippedMessageCount: number;
  /** The discarded cursor, present only for `uid-validity-changed` — disclose this to the owner. */
  readonly previous?: MailboxCursor | undefined;
}

export interface MailboxCursorPolicy {
  /** Defensive count cap across all (account, mailbox) pairs. */
  readonly maxCursors: number;
}

export const DEFAULT_MAILBOX_CURSOR_POLICY: MailboxCursorPolicy = {
  maxCursors: 256,
};

interface CursorSnapshot extends Record<string, unknown> {
  readonly version: 1;
  readonly cursors: readonly InboundSourceCursor[];
}

/**
 * Validate an IMAP cursor by its parsed content, not by its presence in the
 * file. Returns `null` for anything torn, oversized, out of range, or written
 * by a different source. Never throws, never repairs.
 *
 * The field checks live in `source-cursor.ts` so the discriminated-union
 * validator and this one cannot drift into disagreeing about what a valid
 * IMAP position is.
 */
export function validateMailboxCursor(value: unknown): MailboxCursor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.source !== undefined && record.source !== 'imap') return null;
  return validateMailboxCursorFields(record);
}

/**
 * Where the record for a (account, mailbox) pair sits, REGARDLESS of source.
 *
 * The key is the pair, not the pair plus the source, because a mailbox is
 * served by exactly one source at a time — `surfaces.email.inbound.source`
 * picks one, and the two never run against the same mailbox concurrently.
 */
function indexOfKey(
  cursors: readonly InboundSourceCursor[],
  account: string,
  mailbox: string,
): number {
  return cursors.findIndex((c) => c.account === account && c.mailbox === mailbox);
}

/**
 * Write `established` at `index`, or append it when there was nothing there.
 *
 * The single establish path, shared by `first-run`, `uid-validity-changed` and
 * `history-expired` on both sources, so there is one implementation of what to
 * do when we lost our place rather than three that can drift.
 *
 * It REPLACES whatever held the key, including a record from the OTHER source.
 * A mailbox is served by one source at a time, so a cursor left behind by the
 * other one is a position that names nothing: a `historyId` cannot say which
 * UIDs are done and a UID cannot say which history records are. Keeping both
 * would mean the file carried a position no code path can honour, and a later
 * switch back would resume from a mark that has been stale for however long
 * the other source ran — which is a silent skip. Replacing is disclosed
 * instead: the resolution comes back as `first-run`, so the caller tells the
 * owner the mailbox is being started fresh at the current high-water mark.
 */
function establishAt(
  cursors: readonly InboundSourceCursor[],
  index: number,
  established: InboundSourceCursor,
): InboundSourceCursor[] {
  return index >= 0
    ? cursors.map((c, i) => (i === index ? established : c))
    : [...cursors, established];
}

/**
 * Order two decimal `historyId` strings WITHOUT converting either to a number.
 *
 * Returns a negative number when `a` is the earlier position, 0 when they are
 * the same, positive when `a` is later.
 *
 * A `historyId` is a uint64, and `Number('18446744073709551615')` is
 * `18446744073709552000` — so `<` and `>` on parsed values would report two
 * distinct positions as equal, or the wrong one as later, precisely at the top
 * of the range. Both operands have already passed `isHistoryId`, which means
 * each is decimal digits only, no sign, no exponent and NO LEADING ZEROS. For
 * strings of that shape:
 *
 *  - a longer string is always the larger number (no leading zeros to pad it),
 *    which is why length is compared FIRST; and
 *  - at equal length, lexicographic order over the characters is exactly
 *    numeric order, because '0'..'9' are adjacent and ascending.
 *
 * Length first is not a micro-optimisation but the correctness step: plain
 * lexicographic comparison puts '9' above '10'.
 */
function compareHistoryIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export interface MailboxCursorStoreOptions {
  readonly policy?: Partial<MailboxCursorPolicy> | undefined;
  readonly now?: (() => number) | undefined;
  /**
   * Injected dependency, not a config read: answers "is this account still
   * configured for inbound watching". When omitted, the account-reap rule is
   * inert (nothing is dropped on that basis) rather than defaulting to "drop
   * everything" or "read config directly".
   */
  readonly isAccountConfigured?: ((account: string) => boolean) | undefined;
}

/**
 * Durable per-mailbox cursor store. Every read re-validates from disk so a
 * corrupt or stale record written by a crashed process is never honoured.
 */
export class MailboxCursorStore {
  private readonly store: PersistentStore<CursorSnapshot>;
  private readonly policy: MailboxCursorPolicy;
  private readonly now: () => number;
  private readonly isAccountConfigured: ((account: string) => boolean) | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(storeOrPath: PersistentStore<CursorSnapshot> | string, options: MailboxCursorStoreOptions = {}) {
    this.store = typeof storeOrPath === 'string' ? new PersistentStore<CursorSnapshot>(storeOrPath) : storeOrPath;
    this.policy = { ...DEFAULT_MAILBOX_CURSOR_POLICY, ...(options.policy ?? {}) };
    this.now = options.now ?? (() => Date.now());
    this.isAccountConfigured = options.isAccountConfigured;
  }

  getPolicy(): MailboxCursorPolicy {
    return this.policy;
  }

  private async readWithDrops(): Promise<{ cursors: InboundSourceCursor[]; malformed: number }> {
    const raw = await this.store.load();
    if (!raw || typeof raw !== 'object') return { cursors: [], malformed: 0 };
    const rawCursors = Array.isArray(raw.cursors) ? raw.cursors : [];
    const cursors = rawCursors
      .map(validateInboundSourceCursor)
      .filter((c): c is InboundSourceCursor => c !== null);
    return { cursors, malformed: rawCursors.length - cursors.length };
  }

  private async mutate<T>(
    fn: (cursors: InboundSourceCursor[], malformed: number) => Promise<{ next: InboundSourceCursor[]; result: T }>,
  ): Promise<T> {
    const run = this.writeChain.then(async () => {
      const { cursors, malformed } = await this.readWithDrops();
      const { next, result } = await fn(cursors, malformed);
      await this.store.persist({ version: 1, cursors: next });
      return result;
    });
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Live, content-validated cursors, filtered to configured accounts when
   * `isAccountConfigured` was supplied. Read-time filter — does not persist
   * the drop; `sweep()` is what removes it from disk.
   */
  async list(): Promise<readonly InboundSourceCursor[]> {
    const { cursors } = await this.readWithDrops();
    return this.isAccountConfigured ? cursors.filter((c) => this.isAccountConfigured!(c.account)) : cursors;
  }

  /**
   * The IMAP cursor for a mailbox.
   *
   * A stored GMAIL cursor under the same key answers `null` here rather than
   * being read as an IMAP one — a `historyId` is not a UID and there is no
   * honest conversion between them, so the position is treated as absent and
   * re-established at the high-water mark, which is the same rule a torn
   * record gets.
   */
  async get(account: string, mailbox: string): Promise<MailboxCursor | null> {
    const cursors = await this.list();
    return cursors.find(
      (c): c is ImapMailboxCursor => c.source === 'imap' && c.account === account && c.mailbox === mailbox,
    ) ?? null;
  }

  /** The Gmail cursor for a mailbox. A stored IMAP cursor answers `null`, for the same reason. */
  async getGmail(account: string, mailbox: string): Promise<GmailMailboxCursor | null> {
    const cursors = await this.list();
    return cursors.find(
      (c): c is GmailMailboxCursor => c.source === 'gmail' && c.account === account && c.mailbox === mailbox,
    ) ?? null;
  }

  /**
   * Resolve the IMAP cursor to use for a mailbox given what the server reports
   * right now (§4).
   *
   *  - No stored cursor -> `first-run`: establishes `lastSeenUid` at
   *    `currentHighestUid` and reports `currentMessageCount` as skipped. Does
   *    not backfill.
   *  - Stored cursor with the same UIDVALIDITY -> `resumed`: the stored
   *    cursor stands unchanged.
   *  - Stored cursor with a DIFFERENT UIDVALIDITY -> `uid-validity-changed`:
   *    every stored UID is meaningless (the mailbox was recreated), so the
   *    cursor is discarded and re-established at `currentHighestUid`,
   *    reporting `currentMessageCount` as skipped rather than replaying a
   *    year of old mail. The discarded cursor is returned as `previous` for
   *    disclosure.
   *
   * A stored GMAIL cursor under the same key is treated as absent, so this
   * answers `first-run` and REPLACES it — see `establishAt()` for why the
   * record is replaced rather than kept alongside.
   */
  async resolve(input: {
    readonly account: string;
    readonly mailbox: string;
    readonly serverUidValidity: number;
    readonly currentHighestUid: number;
    readonly currentMessageCount: number;
  }): Promise<CursorResolution> {
    const now = this.now();
    return this.mutate(async (cursors) => {
      const index = indexOfKey(cursors, input.account, input.mailbox);
      const stored = index >= 0 ? (cursors[index] ?? null) : null;
      // Only an IMAP record is a position this method can resume from. A Gmail
      // one names nothing in UID terms, which is the same standing a torn
      // record has.
      const existing = stored !== null && stored.source === 'imap' ? stored : null;

      if (existing && existing.uidValidity === input.serverUidValidity) {
        return { next: cursors, result: { kind: 'resumed', cursor: existing, skippedMessageCount: 0 } };
      }

      const established: ImapMailboxCursor = {
        source: 'imap',
        account: input.account,
        mailbox: input.mailbox,
        uidValidity: input.serverUidValidity,
        lastSeenUid: input.currentHighestUid,
        updatedAt: new Date(now).toISOString(),
      };
      const next = establishAt(cursors, index, established);

      const result: CursorResolution = existing
        ? { kind: 'uid-validity-changed', cursor: established, skippedMessageCount: input.currentMessageCount, previous: existing }
        : { kind: 'first-run', cursor: established, skippedMessageCount: input.currentMessageCount };
      return { next, result };
    });
  }

  /**
   * Resolve the GMAIL cursor to use for a label, given the `historyId` Gmail
   * reports right now. The mirror of `resolve()`, and the same rule:
   * establishing or re-establishing NEVER replays.
   *
   *  - No stored Gmail cursor -> `first-run`: established AT
   *    `currentHistoryId`. Deliberately not backfilled — the daemon starts
   *    listening now, it does not retroactively decide about mail that arrived
   *    before it was asked to. There is no skip count to report because
   *    `users.history.list` cannot say how many records lie below a historyId
   *    without asking for them, and asking for them is the backfill this
   *    refuses.
   *  - A valid stored Gmail cursor -> `resumed`, unchanged.
   *  - `historyExpired: true` -> `history-expired`: the stored position is
   *    discarded and re-established at `currentHistoryId`, and the discarded
   *    cursor comes back as `previous` for disclosure.
   *
   * WHY EXPIRY IS A FLAG ON THIS INPUT rather than a second
   * `resetGmailAfterHistoryExpiry()` method: the store cannot detect the
   * condition itself. Only Gmail can, by answering `users.history.list` with a
   * 404 for a `startHistoryId` that has aged out of its retention window, and
   * the caller is holding that answer. What the caller then needs is the same
   * thing it needed at start-up — "where do I resume from" — so it asks the
   * same question and gets a `GmailCursorResolution` it has to handle. A
   * separate reset method would be a second entry point into establishing a
   * position, callable without ever reading its result, and this file's whole
   * claim is that there is ONE implementation of what to do when we lost our
   * place.
   */
  async resolveGmail(input: {
    readonly account: string;
    readonly mailbox: string;
    /**
     * The mailbox's current `historyId`, as a decimal string exactly as Google
     * sent it — from `users.getProfile` or from the last delta. Never a number.
     */
    readonly currentHistoryId: string;
    /**
     * Set when Gmail answered `resync-required` (a 404 on the stored
     * `startHistoryId`). Any stored position is then discarded.
     */
    readonly historyExpired?: boolean | undefined;
  }): Promise<GmailCursorResolution> {
    // Refused rather than persisted: a historyId that fails validation on the
    // way in would be silently dropped on the way out by the load-time content
    // check, and the daemon would look like it had a position and have none.
    if (!isHistoryId(input.currentHistoryId)) {
      throw new Error(
        `Refusing to establish a Gmail cursor for ${input.account}:${input.mailbox} at ${JSON.stringify(input.currentHistoryId)}: not a decimal historyId.`,
      );
    }
    const now = this.now();
    return this.mutate(async (cursors) => {
      const index = indexOfKey(cursors, input.account, input.mailbox);
      const stored = index >= 0 ? (cursors[index] ?? null) : null;
      const existing = stored !== null && stored.source === 'gmail' ? stored : null;

      if (existing && input.historyExpired !== true) {
        return { next: cursors, result: { kind: 'resumed', cursor: existing } };
      }

      const established: GmailMailboxCursor = {
        source: 'gmail',
        account: input.account,
        mailbox: input.mailbox,
        historyId: input.currentHistoryId,
        updatedAt: new Date(now).toISOString(),
      };
      const next = establishAt(cursors, index, established);

      // `history-expired` stands exactly where `uid-validity-changed` stands,
      // and reaches the same establish-at-high-water-mark code path above.
      const result: GmailCursorResolution = existing
        ? { kind: 'history-expired', cursor: established, previous: existing }
        : { kind: 'first-run', cursor: established };
      return { next, result };
    });
  }

  /**
   * Advance the cursor after a message is FULLY processed — matched,
   * recorded, and notice dispatched or deliberately suppressed (§4). A crash
   * between fetch and this call means the cursor never moves, so the same
   * message is fetched again on recovery; dedup (§6) is what turns that
   * redelivery into a suppressed duplicate rather than a second notice.
   *
   * Requires a cursor already established via `resolve()` for this
   * (account, mailbox) under the SAME uidValidity; refuses rather than
   * silently accepting a stale write.
   */
  async advance(input: {
    readonly account: string;
    readonly mailbox: string;
    readonly uidValidity: number;
    readonly lastSeenUid: number;
  }): Promise<MailboxCursor> {
    const now = this.now();
    return this.mutate(async (cursors) => {
      const index = indexOfKey(cursors, input.account, input.mailbox);
      const stored = index >= 0 ? cursors[index] : undefined;
      const existing = stored !== undefined && stored.source === 'imap' ? stored : undefined;
      if (!existing) {
        throw new Error(`No IMAP cursor established for ${input.account}:${input.mailbox}; call resolve() first.`);
      }
      if (existing.uidValidity !== input.uidValidity) {
        throw new Error(
          `Cursor UIDVALIDITY mismatch for ${input.account}:${input.mailbox} (stored ${String(existing.uidValidity)}, reported ${String(input.uidValidity)}); re-resolve before advancing.`,
        );
      }
      const updated: ImapMailboxCursor = {
        ...existing,
        lastSeenUid: Math.max(existing.lastSeenUid, input.lastSeenUid),
        updatedAt: new Date(now).toISOString(),
      };
      const next = cursors.map((c, i) => (i === index ? updated : c));
      return { next, result: updated };
    });
  }

  /**
   * The Gmail mirror of `advance()`, with the same contract: called ONCE PER
   * MESSAGE and only after that message is fully processed, so a crash leaves
   * the cursor below the message and the next delta fetches it again.
   *
   * `historyId` is stored BYTE-IDENTICAL to what was handed in. It is never
   * parsed, never compared with `<` or `>`, and never round-tripped through
   * `Number`: `Number('18446744073709551615')` is `18446744073709552000`, and a
   * cursor that came back four hundred larger than it went in would silently
   * skip every message in between.
   */
  async advanceGmail(
    key: { readonly account: string; readonly mailbox: string },
    position: { readonly historyId: string },
  ): Promise<GmailMailboxCursor> {
    if (!isHistoryId(position.historyId)) {
      throw new Error(
        `Refusing to advance the Gmail cursor for ${key.account}:${key.mailbox} to ${JSON.stringify(position.historyId)}: not a decimal historyId.`,
      );
    }
    const now = this.now();
    return this.mutate(async (cursors) => {
      const index = indexOfKey(cursors, key.account, key.mailbox);
      const stored = index >= 0 ? cursors[index] : undefined;
      const existing = stored !== undefined && stored.source === 'gmail' ? stored : undefined;
      if (!existing) {
        throw new Error(`No Gmail cursor established for ${key.account}:${key.mailbox}; call resolveGmail() first.`);
      }
      // Never backwards, for the same reason `advance()` takes the max: a
      // cursor that moved down would re-deliver everything between the two
      // positions. The comparison is on the digit STRINGS — see
      // `compareHistoryIds`.
      const historyId = compareHistoryIds(position.historyId, existing.historyId) >= 0
        ? position.historyId
        : existing.historyId;
      const updated: GmailMailboxCursor = {
        ...existing,
        historyId,
        updatedAt: new Date(now).toISOString(),
      };
      const next = cursors.map((c, i) => (i === index ? updated : c));
      return { next, result: updated };
    });
  }

  /**
   * One housekeeping pass: drop malformed records, drop cursors for accounts
   * no longer configured, and enforce the defensive count cap (oldest by
   * `updatedAt` first). Idempotent and safe concurrently — recomputes every
   * removal from the file it just read.
   *
   * Deliberately source-BLIND. Every rule here reads only `account`, `mailbox`
   * and `updatedAt`, which both variants carry, so an unconfigured account's
   * Gmail cursor is reaped exactly as its IMAP one is. Narrowing to IMAP
   * anywhere in this method would quietly exempt Gmail records from the reap,
   * the cap and the disclosure all three.
   */
  async sweep(trigger: HousekeepingTrigger = 'manual'): Promise<CursorSweepReport> {
    const now = this.now();
    return this.mutate(async (cursors, malformed) => {
      const removed: CursorDiscard[] = [];
      if (malformed > 0) {
        removed.push({
          account: '(unknown)',
          mailbox: '(unknown)',
          reason: 'malformed',
          removedAt: now,
          note: `${String(malformed)} cursor record(s) failed content validation and were dropped`,
        });
      }

      let surviving = cursors;
      if (this.isAccountConfigured) {
        const kept: InboundSourceCursor[] = [];
        for (const cursor of cursors) {
          if (this.isAccountConfigured(cursor.account)) kept.push(cursor);
          else removed.push({ account: cursor.account, mailbox: cursor.mailbox, reason: 'account-not-configured', removedAt: now });
        }
        surviving = kept;
      }

      const sorted = [...surviving].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
      const overflow = sorted.length - this.policy.maxCursors;
      const final: InboundSourceCursor[] = [];
      for (let index = 0; index < sorted.length; index += 1) {
        const cursor = sorted[index];
        if (!cursor) continue;
        if (index < overflow) {
          removed.push({ account: cursor.account, mailbox: cursor.mailbox, reason: 'over-cap', removedAt: now });
          continue;
        }
        final.push(cursor);
      }

      return { next: final, result: { sweptAt: now, removed, retained: final.length } satisfies CursorSweepReport };
    });
  }

  async runRecoverySweep(): Promise<CursorSweepReport> {
    return this.sweep('recovery');
  }
}
