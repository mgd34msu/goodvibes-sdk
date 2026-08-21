/**
 * transcript-journal-replay.ts, folding a transcript journal back into a live
 * conversation at resume.
 *
 * transcript-journal.ts owns the file: append, replay, quarantine, rotate. This
 * owns what a surface does with what came back, apply it to the conversation it
 * just hydrated, persist the result so the gap is closed for good, and rotate
 * the journal that filled it.
 *
 * Recovery protocol
 * ─────────────────
 * 1. Call replayJournal() with the journal path and the snapshot timestamp.
 * 2. If no records are newer than the snapshot, rotate the (now-stale) journal
 *    silently and return.
 * 3. If records are found, apply the final record's messages, each journal
 *    record carries the full conversation snapshot at that moment, so the record
 *    with the newest timestamp is the authoritative post-crash state (resilient
 *    to seq collisions across re-inits onto a stale journal file).
 * 4. Rebuild the conversation history and call the snapshot writer so the gap is
 *    durably closed before the user sees the restored conversation.
 * 5. Rotate the journal (it is no longer needed as a gap-filler).
 * 6. Return a result so the caller can emit an honest notice.
 *
 * The conversation and the snapshot writer are both injected: this decides WHAT
 * the restored state is, never where a surface keeps its sessions.
 */

import { journalPathFor, openTranscriptJournal, replayJournal } from './transcript-journal.js';
import type { ConversationManager, ConversationMessageSnapshot } from '../core/conversation.js';
import type { SessionSurface } from './session-surface.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * What replay needs a conversation to be able to do.
 *
 * `rebuildHistory` is optional because it is a RENDERING concern: a surface that
 * paints a transcript re-lays it out after the messages change, and a headless
 * one has nothing to rebuild.
 */
export type JournalReplayConversation =
  Pick<ConversationManager, 'toJSON' | 'fromJSON' | 'title' | 'getTitleSource'> & {
    rebuildHistory?: () => void;
  };

export interface ReplayIntoConversationOptions {
  /** Absolute path to the journal file for this session. */
  readonly journalPath: string;
  /**
   * The `timestamp` field from the loaded session snapshot (SessionMeta).
   * Only journal records with ts > snapshotTimestamp are replayed.
   */
  readonly snapshotTimestamp: number;
  /** The live conversation to mutate with replayed messages. */
  readonly conversation: JournalReplayConversation;
  /** Session ID, used when creating the post-replay journal instance for rotate(). */
  readonly sessionId: string;
  /**
   * Persist the restored conversation so the gap is durably closed.
   * Called with the final replayed message list. Best-effort, failures
   * are swallowed so recovery never hard-fails a resume.
   */
  readonly persistSnapshot: (messages: ConversationMessageSnapshot[]) => void;
}

export interface ReplayIntoConversationResult {
  /** Number of journal records that post-dated the snapshot. 0 if nothing to replay. */
  readonly replayed: number;
  /** True if the journal tail was corrupt (quarantined). */
  readonly hadCorruptTail: boolean;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Replay journal records newer than `snapshotTimestamp` onto `conversation`.
 *
 * Returns a result object so the caller can emit an appropriate notice.
 * Never throws, all errors are swallowed to preserve the "best-effort"
 * recovery contract.
 */
export function replayJournalIntoConversation(
  options: ReplayIntoConversationOptions,
): ReplayIntoConversationResult {
  const { journalPath, snapshotTimestamp, conversation, sessionId, persistSnapshot } = options;

  try {
    const { records, hadCorruptTail } = replayJournal(journalPath, snapshotTimestamp);

    const journal = openTranscriptJournal(journalPath, sessionId);

    if (records.length === 0) {
      // Nothing to replay, rotate the (now-stale) journal silently.
      journal.rotate();
      return { replayed: 0, hadCorruptTail };
    }

    // Select the authoritative record by newest wall-clock timestamp (tie-broken
    // by highest seq). Each record carries the full conversation snapshot at its
    // moment, so the newest ts is by definition the most recent state. This is
    // resilient to seq collisions that arise when a fresh process appends to a
    // pre-existing, non-rotated journal: its records restart at seq 0 after the
    // surviving old records, so "last by seq" could otherwise pick a stale one.
    const lastRecord = records.reduce((newest, candidate) =>
      candidate.ts > newest.ts ||
      (candidate.ts === newest.ts && candidate.seq > newest.seq)
        ? candidate
        : newest,
    );
    const replayedMessages = lastRecord.messages;

    // Preserve the session identity (title/titleSource/branches/currentBranch)
    // that the resume seam already hydrated onto the live conversation. Journal
    // records carry only messages, so a bare fromJSON would blank the title and
    // reset titleSource to the system default, and the next TURN_COMPLETED
    // snapshot would then persist the empty title, making the loss permanent.
    const preserved = conversation.toJSON();
    conversation.fromJSON({
      ...preserved,
      messages: replayedMessages as never[],
      title: conversation.title,
      titleSource: conversation.getTitleSource(),
    });
    conversation.rebuildHistory?.();

    // Write a fresh snapshot so the gap is durably closed even if the
    // process is killed again before the next turn-complete snapshot.
    try {
      persistSnapshot(replayedMessages);
    } catch {
      // Best-effort, never hard-fail recovery due to snapshot write failure.
    }

    // Rotate the journal, it is no longer needed as a gap-filler.
    journal.rotate();

    return { replayed: records.length, hadCorruptTail };
  } catch {
    // Absolute last-resort guard, recovery must never crash a resume.
    return { replayed: 0, hadCorruptTail: false };
  }
}

/**
 * Build the journal path for a session off the surface that owns it, then call
 * {@link replayJournalIntoConversation}.
 */
export function replayJournalForSession(
  options: Omit<ReplayIntoConversationOptions, 'journalPath'> & {
    readonly surface: SessionSurface;
  },
): ReplayIntoConversationResult {
  const journalPath = journalPathFor(options.surface, options.sessionId);
  return replayJournalIntoConversation({ ...options, journalPath });
}
