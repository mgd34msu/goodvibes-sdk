/**
 * hosted-session-spine-intake.test.ts
 *
 * What happens to the owner's message when handing it to a hosted session's
 * loop FAILS.
 *
 * The intake marked every collected input consumed whether or not delivery
 * succeeded, so the record said the message had been answered when nothing had
 * received it, and the only trace was a warn line in the daemon log. On a
 * survive-detach session with nobody attached that is a message that vanished.
 *
 * So: a failure keeps the input, retries it, and, once the attempts are spent
 *, fails it on the spine and puts the incident in front of the owner. And the
 * tick itself never throws out of its own interval, which used to be an
 * unhandled rejection on a read that would have succeeded a moment later.
 *
 * tick() no longer waits for a delivery (a delivery is the whole turn, and
 * waiting for one froze every other session's heartbeat), so these tests ask
 * for the outcome with drainDeliveries(). The behaviour being asserted is
 * unchanged; only the moment it is observable moved.
 */
import { describe, expect, test } from 'bun:test';
import { HostedSessionSpineIntake, type HostedSessionSpine } from '../packages/sdk/src/platform/hosted-sessions/spine-intake.ts';
import type { HostedSessionRecord } from '../packages/sdk/src/platform/hosted-sessions/types.ts';

function record(id = 'hosted-1'): HostedSessionRecord {
  return {
    id,
    workspaceRoot: '/w',
    title: 'a session',
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

interface SpineLog {
  readonly delivered: string[];
  readonly consumed: string[];
  readonly failed: { inputId: string; error: string }[];
}

function buildSpine(queued: Map<string, { id: string; body: string }[]>): HostedSessionSpine & { log: SpineLog } {
  const log: SpineLog = { delivered: [], consumed: [], failed: [] };
  return {
    log,
    register: async () => ({}),
    closeSession: async () => ({}),
    getInputsSince: (sessionId) => queued.get(sessionId) ?? [],
    markInputDelivered: async (sessionId, inputId, options) => {
      if (options?.consumed === true) {
        log.consumed.push(inputId);
      } else {
        log.delivered.push(inputId);
        // Collecting takes it out of the queued set, exactly as the broker does.
        queued.set(sessionId, (queued.get(sessionId) ?? []).filter((entry) => entry.id !== inputId));
      }
      return {};
    },
    failInput: async (_sessionId, inputId, error) => {
      log.failed.push({ inputId, error });
      return {};
    },
  };
}

describe('a delivery that failed is not a delivery that happened', () => {
  test('a transient failure is retried on the next tick and then completes', async () => {
    const queued = new Map([['hosted-1', [{ id: 'input-1', body: 'answer me' }]]]);
    const spine = buildSpine(queued);
    let attempts = 0;
    const intake = new HostedSessionSpineIntake({
      spine,
      liveSessions: () => [record()],
      now: () => 1,
      deliver: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('its loop is still being composed');
      },
    });

    await intake.tick();
    await intake.drainDeliveries();
    expect(attempts).toBe(1);
    // The one thing that must not happen: the record saying it was answered.
    expect(spine.log.consumed).toEqual([]);
    expect(spine.log.failed).toEqual([]);

    await intake.tick();
    await intake.drainDeliveries();
    expect(attempts).toBe(2);
    expect(spine.log.consumed).toEqual(['input-1']);
    expect(spine.log.failed).toEqual([]);
  });

  test('a failure that will not clear is failed on the spine and told to the owner', async () => {
    const queued = new Map([['hosted-1', [{ id: 'input-1', body: 'answer me' }]]]);
    const spine = buildSpine(queued);
    const alerts: string[] = [];
    let attempts = 0;
    const intake = new HostedSessionSpineIntake({
      spine,
      liveSessions: () => [record()],
      now: () => 1,
      maxDeliveryAttempts: 3,
      alertOwner: (text) => { alerts.push(text); },
      deliver: async () => {
        attempts += 1;
        throw new Error('this session is terminated');
      },
    });

    await intake.tick();
    await intake.drainDeliveries();
    await intake.tick();
    await intake.drainDeliveries();
    expect(spine.log.failed).toEqual([]);
    expect(alerts).toEqual([]);

    await intake.tick();
    await intake.drainDeliveries();
    expect(attempts).toBe(3);
    expect(spine.log.consumed).toEqual([]);
    expect(spine.log.failed).toHaveLength(1);
    expect(spine.log.failed[0]?.inputId).toBe('input-1');
    expect(spine.log.failed[0]?.error).toContain('this session is terminated');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('hosted-1');
    expect(alerts[0]).toContain('could not be delivered');

    // Spent, not retried forever.
    await intake.tick();
    await intake.drainDeliveries();
    expect(attempts).toBe(3);
  });

  test('a spine that cannot mark a failure leaves the input collected, never consumed', async () => {
    const queued = new Map([['hosted-1', [{ id: 'input-1', body: 'answer me' }]]]);
    const spine = buildSpine(queued);
    delete (spine as { failInput?: unknown }).failInput;
    const intake = new HostedSessionSpineIntake({
      spine,
      liveSessions: () => [record()],
      now: () => 1,
      maxDeliveryAttempts: 1,
      deliver: async () => { throw new Error('nope'); },
    });

    await intake.tick();
    await intake.drainDeliveries();
    expect(spine.log.delivered).toEqual(['input-1']);
    expect(spine.log.consumed).toEqual([]);
  });

  test('an owner alerter that throws does not take the tick with it', async () => {
    const queued = new Map([['hosted-1', [{ id: 'input-1', body: 'answer me' }]]]);
    const spine = buildSpine(queued);
    const intake = new HostedSessionSpineIntake({
      spine,
      liveSessions: () => [record()],
      now: () => 1,
      maxDeliveryAttempts: 1,
      alertOwner: () => { throw new Error('every channel is down'); },
      deliver: async () => { throw new Error('nope'); },
    });

    await intake.tick();
    await intake.drainDeliveries();
    expect(spine.log.failed).toHaveLength(1);
  });

  test('a successful delivery still completes the record, as it always did', async () => {
    const queued = new Map([['hosted-1', [{ id: 'input-1', body: 'answer me' }]]]);
    const spine = buildSpine(queued);
    const submitted: string[] = [];
    const intake = new HostedSessionSpineIntake({
      spine,
      liveSessions: () => [record()],
      now: () => 1,
      deliver: async (_sessionId, text) => { submitted.push(text); },
    });

    await intake.tick();
    await intake.drainDeliveries();
    expect(submitted).toEqual(['answer me']);
    expect(spine.log.delivered).toEqual(['input-1']);
    expect(spine.log.consumed).toEqual(['input-1']);
  });
});

describe('the tick never rejects into its own interval', () => {
  test('a throwing liveSessions() is absorbed and the next tick recovers', async () => {
    const queued = new Map([['hosted-1', [{ id: 'input-1', body: 'answer me' }]]]);
    const spine = buildSpine(queued);
    let broken = true;
    const submitted: string[] = [];
    const intake = new HostedSessionSpineIntake({
      spine,
      now: () => 1,
      liveSessions: () => {
        if (broken) throw new Error('the store is mid-write');
        return [record()];
      },
      deliver: async (_sessionId, text) => { submitted.push(text); },
    });

    await intake.tick();
    await intake.drainDeliveries();
    expect(submitted).toEqual([]);

    broken = false;
    await intake.tick();
    await intake.drainDeliveries();
    expect(submitted).toEqual(['answer me']);
  });

  test('a throwing getInputsSince() is absorbed too', async () => {
    const intake = new HostedSessionSpineIntake({
      spine: {
        register: async () => ({}),
        closeSession: async () => ({}),
        getInputsSince: () => { throw new Error('the bucket is being compacted'); },
        markInputDelivered: async () => ({}),
      },
      liveSessions: () => [record()],
      now: () => 1,
      deliver: async () => undefined,
    });

    await intake.tick();
    await intake.drainDeliveries();
    expect(true).toBe(true);
  });
});
