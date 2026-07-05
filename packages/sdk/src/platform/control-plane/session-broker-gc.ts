import type { SharedSessionInputRecord } from './session-intents.js';
import type { SharedSessionMessage, SharedSessionRecord } from './session-types.js';
import { withSessionCloseReason } from './session-broker-sessions.js';

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
