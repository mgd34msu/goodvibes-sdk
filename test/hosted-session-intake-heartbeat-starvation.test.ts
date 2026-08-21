/**
 * hosted-session-intake-heartbeat-starvation.test.ts
 *
 * The defect: `HostedSessionSpineIntake.tick()` awaited `deliver(...)`, the
 * whole turn, from inside its own re-entrancy guard. While ANY one hosted
 * session was answering, the guard was held, so no later tick ran and no OTHER
 * session was heartbeated on the shared spine. Two consequences the daemon
 * actually showed:
 *
 *  - A hosted session's spine participant goes stale. A steer at a session with
 *    a live surface participant is collected by that surface; a steer at one
 *    without spawns a background agent instead. So the conversation keeps
 *    answering, from the wrong thing.
 *  - Every clock the idle reaper reads goes stale too, which is how a session
 *    whose turn was demonstrably still running got closed "idle-reaped". The
 *    liveness probe now covers the reaper's symptom; the starvation underneath
 *    it is what this file is about.
 *
 * The fix: the guard covers SCHEDULING only. Delivery is detached into a
 * per-session lane, a session's own turns stay serial, other sessions do not
 * wait behind them, and heartbeats keep going while a slow turn is in flight.
 */
import { describe, expect, test } from 'bun:test';
import { HostedSessionSpineIntake, type HostedSessionSpine } from '../packages/sdk/src/platform/hosted-sessions/spine-intake.ts';
import type { HostedSessionRecord } from '../packages/sdk/src/platform/hosted-sessions/types.ts';

function record(id: string): HostedSessionRecord {
  return {
    id,
    workspaceRoot: '/w',
    title: id,
    status: 'idle',
    detachPolicy: null,
    effectiveDetachPolicy: 'survive',
    attachedClients: [],
    createdAt: 1,
    updatedAt: 1,
    turnCount: 0,
    messageCount: 0,
    restoredFromDisk: false,
  };
}

interface Gate {
  readonly opened: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  return { opened, open: release };
}

/** A spine that records every heartbeat and hands out whatever is queued. */
function buildSpine(queued: Map<string, { id: string; body: string }[]>): HostedSessionSpine & {
  readonly heartbeats: string[];
  readonly consumed: string[];
} {
  const heartbeats: string[] = [];
  const consumed: string[] = [];
  return {
    heartbeats,
    consumed,
    register: async (input) => { heartbeats.push(input.sessionId); return {}; },
    closeSession: async () => ({}),
    getInputsSince: (sessionId) => queued.get(sessionId) ?? [],
    markInputDelivered: async (sessionId, inputId, options) => {
      if (options?.consumed === true) {
        consumed.push(inputId);
      } else {
        queued.set(sessionId, (queued.get(sessionId) ?? []).filter((entry) => entry.id !== inputId));
      }
      return {};
    },
  };
}

describe('one hosted turn must not starve every session heartbeat', () => {
  test('a turn still running does not stop the next tick from heartbeating every session', async () => {
    const queued = new Map([['slow-session', [{ id: 'input-1', body: 'take your time' }]]]);
    const spine = buildSpine(queued);
    const turn = gate();
    let deliveriesStarted = 0;
    const intake = new HostedSessionSpineIntake({
      spine,
      liveSessions: () => [record('slow-session'), record('other-session')],
      now: () => 1,
      deliver: async () => {
        deliveriesStarted += 1;
        // Exactly the shape of the reported defect: a turn that runs for
        // minutes while the intake interval keeps firing.
        await turn.opened;
      },
    });

    // Tick one: both sessions heartbeat, and the slow turn starts.
    await intake.tick();
    expect(deliveriesStarted).toBe(1);
    expect(spine.heartbeats).toEqual(['slow-session', 'other-session']);
    // The turn has NOT finished, nothing about it has been marked consumed.
    expect(spine.consumed).toEqual([]);

    // Ticks two and three land while that same turn is still running. Under the
    // defect the guard was still held and neither produced a single heartbeat.
    await intake.tick();
    await intake.tick();
    expect(spine.heartbeats).toEqual([
      'slow-session', 'other-session',
      'slow-session', 'other-session',
      'slow-session', 'other-session',
    ]);
    // And the message was not handed over a second and third time.
    expect(deliveriesStarted).toBe(1);

    turn.open();
    await intake.drainDeliveries();
    expect(spine.consumed).toEqual(['input-1']);
  });

  test("a slow turn in one session does not hold up another session's message", async () => {
    const queued = new Map([
      ['slow-session', [{ id: 'slow-input', body: 'the long one' }]],
      ['quick-session', [{ id: 'quick-input', body: 'the short one' }]],
    ]);
    const spine = buildSpine(queued);
    const slowTurn = gate();
    const delivered: string[] = [];
    const intake = new HostedSessionSpineIntake({
      spine,
      liveSessions: () => [record('slow-session'), record('quick-session')],
      now: () => 1,
      deliver: async (sessionId, text) => {
        if (sessionId === 'slow-session') await slowTurn.opened;
        delivered.push(`${sessionId}:${text}`);
      },
    });

    await intake.tick();
    // The quick session's turn ran to completion while the slow one is still
    // in flight. Serialized delivery could not produce this.
    await Promise.resolve();
    await Promise.resolve();
    expect(delivered).toEqual(['quick-session:the short one']);
    expect(spine.consumed).toEqual(['quick-input']);

    slowTurn.open();
    await intake.drainDeliveries();
    expect(delivered).toEqual(['quick-session:the short one', 'slow-session:the long one']);
    expect(spine.consumed).toEqual(['quick-input', 'slow-input']);
  });

  test("a session's own turns stay in the order they were collected", async () => {
    const queued = new Map([['s1', [
      { id: 'first', body: 'steer' },
      { id: 'second', body: 'follow-up' },
      { id: 'third', body: 'and then' },
    ]]]);
    const spine = buildSpine(queued);
    const order: string[] = [];
    let inFlight = 0;
    const intake = new HostedSessionSpineIntake({
      spine,
      liveSessions: () => [record('s1')],
      now: () => 1,
      deliver: async (_sessionId, text) => {
        inFlight += 1;
        // Two of this session's turns running at once would be a worse bug than
        // the one being fixed: a steer answered beside the follow-up meant to
        // come after it.
        expect(inFlight).toBe(1);
        await Promise.resolve();
        order.push(text);
        inFlight -= 1;
      },
    });

    await intake.tick();
    await intake.drainDeliveries();
    expect(order).toEqual(['steer', 'follow-up', 'and then']);
    expect(spine.consumed).toEqual(['first', 'second', 'third']);
  });

  test('an error out of a detached delivery is absorbed, not left unhandled', async () => {
    const queued = new Map([['s1', [{ id: 'input-1', body: 'answer me' }]]]);
    const spine = buildSpine(queued);
    const rejections: unknown[] = [];
    const onRejection = (error: unknown): void => { rejections.push(error); };
    process.on('unhandledRejection', onRejection);
    try {
      const intake = new HostedSessionSpineIntake({
        spine,
        liveSessions: () => [record('s1')],
        now: () => 1,
        maxDeliveryAttempts: 1,
        deliver: async () => { throw new Error('its loop is gone'); },
      });
      await intake.tick();
      await intake.drainDeliveries();
      // Handled where tick() used to handle it: the input is not consumed, and
      // nothing escaped to the process.
      expect(spine.consumed).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  test('a delivery still in flight when the next tick collects a new message keeps its place in line', async () => {
    const queued = new Map([['s1', [{ id: 'input-1', body: 'first' }]]]);
    const spine = buildSpine(queued);
    const firstTurn = gate();
    const order: string[] = [];
    const intake = new HostedSessionSpineIntake({
      spine,
      liveSessions: () => [record('s1')],
      now: () => 1,
      deliver: async (_sessionId, text) => {
        if (text === 'first') await firstTurn.opened;
        order.push(text);
      },
    });

    await intake.tick();
    // A second message arrives while the first turn is still running.
    queued.set('s1', [{ id: 'input-2', body: 'second' }]);
    await intake.tick();
    expect(order).toEqual([]);

    firstTurn.open();
    await intake.drainDeliveries();
    expect(order).toEqual(['first', 'second']);
    expect(spine.consumed).toEqual(['input-1', 'input-2']);
  });
});
