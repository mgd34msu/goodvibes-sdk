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
  readonly deletionRetentionMs: number;
  readonly publishUpdate: (event: string, payload: unknown) => void;
}

export function sweepSharedSessions(store: SharedSessionGcStore, options: SharedSessionGcOptions): boolean {
  const now = Date.now();
  let anyChanged = false;
  for (const [sessionId, session] of store.sessions.entries()) {
    if (session.status === 'closed') {
      const closedAt = session.closedAt ?? session.updatedAt;
      if (now - closedAt >= options.deletionRetentionMs) {
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
