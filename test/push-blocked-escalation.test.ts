/**
 * push-blocked-escalation.test.ts
 *
 * A block on a human escalates to a device push once it has waited past its
 * grace WITH NO HUMAN RESPONSE — regardless of an attached surface. Presence
 * (an open TUI / heartbeat) suppresses only the immediate push, never the
 * escalation; a real interaction that clears the block cancels it. These tests
 * drive the source with a manual scheduler + clock so escalation is
 * deterministic, capturing the composed PushMessage by overriding deliver().
 */
import { describe, expect, test } from 'bun:test';
import { PushService } from '../packages/sdk/src/platform/push/index.js';
import type {
  EscalationScheduler,
  FleetNotice,
  PushEscalationConfig,
  PushMessage,
  PushSubscriptionStore,
  VapidManager,
} from '../packages/sdk/src/platform/push/index.js';

/** A manual scheduler: armed timers are fired explicitly by the test. */
function manualScheduler(): {
  scheduler: EscalationScheduler;
  fireDue(nowMs: number): number;
  pending(): number;
} {
  interface Armed { at: number; fn: () => void; cancelled: boolean; }
  let clock = 0;
  const armed: Armed[] = [];
  return {
    scheduler: {
      schedule(fn, delayMs) {
        const entry: Armed = { at: clock + delayMs, fn, cancelled: false };
        armed.push(entry);
        return () => { entry.cancelled = true; };
      },
    },
    // Fire every armed, un-cancelled timer whose deadline is <= nowMs, once.
    fireDue(nowMs) {
      clock = nowMs;
      let fired = 0;
      for (const entry of [...armed]) {
        if (!entry.cancelled && entry.at <= nowMs) {
          entry.cancelled = true; // one-shot
          entry.fn();
          fired += 1;
        }
      }
      return fired;
    },
    pending() {
      return armed.filter((a) => !a.cancelled).length;
    },
  };
}

function makeService(opts: {
  scheduler: EscalationScheduler;
  now: () => number;
  escalation?: PushEscalationConfig;
}): { service: PushService; delivered: PushMessage[] } {
  const escalation = opts.escalation ?? { blockedGraceMs: 300_000, followUpIntervalMs: 300_000, maxFollowUps: 2 };
  const service = new PushService({
    vapid: {} as VapidManager,
    store: {} as PushSubscriptionStore,
    scheduler: opts.scheduler,
    now: opts.now,
    escalation: () => escalation,
  });
  const delivered: PushMessage[] = [];
  (service as unknown as { deliver: (m: PushMessage) => Promise<unknown[]> }).deliver = async (m) => {
    delivered.push(m);
    return [];
  };
  return { service, delivered };
}

function fakeSource(): { source: { subscribe: (l: (n: FleetNotice) => void) => () => void }; push: (n: FleetNotice) => void } {
  let listener: ((n: FleetNotice) => void) | null = null;
  return {
    source: { subscribe: (l) => { listener = l; return () => { listener = null; }; } },
    push: (n) => listener?.(n),
  };
}

const blocked = (nodeId: string, sessionId: string): FleetNotice => ({
  type: 'FLEET_NODE_BLOCKED_ON_USER',
  nodeId,
  label: `task-${nodeId}`,
  reason: 'approval',
  sessionId,
});

describe('PushService blocked-too-long escalation', () => {
  test('an attached-but-idle surface still gets the escalated push after the grace', async () => {
    let now = 0;
    const clock = manualScheduler();
    const { service, delivered } = makeService({ scheduler: clock.scheduler, now: () => now });
    const { source, push } = fakeSource();
    // Presence reports attached the whole time — a heartbeat, not a human answer.
    service.attachFleetNeedsInputSource(source, { isAttached: () => true });

    push(blocked('n1', 's1'));
    await Promise.resolve();
    // Immediate push suppressed by presence.
    expect(delivered).toHaveLength(0);

    // Grace elapses with no response -> escalation fires despite attachment.
    now = 300_000;
    clock.fireDue(300_000);
    await Promise.resolve();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      data: { kind: 'needs-input', sessionId: 's1', nodeId: 'n1', escalated: true },
      urgency: 'high',
    });
  });

  test('an answered ask never escalates: a cleared block cancels the armed timer', async () => {
    let now = 0;
    const clock = manualScheduler();
    const { service, delivered } = makeService({ scheduler: clock.scheduler, now: () => now });
    const { source, push } = fakeSource();
    service.attachFleetNeedsInputSource(source, { isAttached: () => true });

    push(blocked('n1', 's1'));
    await Promise.resolve();
    // Human answers before the grace: the block clears.
    push({ type: 'FLEET_NODE_UNBLOCKED', nodeId: 'n1' });
    expect(clock.pending()).toBe(0);

    now = 600_000;
    clock.fireDue(600_000);
    await Promise.resolve();
    expect(delivered).toHaveLength(0);
  });

  test('an unattended block pushes immediately and still escalates as a reminder', async () => {
    let now = 0;
    const clock = manualScheduler();
    const { service, delivered } = makeService({ scheduler: clock.scheduler, now: () => now });
    const { source, push } = fakeSource();
    service.attachFleetNeedsInputSource(source, { isAttached: () => false });

    push(blocked('n1', 's1'));
    await Promise.resolve();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.data).toMatchObject({ kind: 'needs-input' });
    expect(delivered[0]?.data?.escalated).toBeUndefined();

    now = 300_000;
    clock.fireDue(300_000);
    await Promise.resolve();
    expect(delivered).toHaveLength(2);
    expect(delivered[1]?.data).toMatchObject({ escalated: true });
  });

  test('follow-up reminders are bounded by maxFollowUps', async () => {
    let now = 0;
    const clock = manualScheduler();
    const { service, delivered } = makeService({
      scheduler: clock.scheduler,
      now: () => now,
      escalation: { blockedGraceMs: 100, followUpIntervalMs: 100, maxFollowUps: 2 },
    });
    const { source, push } = fakeSource();
    service.attachFleetNeedsInputSource(source, { isAttached: () => true });

    push(blocked('n1', 's1'));
    await Promise.resolve();

    // Fire escalation + follow-ups; after maxFollowUps reminders nothing re-arms.
    for (let i = 1; i <= 6; i++) {
      now = i * 100;
      clock.fireDue(now);
      await Promise.resolve();
    }
    // 1 escalation + 2 bounded follow-ups = 3 total.
    expect(delivered).toHaveLength(3);
    expect(clock.pending()).toBe(0);
  });

  test('silencing the class before the grace stops the escalation', async () => {
    let now = 0;
    let enabled = true;
    const clock = manualScheduler();
    const service = new PushService({
      vapid: {} as VapidManager,
      store: {} as PushSubscriptionStore,
      scheduler: clock.scheduler,
      now: () => now,
      escalation: () => ({ blockedGraceMs: 100, followUpIntervalMs: 100, maxFollowUps: 3 }),
      isCategoryEnabled: () => enabled,
    });
    const delivered: PushMessage[] = [];
    (service as unknown as { deliver: (m: PushMessage) => Promise<unknown[]> }).deliver = async (m) => {
      delivered.push(m);
      return [];
    };
    const { source, push } = fakeSource();
    service.attachFleetNeedsInputSource(source, { isAttached: () => false });

    push(blocked('n1', 's1'));
    await Promise.resolve();
    expect(delivered).toHaveLength(1); // immediate

    enabled = false;
    now = 100;
    clock.fireDue(100);
    await Promise.resolve();
    // Escalation suppressed because the class is now silenced; nothing re-armed.
    expect(delivered).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });
});
