/**
 * ci-watch.test.ts
 *
 * The CI-watch doctrine and mechanism: the per-job verdict (never a rollup),
 * the continue-on-error ban, the one-shot status tool, subscription CRUD, and
 * the standing-watch completion notification + opt-in fix-session trigger.
 */
import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerCiGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/ci.ts';
import {
  CiWatchService,
  CiWatchStore,
  deriveCiReport,
  deriveOverall,
  type CiJob,
  type CiStatusSource,
  type FixSessionBrief,
} from '../packages/sdk/src/platform/ci-watch/index.ts';

function job(name: string, conclusion: string | null, extra: Partial<CiJob> = {}): CiJob {
  return { name, status: conclusion === null ? 'in_progress' : 'completed', conclusion, ...extra };
}

describe('CI-watch per-job doctrine', () => {
  test('verdict is derived from per-job conclusions, not a rollup', () => {
    expect(deriveOverall([job('a', 'success'), job('b', 'success')], false)).toBe('passed');
    expect(deriveOverall([job('a', 'success'), job('b', 'failure')], false)).toBe('failed');
    expect(deriveOverall([job('a', 'success'), job('b', null)], false)).toBe('pending');
    expect(deriveOverall([], false)).toBe('unknown');
  });

  test('a continue-on-error job is a violation and forces the verdict off "passed"', () => {
    const report = deriveCiReport({
      repo: 'o/r',
      ref: 'main',
      // A naive rollup would call this green: every visible conclusion is success.
      jobs: [job('build', 'success'), job('flaky', 'success', { continueOnError: true })],
      now: 1,
    });
    expect(report.violations.length).toBe(1);
    expect(report.overall).toBe('failed');
  });

  test('an unrecognized conclusion is a violation and not counted as passed', () => {
    const report = deriveCiReport({ repo: 'o/r', jobs: [job('x', 'weird_status')], now: 1 });
    expect(report.overall).toBe('failed');
    expect(report.violations.length).toBe(1);
  });

  test('the report lists every job and its conclusion', () => {
    const report = deriveCiReport({ repo: 'o/r', jobs: [job('a', 'success'), job('b', 'failure')], now: 1 });
    expect(report.jobs.map((j) => `${j.name}:${j.conclusion}`)).toEqual(['a:success', 'b:failure']);
  });
});

function fakeSource(jobs: CiJob[]): CiStatusSource {
  return {
    fetchJobs: async () => jobs,
    fetchFailureLogs: async ({ jobNames }) => `logs for ${jobNames.join(',')}`,
  };
}

describe('CiWatchService', () => {
  test('status returns the per-job report for a repo/ref', async () => {
    const service = new CiWatchService({ source: fakeSource([job('build', 'success')]), store: new CiWatchStore(':memory:') });
    const report = await service.status({ repo: 'o/r', ref: 'main' });
    expect(report.overall).toBe('passed');
    expect(report.jobs).toHaveLength(1);
  });

  test('watch CRUD round-trips and requires a ref or PR', async () => {
    const service = new CiWatchService({ source: fakeSource([]), store: new CiWatchStore(':memory:') });
    await expect(service.createWatch({ repo: 'o/r', deliveryChannel: 'slack' })).rejects.toThrow();
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack', triggerFixSession: true });
    expect((await service.listWatches())).toHaveLength(1);
    expect(await service.deleteWatch(watch.id)).toBe(true);
    expect(await service.deleteWatch(watch.id)).toBe(false);
  });

  test('checkWatch notifies once on transition and triggers an opted-in fix-session on failure', async () => {
    const notes: Array<{ channel: string; title: string; body: string }> = [];
    const briefs: FixSessionBrief[] = [];
    const service = new CiWatchService({
      source: fakeSource([job('build', 'failure')]),
      store: new CiWatchStore(':memory:'),
      notifier: async (channel, title, body) => { notes.push({ channel, title, body }); return 'note-1'; },
      fixSessionStarter: async (brief) => { briefs.push(brief); return 'fix-1'; },
    });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack:C1', triggerFixSession: true });

    const first = await service.checkWatch(watch.id);
    expect(first.report.overall).toBe('failed');
    expect(first.notified).toBe(true);
    expect(first.fixSessionTriggered).toBe(true);
    expect(first.fixSessionId).toBe('fix-1');
    expect(briefs[0]!.failingJobs).toEqual(['build']);
    expect(briefs[0]!.logs).toContain('logs for build');

    // The verdict was delivered — the watch's job is done: it RETIRES, which
    // is the strongest form of never-notify-twice.
    expect(first.retired).toBe(true);
    expect(await service.listWatches()).toHaveLength(0);
    await expect(service.checkWatch(watch.id)).rejects.toThrow(/No CI watch/);
    // The failure verdict + the started fix-session (with its id in the
    // payload so a surface can open/attach the session).
    expect(notes).toHaveLength(2);
    expect(notes[1]!.title).toBe('CI fix session started — o/r');
    expect(notes[1]!.body).toContain('sessionId: fix-1');
  });

  test('the accepted "fix this?" offer delivers the started session id through the channel payload', async () => {
    const notes: Array<{ title: string; body: string }> = [];
    let resolveOffer: ((accepted: boolean) => void) | undefined;
    const offerAnswered = new Promise<boolean>((resolve) => { resolveOffer = resolve; });
    const service = new CiWatchService({
      source: fakeSource([job('build', 'failure')]),
      store: new CiWatchStore(':memory:'),
      notifier: async (_channel, title, body) => { notes.push({ title, body }); return 'note-1'; },
      fixSessionOffer: async () => offerAnswered,
      fixSessionStarter: async () => 'fix-offer-77',
    });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack:C1' });

    const result = await service.checkWatch(watch.id);
    expect(result.fixSessionOffered).toBe(true);
    // The verb result returned before the human decided — the id arrives via
    // the notification payload once the offer is accepted.
    expect(result.fixSessionId).toBeUndefined();

    resolveOffer!(true);
    await Bun.sleep(5);
    const started = notes.find((note) => note.title === 'CI fix session started — o/r');
    expect(started).toBeDefined();
    expect(started!.body).toContain('sessionId: fix-offer-77');
  });

  test('without a notifier the verdict is NOT delivered, so the watch stays (honest fire-once)', async () => {
    const service = new CiWatchService({
      source: fakeSource([job('build', 'failure')]),
      store: new CiWatchStore(':memory:'),
    });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack' });
    const result = await service.checkWatch(watch.id);
    expect(result.notified).toBe(false);
    expect(result.retired).toBeUndefined();
    expect(await service.listWatches()).toHaveLength(1);
  });

  test('a watch that did NOT opt in never starts a fix-session, even on failure', async () => {
    const briefs: FixSessionBrief[] = [];
    const service = new CiWatchService({
      source: fakeSource([job('build', 'failure')]),
      store: new CiWatchStore(':memory:'),
      notifier: async () => 'n',
      fixSessionStarter: async (brief) => { briefs.push(brief); return 'fix'; },
    });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack', triggerFixSession: false });
    const result = await service.checkWatch(watch.id);
    expect(result.fixSessionTriggered).toBe(false);
    expect(briefs).toHaveLength(0);
  });
});

describe('ci.* gateway verbs', () => {
  function makeCatalog(jobs: CiJob[]) {
    const service = new CiWatchService({ source: fakeSource(jobs), store: new CiWatchStore(':memory:') });
    const catalog = new GatewayMethodCatalog();
    registerCiGatewayMethods(catalog, service);
    return catalog;
  }
  const ctx = { context: { admin: true } } as const;

  test('all five verbs are cataloged with handlers attached', () => {
    const catalog = makeCatalog([]);
    for (const id of ['ci.status', 'ci.watches.list', 'ci.watches.create', 'ci.watches.delete', 'ci.watches.run']) {
      expect(catalog.get(id)).not.toBeNull();
      expect(catalog.hasHandler(id)).toBe(true);
    }
  });

  test('ci.status lists jobs and conclusions; watches create/list/delete round-trip', async () => {
    const catalog = makeCatalog([job('build', 'success'), job('test', 'failure')]);
    const status = await catalog.invoke('ci.status', { ...ctx, body: { repo: 'o/r', ref: 'main' } }) as { report: { overall: string; jobs: unknown[] } };
    expect(status.report.overall).toBe('failed');
    expect(status.report.jobs).toHaveLength(2);

    const created = await catalog.invoke('ci.watches.create', { ...ctx, body: { repo: 'o/r', prNumber: 12, deliveryChannel: 'slack' } }) as { watch: { id: string } };
    const listed = await catalog.invoke('ci.watches.list', { ...ctx, body: {} }) as { watches: unknown[] };
    expect(listed.watches).toHaveLength(1);
    const deleted = await catalog.invoke('ci.watches.delete', { ...ctx, body: { watchId: created.watch.id } });
    expect(deleted).toEqual({ watchId: created.watch.id, deleted: true });
  });

  test('ci.status without a repo is a 400', async () => {
    const catalog = makeCatalog([]);
    const error = await catalog.invoke('ci.status', { ...ctx, body: {} }).catch((e) => e);
    expect((error as { status?: number }).status).toBe(400);
  });
});
