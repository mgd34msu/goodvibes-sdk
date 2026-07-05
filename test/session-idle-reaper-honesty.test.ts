import { describe, expect, test } from 'bun:test';
import { sweepSharedSessions } from '../packages/sdk/src/platform/control-plane/session-broker-gc.ts';
import {
  closeSharedSessionRecord,
  readSessionCloseReason,
  registerSharedSession,
  reopenSharedSessionRecord,
  type RegisterBrokerOps,
} from '../packages/sdk/src/platform/control-plane/session-broker-sessions.ts';
import type {
  SharedSessionParticipant,
  SharedSessionRecord,
  RegisterSharedSessionInput,
} from '../packages/sdk/src/platform/control-plane/session-types.ts';

// D2 — IDLE-EMPTY REAPER must not close LIVE surface sessions, and a
// system-reaped session must reopen honestly on the next heartbeat while a
// user/surface close stays closed.

const IDLE_EMPTY_MS = 10 * 60 * 1000;
const NOW = 2_000_000_000_000;

function participant(overrides: Partial<SharedSessionParticipant> = {}): SharedSessionParticipant {
  return {
    surfaceKind: 'tui',
    surfaceId: 'surface:tui',
    displayName: 'Terminal UI',
    lastSeenAt: NOW,
    ...overrides,
  };
}

function record(overrides: Partial<SharedSessionRecord> = {}): SharedSessionRecord {
  return {
    id: 'user-live',
    kind: 'tui',
    project: '/proj',
    title: 'Terminal UI session',
    status: 'active',
    createdAt: NOW - IDLE_EMPTY_MS * 2,
    updatedAt: NOW - IDLE_EMPTY_MS * 2,
    lastActivityAt: NOW - IDLE_EMPTY_MS * 2, // stale — would trip idle-empty on its own
    messageCount: 0,
    pendingInputCount: 0,
    routeIds: [],
    surfaceKinds: ['tui'],
    participants: [participant()],
    metadata: {},
    ...overrides,
  };
}

function sweepOf(session: SharedSessionRecord, now = NOW): { changed: boolean; result: SharedSessionRecord; events: Array<{ event: string; payload: unknown }> } {
  const sessions = new Map<string, SharedSessionRecord>([[session.id, session]]);
  const events: Array<{ event: string; payload: unknown }> = [];
  const changed = sweepSharedSessionsAt(sessions, now, (event, payload) => events.push({ event, payload }));
  return { changed, result: sessions.get(session.id)!, events };
}

// sweepSharedSessions reads Date.now() internally, so pin the clock for determinism.
function sweepSharedSessionsAt(
  sessions: Map<string, SharedSessionRecord>,
  now: number,
  publishUpdate: (event: string, payload: unknown) => void,
): boolean {
  const realNow = Date.now;
  Date.now = () => now;
  try {
    return sweepSharedSessions(
      { sessions, messages: new Map(), inputs: new Map() },
      { idleEmptyMs: IDLE_EMPTY_MS, idleLongMs: 24 * 60 * 60 * 1000, deletionRetentionMs: Number.POSITIVE_INFINITY, publishUpdate },
    );
  } finally {
    Date.now = realNow;
  }
}

describe('idle-empty reaper — live surface exemption', () => {
  test('a message-less session with a FRESH participant survives the sweep', () => {
    // lastActivityAt is stale, but the surface heartbeat (participant.lastSeenAt=NOW)
    // means a surface is holding the session open — it must NOT be reaped.
    const { changed, result } = sweepOf(record({ participants: [participant({ lastSeenAt: NOW })] }));
    expect(result.status).toBe('active');
    expect(changed).toBe(false);
  });

  test('a message-less session with NO fresh participant is reaped and marked idle-reaped', () => {
    const stale = record({ participants: [participant({ lastSeenAt: NOW - IDLE_EMPTY_MS * 2 })] });
    const { changed, result, events } = sweepOf(stale);
    expect(changed).toBe(true);
    expect(result.status).toBe('closed');
    expect(readSessionCloseReason(result)).toBe('idle-reaped');
    expect(events.map((e) => e.event)).toContain('session-closed');
  });
});

describe('D7b — reaper is per-session among many', () => {
  test('one idle-dead session among live ones: only the dead one is reaped', () => {
    // Five sessions share one store; four have a fresh participant heartbeat, one
    // (the 3rd) went stale. The sweep must reap EXACTLY the stale one.
    const sessions = new Map<string, SharedSessionRecord>();
    const events: Array<{ event: string; payload: unknown }> = [];
    const ids = ['live-1', 'live-2', 'dead-3', 'live-4', 'live-5'];
    for (const id of ids) {
      const stale = id === 'dead-3';
      sessions.set(id, record({
        id,
        participants: [participant({ lastSeenAt: stale ? NOW - IDLE_EMPTY_MS * 2 : NOW })],
      }));
    }
    sweepSharedSessionsAt(sessions, NOW, (event, payload) => events.push({ event, payload }));

    expect(sessions.get('dead-3')!.status).toBe('closed');
    expect(readSessionCloseReason(sessions.get('dead-3')!)).toBe('idle-reaped');
    for (const id of ['live-1', 'live-2', 'live-4', 'live-5']) {
      expect(sessions.get(id)!.status, `${id} must stay active`).toBe('active');
    }
    // Exactly one close event fired, for the dead session.
    const closedEvents = events.filter((e) => e.event === 'session-closed');
    expect(closedEvents).toHaveLength(1);
  });
});

describe('close-reason marking', () => {
  test('explicit close defaults to a user close reason', () => {
    const closed = closeSharedSessionRecord(record());
    expect(closed.status).toBe('closed');
    expect(readSessionCloseReason(closed)).toBe('user');
  });

  test('reopen clears the close reason', () => {
    const reaped = closeSharedSessionRecord(record(), 'idle-reaped');
    expect(readSessionCloseReason(reaped)).toBe('idle-reaped');
    const reopened = reopenSharedSessionRecord(reaped);
    expect(reopened.status).toBe('active');
    expect(readSessionCloseReason(reopened)).toBeUndefined();
  });
});

describe('reopen honesty on heartbeat', () => {
  function opsFor(existing: SharedSessionRecord): { ops: RegisterBrokerOps; reopenCalls: string[] } {
    const reopenCalls: string[] = [];
    const ops: RegisterBrokerOps = {
      getSession: (id) => (id === existing.id ? existing : null),
      createSession: async () => { throw new Error('should not create'); },
      reopenSession: async (id) => { reopenCalls.push(id); return reopenSharedSessionRecord(existing); },
      attachParticipant: async (session) => session,
    };
    return { ops, reopenCalls };
  }

  const heartbeat: RegisterSharedSessionInput = {
    sessionId: 'user-live',
    participant: participant(),
  };

  test('a SYSTEM-reaped session reopens automatically on the next heartbeat (reason was visible)', async () => {
    const reaped = closeSharedSessionRecord(record(), 'idle-reaped');
    expect(readSessionCloseReason(reaped)).toBe('idle-reaped'); // reason visible on the closed record
    const { ops, reopenCalls } = opsFor(reaped);
    const result = await registerSharedSession(ops, heartbeat);
    expect(result.reopened).toBe(true);
    expect(result.conflict).toBeUndefined();
    expect(result.record.status).toBe('active');
    expect(reopenCalls).toEqual(['user-live']);
  });

  test('a USER-closed session stays closed on heartbeat with an honest conflict', async () => {
    const userClosed = closeSharedSessionRecord(record(), 'user');
    const { ops, reopenCalls } = opsFor(userClosed);
    const result = await registerSharedSession(ops, heartbeat);
    expect(result.reopened).toBe(false);
    expect(result.conflict).toEqual({ status: 'closed' });
    expect(reopenCalls).toEqual([]); // did NOT reopen
  });

  test('explicit reopen:true still reopens a user-closed session', async () => {
    const userClosed = closeSharedSessionRecord(record(), 'user');
    const { ops } = opsFor(userClosed);
    const result = await registerSharedSession(ops, { ...heartbeat, reopen: true });
    expect(result.reopened).toBe(true);
  });
});
