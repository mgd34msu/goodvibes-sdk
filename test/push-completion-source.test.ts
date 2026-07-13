/**
 * push-completion-source.test.ts
 *
 * PushService.attachCompletionSource — completion push with no setup: a
 * tracked run reaching a terminal state (FLEET_NODE_FINISHED) fans out to
 * every paired push target BY DEFAULT; the notifications.pushCompletion class
 * toggle exists only to silence it. Mirrors push-needs-input-source.test.ts:
 * hand-built notices, deliver() overridden to capture composed messages.
 */
import { describe, expect, test } from 'bun:test';
import { PushService } from '../packages/sdk/src/platform/push/index.js';
import type {
  FleetNotice,
  PushMessage,
  PushNotificationCategory,
  VapidManager,
  PushSubscriptionStore,
} from '../packages/sdk/src/platform/push/index.js';

function makeService(
  isCategoryEnabled?: (category: PushNotificationCategory) => boolean,
): { service: PushService; delivered: PushMessage[] } {
  const service = new PushService({
    vapid: {} as VapidManager,
    store: {} as PushSubscriptionStore,
    ...(isCategoryEnabled ? { isCategoryEnabled } : {}),
  });
  const delivered: PushMessage[] = [];
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

const finished = (nodeId: string, over: Partial<FleetNotice> = {}): FleetNotice => ({
  type: 'FLEET_NODE_FINISHED',
  nodeId,
  label: `long task ${nodeId}`,
  kind: 'agent',
  state: 'done',
  sessionId: 's1',
  ...over,
});

describe('PushService.attachCompletionSource', () => {
  test('ZERO CONFIGURATION: a completed long task pushes to the paired target by default', async () => {
    const { service, delivered } = makeService(); // no toggles wired at all
    const { source, push } = fakeSource();
    service.attachCompletionSource(source);

    push(finished('n1'));
    await Promise.resolve();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      title: 'Run completed',
      body: 'long task n1 completed.',
      urgency: 'normal',
      data: { kind: 'completion', sessionId: 's1', nodeId: 'n1' },
    });
  });

  test('failed and killed terminal states push with honest wording', async () => {
    const { service, delivered } = makeService();
    const { source, push } = fakeSource();
    service.attachCompletionSource(source);

    push(finished('n1', { state: 'failed' }));
    push(finished('n2', { state: 'killed' }));
    await Promise.resolve();

    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toMatchObject({ title: 'Run finished', body: 'long task n1 failed.' });
    expect(delivered[1]).toMatchObject({ title: 'Run finished', body: 'long task n2 was killed.' });
  });

  test('the class toggle silences it — and is read LIVE, never a working prerequisite', async () => {
    let completionOn = true;
    const { service, delivered } = makeService((category) => (category === 'completion' ? completionOn : true));
    const { source, push } = fakeSource();
    service.attachCompletionSource(source);

    completionOn = false;
    push(finished('n1'));
    await Promise.resolve();
    expect(delivered).toHaveLength(0); // silenced

    completionOn = true;
    push(finished('n2'));
    await Promise.resolve();
    expect(delivered).toHaveLength(1); // re-enabled live, no re-wiring needed
  });

  test('one push per node id — a re-published terminal event does not re-notify', async () => {
    const { service, delivered } = makeService();
    const { source, push } = fakeSource();
    service.attachCompletionSource(source);

    push(finished('n1'));
    push(finished('n1'));
    await Promise.resolve();
    expect(delivered).toHaveLength(1);
  });

  test('scoped to run-level kinds: subtask/work-item/phase children do not double-notify', async () => {
    const { service, delivered } = makeService();
    const { source, push } = fakeSource();
    service.attachCompletionSource(source);

    push(finished('child-1', { kind: 'subtask' }));
    push(finished('child-2', { kind: 'work-item' }));
    push(finished('infra-1', { kind: 'watcher' }));
    push(finished('run-1', { kind: 'chain' }));
    await Promise.resolve();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.data).toMatchObject({ kind: 'completion', nodeId: 'run-1' });
  });

  test('non-terminal fleet notices never push as completions', async () => {
    const { service, delivered } = makeService();
    const { source, push } = fakeSource();
    service.attachCompletionSource(source);

    push({ type: 'FLEET_NODE_STARTED', nodeId: 'n1', kind: 'agent' });
    push({ type: 'FLEET_NODE_STATE_CHANGED', nodeId: 'n1', kind: 'agent', state: 'thinking' });
    push({ type: 'FLEET_NODE_BLOCKED_ON_USER', nodeId: 'n1', kind: 'agent', reason: 'approval' });
    await Promise.resolve();

    expect(delivered).toHaveLength(0);
  });

  test('the approval and needs-input classes honor their own toggles too', async () => {
    const { service, delivered } = makeService((category) => category === 'completion');
    const { source, push } = fakeSource();
    service.attachFleetNeedsInputSource(source);
    service.attachCompletionSource(source);
    service.attachApprovalSource({
      subscribe: (listener) => {
        listener({ id: 'a1', status: 'pending' });
        return () => {};
      },
    });

    push({ type: 'FLEET_NODE_BLOCKED_ON_USER', nodeId: 'n1', label: 't', reason: 'approval' });
    push(finished('n2'));
    await Promise.resolve();

    // approval + needs-input silenced by their toggles; completion delivered.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.data).toMatchObject({ kind: 'completion', nodeId: 'n2' });
  });
});
