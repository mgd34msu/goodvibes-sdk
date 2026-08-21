/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * recovery-snapshot-apply.ts, restoring a crash-recovery snapshot the user
 * explicitly asked for.
 *
 * transcript-journal-replay.ts (this file's sibling) folds a journal tail onto
 * a conversation that was already hydrated from the session store. This handles
 * the case that store cannot: a session that crashed before its first clean
 * save has no entry to hydrate FROM, so the recovery snapshot is the whole
 * conversation rather than a gap-filler on top of one.
 *
 * What lives here and what does not
 * ─────────────────────────────────
 * Here: read the snapshot, retire it, check what came back is a conversation,
 * put it on the live conversation, fold in any journal records newer than it,
 * and report how many messages ended up there.
 *
 * Not here: WHETHER to restore. That is a question for the user, asked in
 * whatever idiom a surface has, a terminal modal, a chat reply, an operator
 * verb. A surface writes its own ask and calls this with the answer.
 *
 * Why the ask cannot be skipped
 * ─────────────────────────────
 * A recovery snapshot is a conversation the user has not seen since the process
 * died. Loading one without being asked replaces whatever they are looking at
 * with state from a crash they may not know happened, so the standing rule is
 * ask-then-retire and never auto-load.
 *
 * Two things here make that structural rather than a convention each surface
 * re-implements:
 *
 *  1. {@link applyRecoverySnapshot} will not run without a
 *     {@link RecoveryRestoreConfirmation}, and the only way to obtain one is
 *     {@link confirmRecoveryRestore}, whose single argument is the answer the
 *     user gave. There is no flag, no config key, and no default that produces
 *     one, a caller that has not asked has nothing to pass.
 *  2. Retirement happens INSIDE this function, via `consumeRecovery`'s
 *     load-then-delete. A caller cannot apply a snapshot and keep it: applying
 *     is the same operation as retiring it. That closes the hand-rolled
 *     "load, apply, forget to delete" sequence, which is how the same crash
 *     conversation gets offered again on the next launch.
 */

import { consumeRecovery } from './session-recovery.js';
import { replayJournalForSession, type ReplayIntoConversationResult } from './transcript-journal-replay.js';
import type { ConversationManager, ConversationMessageSnapshot } from '../core/conversation.js';
import type { SessionSurface } from './session-surface.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

// ─── The user's answer ──────────────────────────────────────────────────────

declare const recoveryRestoreConfirmationBrand: unique symbol;

/**
 * Proof that a user was asked whether to restore a recovery snapshot and said
 * yes. Cannot be constructed by a literal, {@link confirmRecoveryRestore} is
 * the only source.
 */
export interface RecoveryRestoreConfirmation {
  readonly [recoveryRestoreConfirmationBrand]: true;
}

/**
 * Turn a user's answer into the token {@link applyRecoverySnapshot} requires.
 *
 * Call this with the result of an actual question put to the user. `false`
 * yields null, so a surface that passes an unanswered or declined prompt
 * straight through gets nothing to apply with.
 *
 * @param userSaidYes - What the user answered. Not a setting, not a default.
 */
export function confirmRecoveryRestore(userSaidYes: boolean): RecoveryRestoreConfirmation | null {
  return userSaidYes ? ({} as RecoveryRestoreConfirmation) : null;
}

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * What restoring needs a conversation to be able to do.
 *
 * `rebuildHistory` is optional for the same reason it is in journal replay: it
 * is a rendering concern, and a headless surface has nothing to re-lay-out.
 */
export type RestorableConversation =
  Pick<ConversationManager, 'resetAll' | 'toJSON' | 'fromJSON' | 'title' | 'getTitleSource' | 'getMessageCount'> & {
    rebuildHistory?: () => void;
  };

export interface ApplyRecoverySnapshotOptions {
  /** The surface that owns the session's storage, where the snapshot and journal live. */
  readonly surface: SessionSurface;
  /** The session whose recovery snapshot is being restored. */
  readonly sessionId: string;
  /** The live conversation to restore into. */
  readonly conversation: RestorableConversation;
  /**
   * Persist the restored conversation so the gap is durably closed. Best-effort
   *, a failure here does not fail the restore, the same contract journal
   * replay keeps.
   */
  readonly persistSnapshot: (messages: ConversationMessageSnapshot[]) => void;
  /** The user's answer, from {@link confirmRecoveryRestore}. */
  readonly confirmation: RecoveryRestoreConfirmation;
}

/** Why a restore did not happen. Each value is a fact a surface can report as-is. */
export type RecoveryApplyRefusal =
  /** Nothing was on disk to consume, or the file could not be read. The snapshot, if any, was left alone. */
  | 'no-snapshot'
  /** A snapshot loaded but did not contain a conversation. It was already retired by the load. */
  | 'unusable-snapshot'
  /** The conversation rejected the restored state. The snapshot was already retired by the load. */
  | 'apply-failed';

export interface ApplyRecoverySnapshotResult {
  /** True when the conversation now holds the recovered messages. */
  readonly applied: boolean;
  /** Set when `applied` is false. */
  readonly refusal?: RecoveryApplyRefusal | undefined;
  /**
   * True once the snapshot file is gone. Always true after a successful apply,
   * and true for the refusals that follow a successful load, the read is what
   * retires the file, so a snapshot that loaded is retired whether or not its
   * contents turned out to be usable.
   */
  readonly retired: boolean;
  /** Messages the conversation holds once the snapshot (plus any journal tail) is in place. 0 when nothing was applied. */
  readonly messageCount: number;
  /** Journal records that post-dated the snapshot and were folded in on top of it. */
  readonly journalReplay: ReplayIntoConversationResult;
}

const NOTHING_REPLAYED: ReplayIntoConversationResult = { replayed: 0, hadCorruptTail: false };

// ─── Content validation ─────────────────────────────────────────────────────

/**
 * What a loaded snapshot has to carry to be worth applying.
 *
 * `consumeRecovery` already guarantees the file parsed as JSON. This is the
 * next question: is what parsed actually a conversation? A snapshot truncated
 * mid-write parses into an object with no usable `messages`, and applying that
 * resets a live conversation to nothing, the restore would destroy exactly
 * what the user asked to get back.
 *
 * An EMPTY messages array counts as unusable, not as an empty conversation:
 * `writeRecoveryFile` refuses to write a snapshot with no messages, so zero
 * messages can only mean the file lost them, the parser yields `[]` for a
 * file too short to hold a meta line plus one message.
 */
function readRestorableMessages(snapshot: unknown): ConversationMessageSnapshot[] | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const messages = (snapshot as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  // Every element must be an object. A messages array holding strings or nulls
  // is a file that got corrupted into a shape that would pass a bare
  // Array.isArray check and then fail deep inside rendering.
  if (!messages.every((entry) => entry !== null && typeof entry === 'object')) return null;
  return messages as ConversationMessageSnapshot[];
}

function readOptionalString(snapshot: unknown, key: string): string | undefined {
  const value = (snapshot as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readOptionalNumber(snapshot: unknown, key: string): number | undefined {
  const value = (snapshot as Record<string, unknown> | null)?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Restore the recovery snapshot the user asked for, retiring it in the process.
 *
 * The sequence is the one a normal resume runs, reset, fromJSON,
 * rebuildHistory, then fold in journal records newer than the snapshot, with
 * the messages coming from the retired recovery file instead of the session
 * store.
 *
 * Never throws: a failed restore reports a refusal so the surface can say what
 * happened, because a crash-recovery path that itself crashes takes the boot
 * down with it.
 */
export function applyRecoverySnapshot(options: ApplyRecoverySnapshotOptions): ApplyRecoverySnapshotResult {
  const { surface, sessionId, conversation, persistSnapshot } = options;

  // Reading the snapshot is what retires it: consumeRecovery deletes the file
  // only after a successful load, so a read failure leaves it on disk to be
  // offered again rather than destroying state that was never recovered.
  const { snapshot, consumed } = consumeRecovery(surface, sessionId);
  if (!snapshot || !consumed) {
    return { applied: false, refusal: 'no-snapshot', retired: false, messageCount: 0, journalReplay: NOTHING_REPLAYED };
  }

  const messages = readRestorableMessages(snapshot);
  if (!messages) {
    logger.warn('[Recovery] Snapshot loaded but carried no conversation, nothing was applied', { sessionId });
    return {
      applied: false,
      refusal: 'unusable-snapshot',
      retired: true,
      messageCount: 0,
      journalReplay: NOTHING_REPLAYED,
    };
  }

  try {
    conversation.resetAll();
    conversation.fromJSON({
      messages: messages as never[],
      title: readOptionalString(snapshot, 'title'),
      titleSource: readOptionalString(snapshot, 'titleSource') as never,
    });
    conversation.rebuildHistory?.();
  } catch (error) {
    logger.warn('[Recovery] Conversation rejected the restored snapshot', { sessionId, error: summarizeError(error) });
    return {
      applied: false,
      refusal: 'apply-failed',
      retired: true,
      messageCount: 0,
      journalReplay: NOTHING_REPLAYED,
    };
  }

  // Anything the journal recorded after the snapshot was written goes on top,
  // so a restore is never older than the last thing the process managed to log.
  const journalReplay = replayJournalForSession({
    surface,
    sessionId,
    snapshotTimestamp: readOptionalNumber(snapshot, 'timestamp') ?? 0,
    conversation,
    persistSnapshot,
  });

  return {
    applied: true,
    retired: true,
    messageCount: conversation.getMessageCount(),
    journalReplay,
  };
}
