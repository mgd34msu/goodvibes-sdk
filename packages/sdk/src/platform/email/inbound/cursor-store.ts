/**
 * cursor-store.ts — the durable per-mailbox IMAP cursor (docs/inbound-email.md §4).
 *
 * `EXAMINE` + `BODY.PEEK` means the daemon never marks anything `\Seen`, so
 * `SEARCH UNSEEN` would return the same messages forever and "have I handled
 * this?" cannot be asked of the server. This store keeps the daemon's own
 * answer: one record per (account, mailbox), so the file cannot grow with
 * mail traffic.
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
 *  3. Validate by content — `uidValidity` and `lastSeenUid` must be positive
 *     / non-negative integers (see the note on `lastSeenUid` below),
 *     `updatedAt` a parseable ISO date, `mailbox` and `account` non-empty and
 *     length-bounded strings. A record failing ANY check is discarded, not
 *     repaired: a corrupt cursor silently coerced to 0 would replay the
 *     entire mailbox at the owner.
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
  isNonEmptyTrimmedString,
  isNonNegativeInteger,
  isParsableIsoDate,
  isPositiveInteger,
  type HousekeepingTrigger,
  type MailboxCursor,
} from './types.js';

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
  readonly cursors: readonly MailboxCursor[];
}

/**
 * Validate a cursor by its parsed content, not by its presence in the file.
 * Returns `null` for anything torn, oversized, or out of range. Never
 * throws, never repairs.
 */
export function validateMailboxCursor(value: unknown): MailboxCursor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isNonEmptyTrimmedString(record.account, 256)) return null;
  if (!isNonEmptyTrimmedString(record.mailbox, 512)) return null;
  if (!isPositiveInteger(record.uidValidity)) return null;
  // See the header note: lastSeenUid is legitimately 0 on a first run against
  // an empty mailbox, so this is non-negative rather than strictly positive.
  if (!isNonNegativeInteger(record.lastSeenUid)) return null;
  if (!isParsableIsoDate(record.updatedAt)) return null;
  return {
    account: (record.account as string).trim(),
    mailbox: (record.mailbox as string).trim(),
    uidValidity: record.uidValidity as number,
    lastSeenUid: record.lastSeenUid as number,
    updatedAt: record.updatedAt as string,
  };
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

  private async readWithDrops(): Promise<{ cursors: MailboxCursor[]; malformed: number }> {
    const raw = await this.store.load();
    if (!raw || typeof raw !== 'object') return { cursors: [], malformed: 0 };
    const rawCursors = Array.isArray(raw.cursors) ? raw.cursors : [];
    const cursors = rawCursors.map(validateMailboxCursor).filter((c): c is MailboxCursor => c !== null);
    return { cursors, malformed: rawCursors.length - cursors.length };
  }

  private async mutate<T>(
    fn: (cursors: MailboxCursor[], malformed: number) => Promise<{ next: MailboxCursor[]; result: T }>,
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
  async list(): Promise<readonly MailboxCursor[]> {
    const { cursors } = await this.readWithDrops();
    return this.isAccountConfigured ? cursors.filter((c) => this.isAccountConfigured!(c.account)) : cursors;
  }

  async get(account: string, mailbox: string): Promise<MailboxCursor | null> {
    const cursors = await this.list();
    return cursors.find((c) => c.account === account && c.mailbox === mailbox) ?? null;
  }

  /**
   * Resolve the cursor to use for a mailbox given what the server reports
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
      const existingIndex = cursors.findIndex((c) => c.account === input.account && c.mailbox === input.mailbox);
      const existing = existingIndex >= 0 ? (cursors[existingIndex] ?? null) : null;

      if (existing && existing.uidValidity === input.serverUidValidity) {
        return { next: cursors, result: { kind: 'resumed', cursor: existing, skippedMessageCount: 0 } };
      }

      const established: MailboxCursor = {
        account: input.account,
        mailbox: input.mailbox,
        uidValidity: input.serverUidValidity,
        lastSeenUid: input.currentHighestUid,
        updatedAt: new Date(now).toISOString(),
      };
      const next = existingIndex >= 0
        ? cursors.map((c, i) => (i === existingIndex ? established : c))
        : [...cursors, established];

      const result: CursorResolution = existing
        ? { kind: 'uid-validity-changed', cursor: established, skippedMessageCount: input.currentMessageCount, previous: existing }
        : { kind: 'first-run', cursor: established, skippedMessageCount: input.currentMessageCount };
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
      const index = cursors.findIndex((c) => c.account === input.account && c.mailbox === input.mailbox);
      const existing = index >= 0 ? cursors[index] : undefined;
      if (!existing) {
        throw new Error(`No cursor established for ${input.account}:${input.mailbox}; call resolve() first.`);
      }
      if (existing.uidValidity !== input.uidValidity) {
        throw new Error(
          `Cursor UIDVALIDITY mismatch for ${input.account}:${input.mailbox} (stored ${String(existing.uidValidity)}, reported ${String(input.uidValidity)}); re-resolve before advancing.`,
        );
      }
      const updated: MailboxCursor = {
        ...existing,
        lastSeenUid: Math.max(existing.lastSeenUid, input.lastSeenUid),
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
        const kept: MailboxCursor[] = [];
        for (const cursor of cursors) {
          if (this.isAccountConfigured(cursor.account)) kept.push(cursor);
          else removed.push({ account: cursor.account, mailbox: cursor.mailbox, reason: 'account-not-configured', removedAt: now });
        }
        surviving = kept;
      }

      const sorted = [...surviving].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
      const overflow = sorted.length - this.policy.maxCursors;
      const final: MailboxCursor[] = [];
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
