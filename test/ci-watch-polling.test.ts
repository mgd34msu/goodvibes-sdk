/**
 * ci-watch-polling.test.ts — "fix this" on a red CI run, end to end with a
 * mocked status source:
 *
 *   red → offer (through the approval machinery) → accept → fix-session
 *   seeded with the failing jobs' logs; decline → no session; verdict
 *   delivered → the watch retires; the daemon poll registers on the watcher
 *   registry with a rate-limit-respecting cadence and an overlap guard.
 */
import { describe, expect, test } from 'bun:test';
import {
  CiWatchService,
  CiWatchStore,
  registerCiWatchPolling,
  runCiWatchPollPass,
  CI_WATCH_POLLER_ID,
  MIN_CI_POLL_INTERVAL_MS,
  DEFAULT_CI_POLL_INTERVAL_MS,
  type CiJob,
  type CiStatusSource,
  type FixSessionBrief,
} from '../packages/sdk/src/platform/ci-watch/index.ts';

function job(name: string, conclusion: string | null): CiJob {
  return { name, status: conclusion === null ? 'in_progress' : 'completed', conclusion };
}

function fakeSource(jobs: () => CiJob[]): CiStatusSource {
  return {
    fetchJobs: async () => jobs(),
    fetchFailureLogs: async ({ jobNames }) => `seeded logs for ${jobNames.join(',')}`,
  };
}

/** Deferred so tests control exactly when the human "answers" the offer. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('red → offer → accept → seeded fix session', () => {
  function makeService(input: {
    jobs: () => CiJob[];
    offers: FixSessionBrief[];
    answer: () => Promise<boolean>;
    briefs: FixSessionBrief[];
  }): CiWatchService {
    return new CiWatchService({
      source: fakeSource(input.jobs),
      store: new CiWatchStore(':memory:'),
      notifier: async () => 'note-1',
      fixSessionOffer: async (brief) => { input.offers.push(brief); return input.answer(); },
      fixSessionStarter: async (brief) => { input.briefs.push(brief); return 'fix-session-1'; },
    });
  }

  test('acceptance starts the fix session seeded with the failing jobs\' logs', async () => {
    const offers: FixSessionBrief[] = [];
    const briefs: FixSessionBrief[] = [];
    const answer = deferred<boolean>();
    const service = makeService({ jobs: () => [job('build', 'failure'), job('test', 'failure')], offers, answer: () => answer.promise, briefs });
    const watch = await service.createWatch({ repo: 'o/r', prNumber: 7, deliveryChannel: 'slack:C1' });

    const result = await service.checkWatch(watch.id);

    // The offer was raised and did NOT block the check (fire-and-forget).
    expect(result.fixSessionOffered).toBe(true);
    expect(result.fixSessionTriggered).toBe(false);
    await flush();
    expect(offers).toHaveLength(1);
    expect(offers[0]!).toMatchObject({ repo: 'o/r', prNumber: 7, failingJobs: ['build', 'test'] });
    expect(briefs).toHaveLength(0); // not started until accepted

    // Accept — the SAME brief (failing jobs + logs) seeds the session.
    answer.resolve(true);
    await flush();
    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.logs).toBe('seeded logs for build,test');
    expect(briefs[0]!.failingJobs).toEqual(['build', 'test']);
  });

  test('declining the offer starts nothing', async () => {
    const offers: FixSessionBrief[] = [];
    const briefs: FixSessionBrief[] = [];
    const service = makeService({ jobs: () => [job('build', 'failure')], offers, answer: async () => false, briefs });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack' });

    await service.checkWatch(watch.id);
    await flush();

    expect(offers).toHaveLength(1);
    expect(briefs).toHaveLength(0);
  });

  test('a green verdict raises no offer and retires the watch once delivered', async () => {
    const offers: FixSessionBrief[] = [];
    const briefs: FixSessionBrief[] = [];
    const service = makeService({ jobs: () => [job('build', 'success')], offers, answer: async () => true, briefs });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack' });

    const result = await service.checkWatch(watch.id);
    await flush();

    expect(result.report.overall).toBe('passed');
    expect(result.retired).toBe(true);
    expect(offers).toHaveLength(0);
    expect(await service.listWatches()).toHaveLength(0);
  });

  test('the auto-start opt-in (triggerFixSession) still bypasses the offer', async () => {
    const offers: FixSessionBrief[] = [];
    const briefs: FixSessionBrief[] = [];
    const service = makeService({ jobs: () => [job('build', 'failure')], offers, answer: async () => true, briefs });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack', triggerFixSession: true });

    const result = await service.checkWatch(watch.id);

    expect(result.fixSessionTriggered).toBe(true);
    expect(result.fixSessionId).toBe('fix-session-1');
    expect(result.fixSessionOffered).toBeUndefined();
    expect(offers).toHaveLength(0);
  });
});

describe('daemon polling over the watcher registry', () => {
  function makePollHost(): {
    host: { registerPollingWatcher: (input: { id: string; intervalMs: number; run: () => Promise<string | void> | string | void }) => void; startWatcher: (id: string) => void };
    registered: Array<{ id: string; intervalMs: number; run: () => Promise<string | void> | string | void }>;
    started: string[];
  } {
    const registered: Array<{ id: string; intervalMs: number; run: () => Promise<string | void> | string | void }> = [];
    const started: string[] = [];
    return {
      host: {
        registerPollingWatcher: (input) => { registered.push(input); },
        startWatcher: (id) => { started.push(id); },
      },
      registered,
      started,
    };
  }

  test('polling registers on the scheduling machinery and is started', async () => {
    const { host, registered, started } = makePollHost();
    const service = new CiWatchService({ source: fakeSource(() => [job('build', null)]), store: new CiWatchStore(':memory:') });
    await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack' });

    registerCiWatchPolling(host, service);

    expect(registered).toHaveLength(1);
    expect(registered[0]!.id).toBe(CI_WATCH_POLLER_ID);
    expect(registered[0]!.intervalMs).toBe(DEFAULT_CI_POLL_INTERVAL_MS);
    expect(started).toEqual([CI_WATCH_POLLER_ID]);

    const summary = await registered[0]!.run();
    expect(summary).toBe('checked 1/1 watch(es)');
  });

  test('the cadence respects the rate-limit floor', () => {
    const { host, registered } = makePollHost();
    const service = new CiWatchService({ source: fakeSource(() => []), store: new CiWatchStore(':memory:') });
    registerCiWatchPolling(host, service, { intervalMs: 1 }); // absurdly hot — clamped
    expect(registered[0]!.intervalMs).toBe(MIN_CI_POLL_INTERVAL_MS);
  });

  test('a full poll pass drives red → offer → accept → seeded session, then the watch is gone', async () => {
    const offers: FixSessionBrief[] = [];
    const briefs: FixSessionBrief[] = [];
    const service = new CiWatchService({
      source: fakeSource(() => [job('build', 'failure')]),
      store: new CiWatchStore(':memory:'),
      notifier: async () => 'n1',
      fixSessionOffer: async (brief) => { offers.push(brief); return true; },
      fixSessionStarter: async (brief) => { briefs.push(brief); return 'fix-1'; },
    });
    await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack' });

    const summary = await runCiWatchPollPass(service);
    await flush();

    expect(summary).toBe('checked 1/1 watch(es), 1 retired');
    expect(offers).toHaveLength(1);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.logs).toContain('seeded logs for build');
    // Terminal verdict delivered → the watch retired; the next pass is empty.
    expect(await runCiWatchPollPass(service)).toBe('no watches registered');
  });

  test('one failing watch never starves the rest of the pass', async () => {
    const service = new CiWatchService({
      source: {
        fetchJobs: async ({ repo }) => {
          if (repo === 'bad/repo') throw new Error('gh exploded');
          return [job('build', null)];
        },
      },
      store: new CiWatchStore(':memory:'),
    });
    await service.createWatch({ repo: 'bad/repo', ref: 'main', deliveryChannel: 'slack' });
    await service.createWatch({ repo: 'good/repo', ref: 'main', deliveryChannel: 'slack' });

    const summary = await runCiWatchPollPass(service);
    expect(summary).toBe('checked 1/2 watch(es), 1 check(s) failed');
  });

  test('the overlap guard skips a tick while the previous pass is still running', async () => {
    const { host, registered } = makePollHost();
    const gate = deferred<CiJob[]>();
    const service = new CiWatchService({
      source: { fetchJobs: () => gate.promise },
      store: new CiWatchStore(':memory:'),
    });
    await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack' });
    registerCiWatchPolling(host, service);

    const first = registered[0]!.run() as Promise<string>; // blocks on the gate
    const second = await registered[0]!.run(); // overlapping tick
    expect(second).toBe('previous pass still running — skipped (overlap guard)');

    gate.resolve([job('build', null)]);
    expect(await first).toBe('checked 1/1 watch(es)');
  });
});
