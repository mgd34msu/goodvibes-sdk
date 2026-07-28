/**
 * supervisor-status.ts — the shape `email.inbound.status` answers with.
 *
 * Split out of `supervisor.ts`, which sits on the repository's 800-line cap and
 * had no room left. The seam is not arbitrary: everything here is DISCLOSURE —
 * what a reader is told about cursors, retention, store health and the source
 * in force — while what remains in `supervisor.ts` is lifecycle: start, stop,
 * choose a source, hold its run loop, settle a status. The supervisor produces
 * these; nothing here produces anything the supervisor does not hand it.
 *
 * Re-exported from `supervisor.ts` so every existing import path keeps working
 * and the public surface does not move for a file split.
 */

import type { InboundCapabilityVerdict } from './ports.js';
import type { InboundMailHealthEntry } from './health.js';
import type { InboundMailSourceKind } from './source-selection.js';
import type { InboundMailboxWatcherStatus } from './watcher.js';
import type { InboundSourceCursor } from './source-cursor.js';

/**
 * Which source is in force, and what it costs.
 *
 * `latency` is carried as the SENTENCE `describeSourceLatency` produces rather
 * than as a raw number, because the whole reason `SourceLatency` is on the
 * interface is that "real-time" must never be claimed for a poll — and a
 * consumer handed `{ kind: 'poll', worstCaseMs }` is a consumer that can write
 * that sentence itself, wrongly.
 */
export interface InboundMailSourceReport {
  readonly kind: InboundMailSourceKind | null;
  /** `forced`, `google-adopted`, … or the refusal reason when nothing runs. */
  readonly basis: string;
  readonly detail: string;
  /** Empty string before a source exists to state its latency. */
  readonly latency: string;
}

/**
 * Whether a persisted store could be read, per store.
 *
 * Present on the snapshot because a store whose file would not parse is
 * DISCARDED (§9's "a torn record is discarded, not repaired", applied to the
 * file), and a discard nobody is told about is indistinguishable from data
 * loss. It is also the one fact that explains the state a reader is looking at:
 * a mailbox that resumed from nowhere, or an expectation book that is empty
 * when a workstream is waiting on it.
 */
export interface InboundMailStoreHealth {
  readonly store: 'cursors' | 'records' | 'expectations';
  readonly state:
    /** Read normally. */
    | 'ok'
    /** The file would not parse; its contents were discarded and the store is serving empty. */
    | 'discarded-unreadable'
    /** The store could not be read at all just now, so this snapshot omits it. */
    | 'unavailable';
  /** '' when `ok`; otherwise what went wrong, in the platform's own words. */
  readonly detail: string;
}

/** What a store retains, for the disclosure §9 requires. */
export interface InboundMailRetentionReport {
  readonly cursors: { readonly kept: number; readonly maxCursors: number };
  readonly records: {
    /** What a read serves: content-valid, inside the retention window, inside the count bound. */
    readonly kept: number;
    /**
     * What the FILE holds, malformed entries included.
     *
     * Reported beside `kept` because `kept` alone was the defect: it was
     * computed from `list()`, which filters, so a store holding ten records
     * under a `maxRecords: 2` policy disclosed "2". The owner was told the
     * store was bounded while it was not. Any gap between these two numbers is
     * records the next write or sweep will reap.
     */
    readonly stored: number;
    readonly retentionDays: number;
    readonly maxRecords: number;
    readonly maxBodyExcerptChars: number;
    /** Records write-time bounding removed since this daemon started — the §9.5 disclosure for a reap no sweep report can itemise. */
    readonly reapedOnWrite: number;
  };
  readonly expectations: { readonly open: number; readonly maxOpen: number };
  /** The last housekeeping pass this process ran, or null before the first. */
  readonly lastSweep: {
    readonly sweptAt: number;
    readonly trigger: string;
    readonly summary: string;
    /** Stores that pass could not sweep at all. Empty on a clean pass. */
    readonly failures: readonly string[];
  } | null;
}

/** One persisted cursor, as `email.inbound.status` discloses it. */
export interface DisclosedCursor {
  readonly account: string;
  readonly mailbox: string;
  readonly source: InboundSourceCursor['source'];
  /**
   * The position, as a string on both sources.
   *
   * A Gmail `historyId` is a decimal uint64 that must never be parsed to a
   * number, and an IMAP position is two numbers rather than one, so a single
   * numeric field could only be wrong for one of them.
   */
  readonly position: string;
  readonly updatedAt: string;
  readonly ageMs: number;
}

/** The whole disclosure `email.inbound.status` answers with. */
export interface InboundMailStatusSnapshot {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly mode: InboundMailboxWatcherStatus['mode'];
  readonly reason: string;
  readonly account: string;
  readonly mailbox: string;
  readonly source: InboundMailSourceReport;
  readonly capability: InboundCapabilityVerdict | null;
  readonly cursors: readonly DisclosedCursor[];
  readonly expectations: readonly {
    readonly id: string;
    readonly serviceDomain: string;
    readonly recipientAddress: string;
    readonly purpose: string;
    readonly openedAt: string;
    readonly expiresAt: string;
    readonly remainingMs: number;
  }[];
  readonly retention: InboundMailRetentionReport;
  /** One entry per persisted store, always all three. See `InboundMailStoreHealth`. */
  readonly stores: readonly InboundMailStoreHealth[];
  /**
   * Whether arriving mail is reaching the owner, and what is stopping it.
   *
   * `state: 'ok'` means notices are getting through OR nothing has been refused
   * yet — deliberately one value, because "nothing refused" and "refusals
   * cleared" are the same fact about right now. `state: 'refused'` carries the
   * condition, its remedial step, when it started and how many messages have
   * been recorded without a notice under it. A capability quietly demoted to a
   * recorder is precisely what this field exists to make unmissable.
   */
  readonly noticeDelivery:
    | { readonly state: 'ok' }
    | {
      readonly state: 'refused';
      readonly reason: string;
      readonly detail: string;
      readonly fix: string;
      readonly since: string;
      readonly unannounced: number;
    };
  readonly health: InboundMailHealthEntry;
}


export function discloseCursor(cursor: InboundSourceCursor, now: number): DisclosedCursor {
  const updatedAt = Date.parse(cursor.updatedAt);
  return {
    account: cursor.account,
    mailbox: cursor.mailbox,
    source: cursor.source,
    position: cursor.source === 'gmail'
      ? `historyId ${cursor.historyId}`
      : `UIDVALIDITY ${String(cursor.uidValidity)} / UID ${String(cursor.lastSeenUid)}`,
    updatedAt: cursor.updatedAt,
    ageMs: Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : 0,
  };
}
