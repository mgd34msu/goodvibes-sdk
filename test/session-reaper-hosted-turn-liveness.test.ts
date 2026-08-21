import { describe, expect, test } from 'bun:test';
import {
  closeOrphanedSessionsAtBoot,
  sweepSharedSessions,
} from '../packages/sdk/src/platform/control-plane/session-broker-gc.ts';
import {
  isSystemClosedSession,
  readSessionCloseReason,
} from '../packages/sdk/src/platform/control-plane/session-broker-sessions.ts';
import { createHostedSessionLivenessProbe } from '../packages/sdk/src/platform/hosted-sessions/liveness-probe.ts';
import type { HostedSessionRecord } from '../packages/sdk/src/platform/hosted-sessions/types.ts';
import type { SharedSessionRecord } from '../packages/sdk/src/platform/control-plane/session-types.ts';

// The bookkeeping contradiction this pins: control-plane sessions.json closed a
// session "idle-reaped" at 21:45Z while its turn demonstrably went on running
// daemon-side until 22:26Z. The reaper judged liveness only by signals a hosted
// turn never emits.

const IDLE_EMPTY_MS = 10 * 60 * 1000;
const IDLE_LONG_MS = 24 * 60 * 60 * 1000;
const NOW = 2_000_000_000_000;

function hostedRecord(overrides: Partial<HostedSessionRecord> = {}): HostedSessionRecord {
  return {
    id: 'hosted-1',
    workspaceRoot: '/proj',
    title: 'Hosted session',
    status: 'running',
    detachPolicy: null,
    effectiveDetachPolicy: 'kill',
    attachedClients: [],
    createdAt: NOW - IDLE_EMPTY_MS * 3,
    updatedAt: NOW - IDLE_EMPTY_MS * 3,
    turnCount: 1,
    messageCount: 0,
    restoredFromDisk: false,
    ...overrides,
  } as HostedSessionRecord;
}

function brokerRecord(overrides: Partial<SharedSessionRecord> = {}): SharedSessionRecord {
  return {
    id: 'hosted-1',
    kind: 'hosted',
    project: '/proj',
    title: 'Hosted session',
    status: 'active',
    createdAt: NOW - IDLE_EMPTY_MS * 3,
    updatedAt: NOW - IDLE_EMPTY_MS * 3,
    // Stale on every clock the reaper used to consult, this is exactly the
    // state a long hosted turn leaves behind while it is still running.
    lastActivityAt: NOW - IDLE_EMPTY_MS * 3,
    messageCount: 0,
    pendingInputCount: 0,
    routeIds: [],
    surfaceKinds: ['service'],
    participants: [{
      surfaceKind: 'service',
      surfaceId: 'surface:hosted',
      lastSeenAt: NOW - IDLE_EMPTY_MS * 3,
    }],
    metadata: {},
    ...overrides,
  } as SharedSessionRecord;
}

function sweepAt(
  sessions: Map<string, SharedSessionRecord>,
  now: number,
  isExternallyLive?: (session: SharedSessionRecord) => boolean,
): Array<{ event: string; payload: unknown }> {
  const events: Array<{ event: string; payload: unknown }> = [];
  const realNow = Date.now;
  Date.now = (): number => now;
  try {
    sweepSharedSessions(
      { sessions, messages: new Map(), inputs: new Map() },
      {
        idleEmptyMs: IDLE_EMPTY_MS,
        idleLongMs: IDLE_LONG_MS,
        deletionRetentionMs: Number.POSITIVE_INFINITY,
        publishUpdate: (event, payload) => { events.push({ event, payload }); },
        ...(isExternallyLive ? { isExternallyLive } : {}),
      },
    );
  } finally {
    Date.now = realNow;
  }
  return events;
}

describe('idle reaper — a live hosted turn is activity', () => {
  test('without a liveness probe the stale-clocked hosted session IS reaped (the reported defect)', () => {
    const sessions = new Map([['hosted-1', brokerRecord()]]);
    sweepAt(sessions, NOW);
    // Documents the behaviour the probe exists to correct: every signal the
    // reaper reads is stale, so it closes a session whose turn is still going.
    expect(sessions.get('hosted-1')!.status).toBe('closed');
    expect(readSessionCloseReason(sessions.get('hosted-1')!)).toBe('idle-reaped');
  });

  test('a session whose hosted turn is RUNNING is not reaped, however stale its clocks', () => {
    const sessions = new Map([['hosted-1', brokerRecord()]]);
    const probe = createHostedSessionLivenessProbe(
      { get: () => hostedRecord({ status: 'running' }) },
      { now: () => NOW },
    );
    const events = sweepAt(sessions, NOW, probe);
    expect(sessions.get('hosted-1')!.status).toBe('active');
    expect(readSessionCloseReason(sessions.get('hosted-1')!)).toBeUndefined();
    expect(events).toEqual([]);
  });

  test('a hosted session the engine touched recently survives on its own lastActivity', () => {
    const sessions = new Map([['hosted-1', brokerRecord()]]);
    const probe = createHostedSessionLivenessProbe(
      // Idle, but the hosted engine's own updatedAt is fresh, activity the
      // broker's record never received.
      { get: () => hostedRecord({ status: 'idle', updatedAt: NOW - 1000 }) },
      { now: () => NOW },
    );
    sweepAt(sessions, NOW, probe);
    expect(sessions.get('hosted-1')!.status).toBe('active');
  });

  test('the probe does not blanket-exempt: a terminated hosted session is still reaped', () => {
    const sessions = new Map([['hosted-1', brokerRecord()]]);
    const probe = createHostedSessionLivenessProbe(
      { get: () => hostedRecord({ status: 'terminated', updatedAt: NOW - 1000 }) },
      { now: () => NOW },
    );
    sweepAt(sessions, NOW, probe);
    expect(sessions.get('hosted-1')!.status).toBe('closed');
  });

  test('the probe declines to speak for sessions it does not own', () => {
    const probe = createHostedSessionLivenessProbe(
      { get: () => hostedRecord({ status: 'running' }) },
      { now: () => NOW },
    );
    // A non-hosted session is not this engine's to vouch for even though the
    // lookup would happily return a running record for the id.
    expect(probe({ id: 'hosted-1', kind: 'tui' })).toBe(false);
    // An id the engine has no record of is not evidence of life.
    const empty = createHostedSessionLivenessProbe({ get: () => null }, { now: () => NOW });
    expect(empty({ id: 'hosted-1', kind: 'hosted' })).toBe(false);
  });

  test('a throwing lookup cannot take down the sweep that called it', () => {
    const sessions = new Map([['hosted-1', brokerRecord()]]);
    const probe = createHostedSessionLivenessProbe(
      { get: () => { throw new Error('engine unavailable'); } },
      { now: () => NOW },
    );
    expect(() => sweepAt(sessions, NOW, probe)).not.toThrow();
    expect(sessions.get('hosted-1')!.status).toBe('closed');
  });
});

const BOOT_SWEEP = { idleEmptyMs: IDLE_EMPTY_MS, idleLongMs: IDLE_LONG_MS, now: NOW };

describe('boot sweep — a session left active by a dead process', () => {
  test('the ghost is closed WITH ITS REASON, not deleted', () => {
    // The observed ghost: "active", 0 messages, left by a pty-forked second
    // instance that died without closing it.
    const ghost = brokerRecord({ id: 'user-b747dd2f', kind: 'tui', messageCount: 0 });
    const sessions = new Map([['user-b747dd2f', ghost]]);

    const closed = closeOrphanedSessionsAtBoot(sessions, BOOT_SWEEP);

    expect(closed).toHaveLength(1);
    expect(closed[0]!.sessionId).toBe('user-b747dd2f');
    expect(closed[0]!.messageCount).toBe(0);
    // Still on the record, silent deletion is indistinguishable from data loss.
    const swept = sessions.get('user-b747dd2f')!;
    expect(swept).toBeDefined();
    expect(swept.status).toBe('closed');
    expect(readSessionCloseReason(swept)).toBe('boot-orphaned');
    expect(swept.closedAt).toBe(NOW);
  });

  test('a session that is merely surviving a restart is NOT closed', () => {
    // Surfaces outlive the daemon and re-register afterwards; their sessions
    // are expected to still be active. Only a session already past its idle
    // window is an orphan.
    const live = brokerRecord({
      id: 'user-live',
      kind: 'tui',
      updatedAt: NOW - 1000,
      lastActivityAt: NOW - 1000,
      participants: [{ surfaceKind: 'tui', surfaceId: 'surface:tui', lastSeenAt: NOW - 1000 }],
    } as Partial<SharedSessionRecord>);
    const sessions = new Map([['user-live', live]]);

    expect(closeOrphanedSessionsAtBoot(sessions, BOOT_SWEEP)).toHaveLength(0);
    expect(sessions.get('user-live')!.status).toBe('active');
  });

  test('a boot-orphaned close is a SYSTEM close, so a surface that is really alive reopens', () => {
    const sessions = new Map([['user-b747dd2f', brokerRecord({ id: 'user-b747dd2f', kind: 'tui' })]]);
    closeOrphanedSessionsAtBoot(sessions, BOOT_SWEEP);
    // isSystemClosedSession is what registerSharedSession consults to decide an
    // auto-reopen, so a false positive costs one reopen, never a conversation.
    expect(isSystemClosedSession(sessions.get('user-b747dd2f')!)).toBe(true);
  });

  test('already-closed sessions are left exactly as they were', () => {
    const userClosed = brokerRecord({
      id: 'user-done',
      status: 'closed',
      closedAt: NOW - 5000,
      metadata: { closeReason: 'user' },
    });
    const sessions = new Map([['user-done', userClosed]]);

    expect(closeOrphanedSessionsAtBoot(sessions, BOOT_SWEEP)).toHaveLength(0);
    expect(sessions.get('user-done')).toBe(userClosed);
    expect(readSessionCloseReason(sessions.get('user-done')!)).toBe('user');
  });
});
