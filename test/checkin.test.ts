/**
 * checkin.test.ts
 *
 * The proactive check-in loop: quiet-hours gating, briefing assembly, the
 * decision parser, the state reader, the full evaluate() loop (with fake judge +
 * deliverer proving conditional delivery and receipts), the checkin.* gateway
 * verbs, and the automation kind:'checkin' execution branch.
 */
import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerCheckinGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/checkin.ts';
import {
  CheckinService,
  CheckinReceiptStore,
  assembleCheckinBriefing,
  createRuntimeCheckinStateReader,
  isQuietHours,
  parseCheckinDecision,
  type CheckinDecision,
  type CheckinStateSnapshot,
} from '../packages/sdk/src/platform/checkin/index.ts';
import { executeCheckinJob } from '../packages/sdk/src/platform/automation/checkin-execution.ts';

const KEYS = {
  enabled: 'checkin.enabled',
  cadence: 'checkin.cadence',
  deliveryChannel: 'checkin.deliveryChannel',
  quietHours: 'checkin.quietHours',
} as const;

function fakeConfig(initial: Record<string, string | boolean>) {
  const store = new Map<string, string | boolean>(Object.entries(initial));
  return {
    access: {
      get: (k: string): unknown => store.get(k),
      set: (k: string, v: string | boolean): void => { store.set(k, v); },
    },
    store,
  };
}

const SNAPSHOT: CheckinStateSnapshot = {
  runningSessions: 2,
  blockedSessions: 1,
  unreadChannelItems: 3,
  recentCompletions: 4,
  needsAttention: ['deploy is waiting on input (1 pending)'],
};

function makeService(opts: {
  enabled?: boolean;
  quietHours?: string;
  decision: CheckinDecision;
  deliverResult?: string | undefined;
  now?: number;
}) {
  const { access } = fakeConfig({
    [KEYS.enabled]: opts.enabled ?? true,
    [KEYS.cadence]: '0 */4 * * *',
    [KEYS.deliveryChannel]: 'slack:C1',
    [KEYS.quietHours]: opts.quietHours ?? '',
  });
  const delivered: Array<{ channel: string; message: string }> = [];
  const receipts = new CheckinReceiptStore(':memory:');
  const service = new CheckinService({
    config: access,
    stateReader: { snapshot: async () => SNAPSHOT },
    judge: { decide: async () => opts.decision },
    deliverer: {
      deliver: async (channel, message) => {
        delivered.push({ channel, message });
        return opts.deliverResult;
      },
    },
    receipts,
    ...(opts.now !== undefined ? { now: () => opts.now! } : {}),
  });
  return { service, delivered, receipts };
}

describe('check-in building blocks', () => {
  test('parseCheckinDecision: contact needs a message, otherwise stays quiet honestly', () => {
    expect(parseCheckinDecision('{"contact":true,"reason":"blocked","message":"You have a blocked deploy"}'))
      .toEqual({ contact: true, reason: 'blocked', message: 'You have a blocked deploy' });
    expect(parseCheckinDecision('{"contact":false,"reason":"all quiet"}').contact).toBe(false);
    // contact:true with no message must NOT fabricate a reason to interrupt.
    expect(parseCheckinDecision('{"contact":true,"reason":"x"}').contact).toBe(false);
    expect(parseCheckinDecision('not json').contact).toBe(false);
    expect(parseCheckinDecision('').contact).toBe(false);
  });

  test('isQuietHours handles same-day and midnight-wrapping windows', () => {
    const at = (h: number, m = 0): number => new Date(2026, 6, 10, h, m).getTime();
    expect(isQuietHours(at(23), '22:00-08:00')).toBe(true);
    expect(isQuietHours(at(3), '22:00-08:00')).toBe(true);
    expect(isQuietHours(at(12), '22:00-08:00')).toBe(false);
    expect(isQuietHours(at(13), '09:00-17:00')).toBe(true);
    expect(isQuietHours(at(20), '09:00-17:00')).toBe(false);
    expect(isQuietHours(at(3), '')).toBe(false);
  });

  test('assembleCheckinBriefing renders the snapshot compactly', () => {
    const briefing = assembleCheckinBriefing(SNAPSHOT);
    expect(briefing).toContain('Running sessions: 2');
    expect(briefing).toContain('Needs attention:');
  });

  test('createRuntimeCheckinStateReader derives counts from sessions/runs', async () => {
    const reader = createRuntimeCheckinStateReader({
      now: () => 200_000_000,
      listSessions: () => [
        { status: 'open', activeAgentId: 'a1', pendingInputCount: 0, title: 's1', surfaceKinds: ['tui'] },
        { status: 'open', activeAgentId: undefined, pendingInputCount: 2, title: 's2', surfaceKinds: ['slack'] },
        { status: 'closed', activeAgentId: 'a3', pendingInputCount: 0, title: 's3', surfaceKinds: ['web'] },
      ],
      listRuns: () => [
        { status: 'completed', endedAt: 199_999_000 },
        { status: 'completed', endedAt: 1 },
        { status: 'failed', endedAt: 200_000_000 },
      ],
    });
    const snap = await reader.snapshot();
    expect(snap.runningSessions).toBe(1);
    expect(snap.blockedSessions).toBe(1);
    expect(snap.unreadChannelItems).toBe(2);
    expect(snap.recentCompletions).toBe(1);
    expect(snap.needsAttention).toHaveLength(1);
  });
});

describe('CheckinService.evaluate', () => {
  test('disabled -> skipped-disabled receipt, no delivery', async () => {
    const { service, delivered, receipts } = makeService({ enabled: false, decision: { contact: true, reason: 'x', message: 'm' } });
    const outcome = await service.evaluate('manual');
    expect(outcome.outcome).toBe('skipped');
    expect(delivered).toHaveLength(0);
    expect((await receipts.list())[0]!.outcome).toBe('skipped-disabled');
  });

  test('quiet hours -> skipped-quiet-hours receipt, no delivery', async () => {
    const now = new Date(2026, 6, 10, 3, 0).getTime();
    const { service, delivered, receipts } = makeService({ quietHours: '22:00-08:00', now, decision: { contact: true, reason: 'x', message: 'm' } });
    const outcome = await service.evaluate('scheduled');
    expect(outcome.outcome).toBe('skipped');
    expect(delivered).toHaveLength(0);
    expect((await receipts.list())[0]!.outcome).toBe('skipped-quiet-hours');
  });

  test('judge decides quiet -> quiet receipt, no delivery', async () => {
    const { service, delivered, receipts } = makeService({ decision: { contact: false, reason: 'nothing urgent' } });
    const outcome = await service.evaluate('scheduled');
    expect(outcome.outcome).toBe('quiet');
    expect(delivered).toHaveLength(0);
    const receipt = (await receipts.list())[0]!;
    expect(receipt.outcome).toBe('quiet');
    expect(receipt.decisionReason).toBe('nothing urgent');
  });

  test('judge decides contact -> delivers via channel and records a delivered receipt', async () => {
    const { service, delivered, receipts } = makeService({
      decision: { contact: true, reason: 'blocked deploy', message: 'Your deploy is blocked' },
      deliverResult: 'resp-9',
    });
    const outcome = await service.evaluate('scheduled');
    expect(outcome.outcome).toBe('delivered');
    expect(outcome.deliveryId).toBe('resp-9');
    expect(delivered).toEqual([{ channel: 'slack:C1', message: 'Your deploy is blocked' }]);
    const receipt = (await receipts.list())[0]!;
    expect(receipt.outcome).toBe('delivered');
    expect(receipt.deliveredMessage).toBe('Your deploy is blocked');
    expect(receipt.deliveryChannel).toBe('slack:C1');
  });

  test('a throwing deliverer -> error receipt, honest error outcome', async () => {
    const { access } = fakeConfig({ [KEYS.enabled]: true, [KEYS.cadence]: 'x', [KEYS.deliveryChannel]: 'slack', [KEYS.quietHours]: '' });
    const receipts = new CheckinReceiptStore(':memory:');
    const service = new CheckinService({
      config: access,
      stateReader: { snapshot: async () => SNAPSHOT },
      judge: { decide: async () => ({ contact: true, reason: 'r', message: 'm' }) },
      deliverer: { deliver: async () => { throw new Error('channel down'); } },
      receipts,
    });
    const outcome = await service.evaluate('manual');
    expect(outcome.outcome).toBe('error');
    expect((await receipts.list())[0]!.outcome).toBe('error');
  });
});

describe('checkin.* gateway verbs', () => {
  function makeCatalog() {
    const { access } = fakeConfig({ [KEYS.enabled]: false, [KEYS.cadence]: '0 */4 * * *', [KEYS.deliveryChannel]: '', [KEYS.quietHours]: '' });
    const service = new CheckinService({
      config: access,
      stateReader: { snapshot: async () => SNAPSHOT },
      judge: { decide: async () => ({ contact: false, reason: 'quiet' }) },
      deliverer: { deliver: async () => undefined },
      receipts: new CheckinReceiptStore(':memory:'),
    });
    const catalog = new GatewayMethodCatalog();
    registerCheckinGatewayMethods(catalog, service);
    return catalog;
  }
  const ctx = { context: { admin: true } } as const;

  test('all four verbs are cataloged with handlers attached', () => {
    const catalog = makeCatalog();
    for (const id of ['checkin.config.get', 'checkin.config.set', 'checkin.receipts.list', 'checkin.run']) {
      expect(catalog.get(id)).not.toBeNull();
      expect(catalog.hasHandler(id)).toBe(true);
    }
  });

  test('config.set updates config and is reflected by config.get; run records a receipt', async () => {
    const catalog = makeCatalog();
    const set = await catalog.invoke('checkin.config.set', { ...ctx, body: { enabled: true, quietHours: '22:00-08:00' } }) as { config: { enabled: boolean; quietHours: string } };
    expect(set.config.enabled).toBe(true);
    expect(set.config.quietHours).toBe('22:00-08:00');

    const got = await catalog.invoke('checkin.config.get', { ...ctx, body: {} }) as { config: { enabled: boolean } };
    expect(got.config.enabled).toBe(true);

    const ran = await catalog.invoke('checkin.run', { ...ctx, body: {} }) as { outcome: string };
    expect(['quiet', 'skipped', 'delivered', 'error']).toContain(ran.outcome);
    const receipts = await catalog.invoke('checkin.receipts.list', { ...ctx, body: { limit: 10 } }) as { receipts: unknown[] };
    expect(receipts.receipts.length).toBeGreaterThan(0);
  });
});

describe('automation kind:checkin execution branch', () => {
  test('executeCheckinJob records a completed run through the evaluator', async () => {
    const runs = new Map<string, { status: string }>();
    const jobs = new Map<string, unknown>();
    const events: string[] = [];
    // Minimal execution context — only the members executeCheckinJob touches.
    const context = {
      runs,
      jobs,
      saveJobs: async () => {},
      saveRuns: async () => {},
      pruneRunHistory: () => {},
      syncRunToRuntime: () => {},
      syncJobToRuntime: () => {},
      emitRunQueued: () => events.push('queued'),
      emitRunStarted: () => events.push('started'),
      emitRunCompleted: (_j: unknown, _r: unknown, outcome: string) => events.push(`completed:${outcome}`),
      emitRunFailed: () => events.push('failed'),
    } as never;
    const job = {
      id: 'checkin-scheduled',
      kind: 'checkin',
      source: { lastSeenAt: 0, updatedAt: 0 },
      execution: { target: { kind: 'isolated' }, prompt: 'x' },
      schedule: { kind: 'cron', expression: '0 */4 * * *' },
      runCount: 0,
      successCount: 0,
      failureCount: 0,
    } as never;

    const run = await executeCheckinJob(
      context,
      async () => ({ outcome: 'delivered', summary: 'delivered: blocked deploy', deliveryId: 'd1' }),
      job,
      'scheduled',
      true,
      1,
    );
    expect(run.status).toBe('completed');
    expect(run.deliveryIds).toEqual(['d1']);
    expect(events).toEqual(['queued', 'started', 'completed:success']);
    expect(runs.get(run.id)!.status).toBe('completed');
  });
});
