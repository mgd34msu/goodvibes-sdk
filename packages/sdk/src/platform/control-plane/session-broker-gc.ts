import type { SharedSessionInputRecord } from './session-intents.js';
import type { SharedSessionMessage, SharedSessionRecord } from './session-types.js';

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

    if (!shouldCloseIdleSession(session, now, options)) continue;
    const reason = idleCloseReason(session, now, options);
    if (!reason) continue;
    const closed: SharedSessionRecord = {
      ...session,
      status: 'closed',
      activeAgentId: undefined,
      updatedAt: now,
      closedAt: now,
    };
    store.sessions.set(sessionId, closed);
    options.publishUpdate('session-closed', { ...closed, reason });
    anyChanged = true;
  }
  return anyChanged;
}

function shouldCloseIdleSession(
  session: SharedSessionRecord,
  now: number,
  options: SharedSessionGcOptions,
): boolean {
  return idleCloseReason(session, now, options) !== null;
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
  if (session.messageCount === 0 && idle >= options.idleEmptyMs) return 'idle-empty';
  if (session.messageCount > 0 && idle >= options.idleLongMs) return 'idle-long';
  return null;
}
