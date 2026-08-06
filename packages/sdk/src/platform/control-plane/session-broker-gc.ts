import type { SharedSessionInputRecord } from './session-intents.js';
import type { SharedSessionMessage, SharedSessionRecord } from './session-types.js';
import { withSessionCloseReason } from './session-broker-sessions.js';
import { logger } from '../utils/logger.js';

export interface SharedSessionGcStore {
  readonly sessions: Map<string, SharedSessionRecord>;
  readonly messages: Map<string, SharedSessionMessage[]>;
  readonly inputs: Map<string, SharedSessionInputRecord[]>;
}

export interface SharedSessionGcOptions {
  readonly idleEmptyMs: number;
  readonly idleLongMs: number;
  /**
   * Age (ms since closedAt) at which a CLOSED session's record + bodies are
   * PERMANENTLY deleted from the store. Closed sessions are HISTORY: by default
   * this is `Number.POSITIVE_INFINITY` (retain indefinitely — a closed session
   * is never swept off disk), and deletion happens only when a caller opts into
   * a finite retention window or invokes an explicit delete verb.
   *
   * NOTE ON MEMORY vs PERSISTENCE (divergence from the companion manager):
   * the broker's durable store is a FULL SNAPSHOT of these in-memory maps
   * (createSessionBrokerSnapshot), so there is no separate "memory handle" to
   * evict independently of disk — dropping a closed session's bodies from these
   * maps would also drop them from the next persisted snapshot. Retention is
   * therefore all-or-nothing here: retained closed sessions stay both listable
   * and on disk; memory stays bounded by the per-session message cap
   * (MAX_PERSISTED_MESSAGES_PER_SESSION) rather than by body eviction.
   */
  readonly deletionRetentionMs: number;
  readonly publishUpdate: (event: string, payload: unknown) => void;
  /**
   * Liveness probe for a session whose work runs somewhere these records cannot
   * see. Returns true while that work is genuinely in flight.
   *
   * Why this exists: the reaper used to judge liveness ONLY by signals a
   * locally-executed turn emits — `lastActivityAt`, `activeAgentId`,
   * `pendingInputCount`, participant heartbeats. A HOSTED turn emits none of
   * them while it runs: its transcript lives on the hosted record, so the
   * broker's `messageCount` stays 0 (judging the session against the 10-minute
   * idleEmptyMs window rather than the 24-hour one), and its heartbeat is
   * driven by an intake tick that is itself blocked awaiting the turn. The
   * observed result was a session closed 'idle-reaped' at 21:45Z whose turn
   * demonstrably went on running until 22:26Z — the record contradicted the
   * work.
   *
   * So liveness is no longer inferred solely from what this store happens to
   * have been told. A subsystem that runs turns out of the broker's sight
   * supplies this probe and gets asked directly.
   */
  readonly isExternallyLive?: ((session: SharedSessionRecord) => boolean) | undefined;
}

export function sweepSharedSessions(store: SharedSessionGcStore, options: SharedSessionGcOptions): boolean {
  const now = Date.now();
  let anyChanged = false;
  for (const [sessionId, session] of store.sessions.entries()) {
    if (session.status === 'closed') {
      // History by default. Only an explicit FINITE retention window authorizes
      // permanent deletion; the default POSITIVE_INFINITY never trips this and
      // the closed record stays listable (includeClosed) and on disk forever.
      const closedAt = session.closedAt ?? session.updatedAt;
      if (Number.isFinite(options.deletionRetentionMs) && now - closedAt >= options.deletionRetentionMs) {
        store.sessions.delete(sessionId);
        store.messages.delete(sessionId);
        store.inputs.delete(sessionId);
        anyChanged = true;
      }
      continue;
    }

    const reason = idleCloseReason(session, now, options);
    if (!reason) continue;
    const closed: SharedSessionRecord = {
      ...session,
      status: 'closed',
      activeAgentId: undefined,
      updatedAt: now,
      closedAt: now,
      // Record that the SYSTEM reaper closed this (not a user/surface action) so a
      // subsequent register heartbeat auto-reopens it (honest reopen semantics).
      metadata: withSessionCloseReason(session.metadata, 'idle-reaped'),
    };
    store.sessions.set(sessionId, closed);
    options.publishUpdate('session-closed', { ...closed, reason });
    anyChanged = true;
  }
  return anyChanged;
}

/** One session the boot sweep closed, for the caller to disclose. */
export interface OrphanedSessionClosure {
  readonly sessionId: string;
  readonly kind: string;
  readonly messageCount: number;
  /** How long the record had been sitting active, in ms, at sweep time. */
  readonly staleForMs: number;
}

/** What the boot sweep needs to decide a session is an orphan. */
export interface BootOrphanSweepOptions {
  readonly idleEmptyMs: number;
  readonly idleLongMs: number;
  readonly now?: number;
}

/**
 * Close sessions a dead process left behind, at the boot that finds them.
 *
 * The case: a pty-forked second instance died without closing its session and
 * left a record reading `status: 'active'`, 0 messages — permanently, because
 * nothing ever revisited it with the right verdict.
 *
 * NOT "every active session at boot". A session deliberately SURVIVES a daemon
 * restart: surfaces outlive the daemon, re-register on their next heartbeat,
 * and their sessions are expected to still be listed active afterwards.
 * Closing all of them would have broken that contract (and did — two existing
 * restart tests caught it). So the predicate is the same one the idle reaper
 * uses: a session already past its idle window at the moment the store is
 * loaded, with no message traffic and no fresh participant, is an orphan.
 * Anything newer than its window is a live session mid-restart and is left
 * alone.
 *
 * The value over waiting for the periodic reaper is honesty and timing. The
 * reaper runs on a 60s timer and would eventually close the ghost as
 * 'idle-reaped' — which says the conversation went quiet, when what actually
 * happened is the process holding it died. This closes it at boot and says so.
 *
 * Records are CLOSED WITH A REASON, never deleted: silent deletion is
 * indistinguishable from data loss. And `'boot-orphaned'` is a SYSTEM close, so
 * a surface that really is still alive reopens automatically on its next
 * register heartbeat (see isSystemClosedSession) — a false positive costs one
 * reopen, never a conversation.
 */
export function closeOrphanedSessionsAtBoot(
  sessions: Map<string, SharedSessionRecord>,
  options: BootOrphanSweepOptions,
): OrphanedSessionClosure[] {
  const now = options.now ?? Date.now();
  const closed: OrphanedSessionClosure[] = [];
  for (const [sessionId, session] of sessions.entries()) {
    if (session.status !== 'active') continue;
    // Same liveness bar as the running reaper — see the doc comment above for
    // why "active at boot" on its own is NOT evidence of an orphan.
    if (!idleCloseReason(session, now, {
      idleEmptyMs: options.idleEmptyMs,
      idleLongMs: options.idleLongMs,
      deletionRetentionMs: Number.POSITIVE_INFINITY,
      publishUpdate: () => {},
    })) continue;
    sessions.set(sessionId, {
      ...session,
      status: 'closed',
      activeAgentId: undefined,
      updatedAt: now,
      closedAt: now,
      metadata: withSessionCloseReason(session.metadata, 'boot-orphaned'),
    });
    closed.push({
      sessionId,
      kind: session.kind,
      messageCount: session.messageCount,
      staleForMs: Math.max(0, now - session.updatedAt),
    });
  }
  return closed;
}

/**
 * Run the boot orphan sweep and DISCLOSE what it closed.
 *
 * Lives here rather than in the broker so the sweep, its reason vocabulary and
 * its disclosure stay in one file — and so the broker (a grandfathered
 * shrink-only monolith) takes one call rather than a block.
 *
 * Disclosure is not optional: these sessions close without anyone asking, so
 * the log line naming each one is the only thing standing between "the system
 * tidied up after a dead process" and "my session vanished".
 */
export function applyBootOrphanSweep(
  sessions: Map<string, SharedSessionRecord>,
  options: BootOrphanSweepOptions,
  publishUpdate: (event: string, payload: unknown) => void,
): readonly OrphanedSessionClosure[] {
  const orphaned = closeOrphanedSessionsAtBoot(sessions, options);
  if (orphaned.length === 0) return orphaned;
  logger.info('[session-broker] closed sessions a process left active when it died', {
    count: orphaned.length,
    reason: 'boot-orphaned',
    sessions: orphaned.map((entry) => ({
      sessionId: entry.sessionId,
      kind: entry.kind,
      messageCount: entry.messageCount,
      staleForMs: entry.staleForMs,
    })),
  });
  for (const entry of orphaned) {
    const closed = sessions.get(entry.sessionId);
    if (closed) publishUpdate('session-closed', { ...closed, reason: 'boot-orphaned' });
  }
  return orphaned;
}

/**
 * True when any participant was seen within the idle-empty window — i.e. a
 * surface is actively holding this session open. A live participant IS activity,
 * so an empty session with a fresh heartbeat must NOT be idle-empty reaped even
 * if `lastActivityAt` has drifted (defense-in-depth alongside the register path
 * advancing lastActivityAt).
 */
function hasFreshParticipant(session: SharedSessionRecord, now: number, idleEmptyMs: number): boolean {
  return session.participants.some((participant) => now - participant.lastSeenAt < idleEmptyMs);
}

function idleCloseReason(
  session: SharedSessionRecord,
  now: number,
  options: SharedSessionGcOptions,
): 'idle-empty' | 'idle-long' | null {
  if (session.status !== 'active') return null;
  if (session.activeAgentId) return null;
  if (session.pendingInputCount > 0) return null;
  // Work running out of this store's sight counts as activity. Asked BEFORE any
  // timestamp arithmetic, because the whole point is that a hosted turn's
  // timestamps go stale WHILE it runs.
  if (options.isExternallyLive?.(session) === true) return null;
  const idle = now - session.lastActivityAt;
  if (session.messageCount === 0 && idle >= options.idleEmptyMs) {
    // A surface holding the session open (fresh participant heartbeat) exempts it
    // from idle-empty reaping — closing it would kill a LIVE, message-less session.
    if (hasFreshParticipant(session, now, options.idleEmptyMs)) return null;
    return 'idle-empty';
  }
  if (session.messageCount > 0 && idle >= options.idleLongMs) return 'idle-long';
  return null;
}
