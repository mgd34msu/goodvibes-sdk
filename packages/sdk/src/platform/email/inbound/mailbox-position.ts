/**
 * Where a mailbox currently ends, and how we came to know it.
 *
 * One question — "what is the highest UID in this mailbox right now?" — asked
 * before any cursor is resolved, because its answer is the mark a first run
 * starts listening from and the mark a changed `UIDVALIDITY` re-establishes
 * at. Get it wrong downwards and the next drain replays the mailbox.
 *
 * Why this is a file rather than a method on the watcher
 * ─────────────────────────────────────────────────────
 * The same seam `poll-loop.ts` already sits on. That file knows how to ask the
 * server what arrived and returns a `MailboxDeltaReport`; the watcher decides
 * what a failed drain MEANS for the capability verdict. This file is the same
 * split applied to the position question: it knows the protocol, it does not
 * know the verdict vocabulary, and it records nothing and announces nothing.
 * `MailboxStartPosition` is a discriminated union for that reason — a caller
 * cannot read "we could not establish a position" as a position, because the
 * successful case is the only member carrying one.
 *
 * The rule this file exists to hold
 * ─────────────────────────────────
 * **A missing `UIDNEXT` is derived, never assumed to be zero.**
 *
 * The high-water mark is normally `UIDNEXT - 1`: the next arriving message
 * gets `UIDNEXT`, so everything at or below it already exists. That reading is
 * right and it is cheap — one field the server already sent — so when
 * `UIDNEXT` is present nothing else is asked.
 *
 * It can be absent. `[UIDNEXT n]` on `EXAMINE` is a SHOULD in RFC 3501, not a
 * MUST, and `parseMailboxStatus` types it `number | null` precisely because
 * servers omit it. Read through `(status.uidNext ?? 1) - 1` that omission
 * becomes the mark 0, and 0 is below every message that exists: the first
 * drain searches `UID 1:*`, matches the whole mailbox, and delivers every
 * message in it to the owner's notification channel as new mail — while the
 * note just emitted says `${n} message(s) already in the mailbox were not
 * read` and `starts listening now rather than backfilling`. Three false
 * clauses and a year of old mail, from one `??`.
 *
 * So an absent `UIDNEXT` asks instead of assuming. `UID SEARCH UID 1:*` is the
 * same question — which UIDs does this mailbox hold — put directly, and it
 * goes through `searchAboveCursor`, the function the drain already uses,
 * rather than a second search-and-parse written here. Its highest answer is
 * the mark, and its COUNT is authoritative for the skipped total in a way
 * `EXISTS` is not: a server terse enough to omit `UIDNEXT` may have omitted
 * `EXISTS` too, and `exists ?? 0` would then make the note claim 0 messages
 * were skipped while skipping several.
 *
 * Deriving rather than refusing, and why that is not the softer choice:
 * refusing is right for a missing `UIDVALIDITY` (ruling 15) because nothing
 * can supply one. `UIDNEXT` is different — the information is a core
 * `UID SEARCH` away, and refusing would take inbound mail away from every
 * conforming-but-terse server over a field the RFC never required them to
 * send. What is NOT acceptable either way is establishing at 0 silently, and
 * no path below does.
 */

import { searchAboveCursor } from './poll-loop.js';
import type { MailboxOpenReport, MailboxWire } from './ports.js';

/** The mailbox facts `EXAMINE` reported, as the connection recorded them. */
type MailboxStatus = MailboxOpenReport['mailbox'];

export type MailboxStartPosition =
  | {
    readonly outcome: 'established';
    /** Everything at or below this already exists and is not new mail. */
    readonly highestUid: number;
    /** How many messages are being skipped, for the cursor note. */
    readonly messageCount: number;
    /**
     * Appended to the cursor note so it describes how the mark was reached.
     *
     * Empty when the server reported `UIDNEXT` and nothing needs saying. When
     * the mark was derived it is NOT empty, because a cursor established by
     * asking has a materially different provenance from one the server
     * volunteered, and a note that read identically either way would be
     * hiding the more interesting of the two cases.
     */
    readonly disclosure: string;
  }
  | {
    /**
     * The search itself failed. The caller classifies it — a refused `SEARCH`
     * is routinely transient and must stay a reconnect rather than becoming a
     * capability verdict (§13.1), which is a policy decision this file
     * deliberately does not make.
     */
    readonly outcome: 'search-failed';
    readonly error: unknown;
  }
  | {
    /**
     * The server answered successfully and named nothing, on a mailbox its own
     * `EXISTS` says holds messages. The two answers contradict each other and
     * the only mark available from here is 0 — which would replay everything.
     */
    readonly outcome: 'position-unknown';
    readonly detail: string;
  };

export interface MailboxPositionDeps {
  readonly status: MailboxStatus;
  readonly wire: MailboxWire;
  /** Only for the failure text, so the owner is told which mailbox it was. */
  readonly mailbox: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/** Answer "where does this mailbox end", asking only when the server did not say. */
export async function resolveMailboxStartPosition(
  deps: MailboxPositionDeps,
): Promise<MailboxStartPosition> {
  const { status } = deps;
  if (status.uidNext !== null) {
    return {
      outcome: 'established',
      highestUid: Math.max(0, status.uidNext - 1),
      messageCount: status.exists ?? 0,
      disclosure: '',
    };
  }

  let uids: number[];
  try {
    // Cursor 0, so the range is `UID 1:*` — every UID in the mailbox.
    uids = await searchAboveCursor(deps.wire, 0, {
      timeoutMs: deps.timeoutMs,
      signal: deps.signal,
    });
  } catch (error) {
    return { outcome: 'search-failed', error };
  }

  const exists = status.exists ?? 0;
  if (uids.length === 0 && exists > 0) {
    return {
      outcome: 'position-unknown',
      detail:
        `The server opened '${deps.mailbox}' without reporting a UIDNEXT, and a UID SEARCH over `
        + `the whole mailbox then returned no UIDs while the same connection reported `
        + `${String(exists)} message(s) present. There is no highest UID to start from, and `
        + 'starting from 0 would announce everything already in the mailbox as new mail.',
    };
  }

  // Ascending, so the last is the highest. An empty answer here is a genuinely
  // empty mailbox — `exists` agrees — and 0 is then the correct mark rather
  // than a fallback: there is nothing below it to skip over.
  const highestUid = uids[uids.length - 1] ?? 0;
  return {
    outcome: 'established',
    highestUid,
    messageCount: uids.length,
    disclosure:
      ' The server opened this mailbox without reporting a UIDNEXT, which RFC 3501 recommends '
      + 'rather than requires, so the highest UID present was established by asking the server '
      + `for it (UID SEARCH) rather than assumed — it answered ${String(uids.length)} message(s), `
      + `the highest being UID ${String(highestUid)}. The count above comes from that same answer.`,
  };
}
