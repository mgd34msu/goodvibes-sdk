/**
 * companion-chat-gc.ts
 *
 * Pure GC-sweep planning for CompanionChatManager. Kept separate from the
 * manager so the deletion-authority split (charter: closed sessions are HISTORY)
 * is expressed as data — one decision per session — and unit-testable without a
 * live manager or disk.
 *
 * Two distinct authorities, deliberately decoupled:
 *  - MEMORY eviction: cheap and aggressive. After a short grace past `closedAt`
 *    a closed session's heavy in-memory handles (the ConversationManager replay
 *    state and message bodies) are dropped so the resident footprint stays
 *    bounded no matter how much history is on disk. The session META stays in
 *    the map and remains listable (includeClosed) — only the bodies leave RAM.
 *  - PERSISTENT deletion: rare and explicit. The on-disk session file is removed
 *    ONLY when the caller opted into a finite retention window (or, in future, an
 *    explicit delete verb). The default is `undefined` = retain indefinitely, so
 *    a closed session is never deleted off disk by the periodic sweep.
 */

export type CompanionSweepAction =
  /** Active session past its idle TTL → close it (GC-initiated close). */
  | { readonly kind: 'close-idle' }
  /** Closed session past the memory grace → drop bodies from RAM, keep meta. */
  | { readonly kind: 'evict-memory' }
  /** Closed session past an explicit finite retention window → delete off disk. */
  | { readonly kind: 'delete-persistent' }
  /** Nothing to do this sweep. */
  | { readonly kind: 'retain' };

export interface CompanionSweepSessionView {
  readonly status: 'active' | 'closed';
  readonly closedAt: number | null | undefined;
  /** epoch ms of last activity (idle measured from here for active sessions). */
  readonly lastActivityAt: number;
  /** whether the session currently holds message bodies in memory. */
  readonly hasMessagesInMemory: boolean;
  /** whether the session is empty (no messages) — selects the idle TTL. */
  readonly isEmpty: boolean;
}

export interface CompanionSweepPolicy {
  readonly now: number;
  readonly idleActiveMs: number;
  readonly idleEmptyMs: number;
  /**
   * Age past `closedAt` at which heavy in-memory handles are evicted while meta
   * stays listable. Bounds resident memory for long-closed history.
   */
  readonly closedMemoryGraceMs: number;
  /**
   * Age past `closedAt` at which the persisted session file is permanently
   * deleted. `undefined` = retain indefinitely (never delete via the sweep).
   */
  readonly closedRetentionMs: number | undefined;
}

export function planCompanionSweep(
  session: CompanionSweepSessionView,
  policy: CompanionSweepPolicy,
): CompanionSweepAction {
  if (session.status === 'closed') {
    const closedAt = session.closedAt ?? policy.now;
    const closedFor = policy.now - closedAt;
    // Explicit finite retention is the ONLY authority for persistent deletion.
    if (policy.closedRetentionMs !== undefined && closedFor >= policy.closedRetentionMs) {
      return { kind: 'delete-persistent' };
    }
    // Otherwise evict heavy handles once past the memory grace, but only if
    // there is still something resident to evict (idempotent across sweeps).
    if (closedFor >= policy.closedMemoryGraceMs && session.hasMessagesInMemory) {
      return { kind: 'evict-memory' };
    }
    return { kind: 'retain' };
  }

  const idleMs = policy.now - session.lastActivityAt;
  const ttl = session.isEmpty ? policy.idleEmptyMs : policy.idleActiveMs;
  return idleMs >= ttl ? { kind: 'close-idle' } : { kind: 'retain' };
}
