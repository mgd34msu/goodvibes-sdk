/**
 * push-needs-input-source.test.ts
 *
 * PushService.attachFleetNeedsInputSource turns a fleet "blocked on user" notice
 * into a 'needs-input' push carrying the session/node deep link, with presence
 * suppression and per-node de-dup. These tests drive the source with hand-built
 * notices and capture the composed PushMessage by overriding deliver().
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { PushService } from '../packages/sdk/src/platform/push/index.js';
import type { FleetNotice, PushMessage, VapidManager, PushSubscriptionStore } from '../packages/sdk/src/platform/push/index.js';
import { trackDisposables } from './_helpers/disposables.ts';
import { cancellableEscalationScheduler } from './_helpers/push-escalation.ts';

const disposables = trackDisposables();

/**
 * Every block these tests push arms a real ~5-minute escalation timer. They ran
 * to the end of the shared test process with nothing able to cancel them until
 * PushService.dispose() existed; now each service is registered here and put
 * down after the test that made it.
 */
const built: PushService[] = [];
afterEach(() => {
  for (const service of built.splice(0)) service.dispose();
});

function makeService(): { service: PushService; delivered: PushMessage[] } {
  // Both halves, deliberately. The injected scheduler keeps an escalation timer
  // from outliving the test whatever the service does, and tracking the service
  // for dispose() exercises PushService.dispose() itself, which is the thing
  // this round added, and would otherwise be covered nowhere.
  const service = new PushService({
    vapid: {} as VapidManager,
    store: {} as PushSubscriptionStore,
    scheduler: cancellableEscalationScheduler(disposables),
  });
  built.push(service);
  const delivered: PushMessage[] = [];
  // Override the fan-out to capture the composed message without touching the
  // encryption/transport path (covered elsewhere).
  (service as unknown as { deliver: (m: PushMessage) => Promise<unknown[]> }).deliver = async (m: PushMessage) => {
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

const blocked = (nodeId: string, sessionId?: string, reason: 'approval' | 'input' = 'approval'): FleetNotice => ({
  type: 'FLEET_NODE_BLOCKED_ON_USER',
  nodeId,
  label: `task-${nodeId}`,
  reason,
  ...(sessionId ? { sessionId } : {}),
});

describe('PushService.attachFleetNeedsInputSource', () => {
  test('a blocked node delivers a needs-input push with the session/node deep link', async () => {
    const { service, delivered } = makeService();
    const { source, push } = fakeSource();
    service.attachFleetNeedsInputSource(source);

    push(blocked('n1', 's1'));
    await Promise.resolve();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      title: 'Input needed',
      urgency: 'high',
      data: { kind: 'needs-input', sessionId: 's1', nodeId: 'n1' },
    });
  });

  test('presence suppression: no push when an operator is attached to the session', async () => {
    const { service, delivered } = makeService();
    const { source, push } = fakeSource();
    service.attachFleetNeedsInputSource(source, { isAttached: (id) => id === 's1' });

    push(blocked('n1', 's1'));
    await Promise.resolve();

    expect(delivered).toHaveLength(0);
  });

  test('a block on a session with no attached operator still pushes', async () => {
    const { service, delivered } = makeService();
    const { source, push } = fakeSource();
    service.attachFleetNeedsInputSource(source, { isAttached: (id) => id === 'other' });

    push(blocked('n1', 's1'));
    await Promise.resolve();

    expect(delivered).toHaveLength(1);
  });

  test('a node is de-duped until it unblocks, then a re-block notifies again', async () => {
    const { service, delivered } = makeService();
    const { source, push } = fakeSource();
    service.attachFleetNeedsInputSource(source);

    push(blocked('n1', 's1'));
    push(blocked('n1', 's1')); // duplicate — suppressed
    await Promise.resolve();
    expect(delivered).toHaveLength(1);

    push({ type: 'FLEET_NODE_UNBLOCKED', nodeId: 'n1' });
    push(blocked('n1', 's1')); // re-block after clear — notifies again
    await Promise.resolve();
    expect(delivered).toHaveLength(2);
  });

  test('FLEET_NODE_FINISHED also clears the de-dup entry', async () => {
    const { service, delivered } = makeService();
    const { source, push } = fakeSource();
    service.attachFleetNeedsInputSource(source);

    push(blocked('n1', 's1'));
    push({ type: 'FLEET_NODE_FINISHED', nodeId: 'n1' });
    push(blocked('n1', 's1'));
    await Promise.resolve();
    expect(delivered).toHaveLength(2);
  });

  test('non-block fleet notices never push', async () => {
    const { service, delivered } = makeService();
    const { source, push } = fakeSource();
    service.attachFleetNeedsInputSource(source);

    push({ type: 'FLEET_NODE_STARTED', nodeId: 'n1' });
    push({ type: 'FLEET_NODE_STATE_CHANGED', nodeId: 'n1' });
    await Promise.resolve();
    expect(delivered).toHaveLength(0);
  });
});

describe('PushService.dispose', () => {
  /**
   * Every outstanding block holds one armed escalation timer, and until dispose()
   * existed the only ways to cancel one were to answer the ask or to inject the
   * scheduler seam. A daemon shutting down with blocked asks outstanding could
   * not put them down at all, so this measures the real scheduler's handles,
   * not a stand-in.
   */
  function makeRealTimerService(): { service: PushService; armed: number; cancelled: () => number } {
    const cancels: (() => void)[] = [];
    let armedCount = 0;
    let cancelledCount = 0;
    const service = new PushService({
      vapid: {} as VapidManager,
      store: {} as PushSubscriptionStore,
      scheduler: {
        schedule: (fn, delayMs) => {
          armedCount += 1;
          const handle = setTimeout(fn, delayMs);
          const cancel = (): void => { cancelledCount += 1; clearTimeout(handle); };
          cancels.push(cancel);
          return cancel;
        },
      },
    });
    (service as unknown as { deliver: () => Promise<unknown[]> }).deliver = async () => [];
    return { service, get armed() { return armedCount; }, cancelled: () => cancelledCount };
  }

  test('dispose() cancels every armed escalation timer and forgets the blocks', () => {
    const { service, cancelled } = makeRealTimerService();
    const { source, push } = fakeSource();
    service.attachFleetNeedsInputSource(source);

    push(blocked('n1', 's1'));
    push(blocked('n2', 's2'));
    push(blocked('n3', 's3'));
    expect(cancelled()).toBe(0);

    service.dispose();
    expect(cancelled()).toBe(3);
  });

  test('dispose() is idempotent and a disposed service tracks nothing new to leave behind', () => {
    const { service, cancelled } = makeRealTimerService();
    const { source, push } = fakeSource();
    service.attachFleetNeedsInputSource(source);

    push(blocked('n1', 's1'));
    service.dispose();
    service.dispose();
    expect(cancelled()).toBe(1);
  });
});
