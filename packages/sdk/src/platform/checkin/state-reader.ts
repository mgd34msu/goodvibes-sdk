/**
 * checkin/state-reader.ts
 *
 * Binds a CheckinStateReader to the live runtime through narrow, structural
 * views of sessions and automation runs — narrow enough that a SharedSessionRecord
 * and an AutomationRun satisfy them directly, and that a test can hand-roll them
 * without the real services.
 */
import type { CheckinStateReader, CheckinStateSnapshot } from './types.js';

export interface CheckinSessionView {
  readonly status: string;
  readonly activeAgentId?: string | undefined;
  readonly pendingInputCount: number;
  readonly title: string;
  readonly surfaceKinds: readonly string[];
}

export interface CheckinRunView {
  readonly status: string;
  readonly endedAt?: number | undefined;
}

export interface CheckinRuntimeReaders {
  listSessions(): readonly CheckinSessionView[];
  listRuns(): readonly CheckinRunView[];
  now?(): number;
}

const RECENT_COMPLETION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Non-channel surfaces: a session on these is a product surface, not an inbound channel. */
const PRODUCT_SURFACES = new Set(['tui', 'web', 'webui', 'agent', 'companion-chat', 'companion-task']);

function isChannelSession(session: CheckinSessionView): boolean {
  return session.surfaceKinds.some((kind) => !PRODUCT_SURFACES.has(kind));
}

/** Build the live state reader. Deterministic given its injected views. */
export function createRuntimeCheckinStateReader(readers: CheckinRuntimeReaders): CheckinStateReader {
  const now = readers.now ?? Date.now;
  return {
    snapshot: async (): Promise<CheckinStateSnapshot> => {
      const sessions = readers.listSessions();
      const open = sessions.filter((s) => s.status !== 'closed');
      const running = open.filter((s) => typeof s.activeAgentId === 'string' && s.activeAgentId.length > 0);
      const blocked = open.filter((s) => s.pendingInputCount > 0);
      const unreadChannelItems = open
        .filter(isChannelSession)
        .reduce((sum, s) => sum + Math.max(0, s.pendingInputCount), 0);
      const cutoff = now() - RECENT_COMPLETION_WINDOW_MS;
      const recentCompletions = readers.listRuns()
        .filter((r) => r.status === 'completed' && typeof r.endedAt === 'number' && r.endedAt >= cutoff)
        .length;
      const needsAttention = blocked
        .slice(0, 5)
        .map((s) => `${s.title || 'untitled session'} is waiting on input (${s.pendingInputCount} pending)`);
      return {
        runningSessions: running.length,
        blockedSessions: blocked.length,
        unreadChannelItems,
        recentCompletions,
        needsAttention,
      };
    },
  };
}
