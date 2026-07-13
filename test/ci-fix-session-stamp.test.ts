/**
 * The accepted "fix this?" offer's spawned session id must not strand: after
 * the starter returns, the id is stamped onto the RESOLVED approval record
 * (broker seam) and published live, so the surface that accepted — attached
 * right now — has an in-process handle to open the session. The channel
 * notification is unchanged; a denied offer is never stamped; the auto-start
 * path is unchanged.
 */
import { describe, expect, test } from 'bun:test';
import { ApprovalBroker } from '../packages/sdk/src/platform/control-plane/approval-broker.ts';
import type { SharedApprovalRecord } from '../packages/sdk/src/platform/control-plane/approval-broker.ts';
import { CiWatchService } from '../packages/sdk/src/platform/ci-watch/service.ts';
import { CiWatchStore } from '../packages/sdk/src/platform/ci-watch/subscriptions.ts';
import type { CiJob, CiStatusSource, FixSessionBrief } from '../packages/sdk/src/platform/ci-watch/types.ts';

function failingSource(): CiStatusSource {
  const job: CiJob = { name: 'build', status: 'completed', conclusion: 'failure' };
  return {
    fetchJobs: async () => [job],
    fetchFailureLogs: async ({ jobNames }) => `logs for ${jobNames.join(',')}`,
  };
}

/** Production-shaped wiring: the offer rides a REAL broker; `decide` resolves the ask. */
function wireService(broker: ApprovalBroker, opts: { approve: boolean; starterId?: string | undefined }) {
  const offer = async (brief: FixSessionBrief) => {
    const offerCallId = `ci-fix-${brief.repo.replace('/', '-')}`;
    const decisionPromise = broker.requestApproval({
      request: {
        callId: offerCallId,
        tool: 'ci:fix-session',
        args: { repo: brief.repo, failingJobs: [...brief.failingJobs] },
        category: 'delegate',
        analysis: { classification: 'ci-fix-session', riskLevel: 'medium', summary: 'fix?', reasons: ['red run'] },
      },
      metadata: { source: 'ci-watch', repo: brief.repo },
    });
    // The operator decides on the rendered card.
    await Bun.sleep(2);
    const pending = broker.listApprovals(10).find((record) => record.request.callId === offerCallId)!;
    await broker.resolveApproval(pending.id, { approved: opts.approve, actor: 'operator', actorSurface: 'tui' });
    const decision = await decisionPromise;
    return { accepted: decision.approved, offerCallId };
  };
  return new CiWatchService({
    source: failingSource(),
    store: new CiWatchStore(':memory:'),
    notifier: async () => 'note-1',
    fixSessionOffer: offer,
    fixSessionStarter: async () => opts.starterId ?? 'fix-sess-1',
    stampFixSession: (offerCallId, fixSessionId) => broker.stampFixSession(offerCallId, fixSessionId),
  });
}

async function waitFor(check: () => boolean, ms = 500): Promise<void> {
  const start = Date.now();
  while (!check() && Date.now() - start < ms) await Bun.sleep(5);
}

describe('accepted fix-this offers stamp the spawned session onto the approval record', () => {
  test('an accepted offer gains fixSessionId — observable through the broker subscription AND listApprovals', async () => {
    const broker = new ApprovalBroker({ storePath: ':memory:' });
    const liveUpdates: SharedApprovalRecord[] = [];
    broker.subscribe((record) => liveUpdates.push(record));
    const service = wireService(broker, { approve: true, starterId: 'fix-sess-42' });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack:C1' });

    const result = await service.checkWatch(watch.id);
    expect(result.fixSessionOffered).toBe(true);

    // The offer acceptance runs async after the verb result returns.
    await waitFor(() => liveUpdates.some((record) => record.fixSessionId === 'fix-sess-42'));

    // Live: an already-attached subscriber saw the record change.
    const live = liveUpdates.find((record) => record.fixSessionId === 'fix-sess-42');
    expect(live).toBeDefined();
    expect(live!.status).toBe('approved');
    expect(live!.request.tool).toBe('ci:fix-session');

    // At rest: a listApprovals read serves the same handle.
    const listed = broker.listApprovals(10).find((record) => record.request.tool === 'ci:fix-session')!;
    expect(listed.fixSessionId).toBe('fix-sess-42');
  });

  test('a denied offer never gains fixSessionId and never starts a session', async () => {
    const broker = new ApprovalBroker({ storePath: ':memory:' });
    let started = 0;
    const service = new CiWatchService({
      source: failingSource(),
      store: new CiWatchStore(':memory:'),
      notifier: async () => 'note-1',
      fixSessionOffer: async (brief) => {
        const offerCallId = `ci-fix-${brief.repo.replace('/', '-')}`;
        const decisionPromise = broker.requestApproval({
          request: {
            callId: offerCallId,
            tool: 'ci:fix-session',
            args: { repo: brief.repo },
            category: 'delegate',
            analysis: { classification: 'ci-fix-session', riskLevel: 'medium', summary: 'fix?', reasons: ['red run'] },
          },
        });
        await Bun.sleep(2);
        const pending = broker.listApprovals(10).find((record) => record.request.callId === offerCallId)!;
        await broker.resolveApproval(pending.id, { approved: false, actor: 'operator', actorSurface: 'tui' });
        return { accepted: (await decisionPromise).approved, offerCallId };
      },
      fixSessionStarter: async () => { started += 1; return 'never-used'; },
      stampFixSession: (offerCallId, fixSessionId) => broker.stampFixSession(offerCallId, fixSessionId),
    });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack:C1' });
    await service.checkWatch(watch.id);
    await Bun.sleep(20);

    expect(started).toBe(0);
    const record = broker.listApprovals(10).find((r) => r.request.tool === 'ci:fix-session')!;
    expect(record.status).toBe('denied');
    expect(record.fixSessionId).toBeUndefined();
    // The broker refuses to stamp a non-approved record even if asked.
    expect(await broker.stampFixSession(record.request.callId, 'sneaky')).toBeNull();
    expect(broker.listApprovals(10).find((r) => r.request.tool === 'ci:fix-session')!.fixSessionId).toBeUndefined();
  });

  test('the auto-start path is unchanged: no approval record, no stamp, id on the verb result', async () => {
    const broker = new ApprovalBroker({ storePath: ':memory:' });
    let stamps = 0;
    const service = new CiWatchService({
      source: failingSource(),
      store: new CiWatchStore(':memory:'),
      notifier: async () => 'note-1',
      fixSessionStarter: async () => 'auto-sess-7',
      stampFixSession: async (offerCallId, fixSessionId) => { stamps += 1; return broker.stampFixSession(offerCallId, fixSessionId); },
    });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack:C1', triggerFixSession: true });
    const result = await service.checkWatch(watch.id);
    expect(result.fixSessionTriggered).toBe(true);
    expect(result.fixSessionId).toBe('auto-sess-7');
    expect(stamps).toBe(0);
    expect(broker.listApprovals(10)).toHaveLength(0);
  });

  test('a bare boolean offer outcome (no approval record) still starts the session without stamping', async () => {
    let stamps = 0;
    const notes: string[] = [];
    const service = new CiWatchService({
      source: failingSource(),
      store: new CiWatchStore(':memory:'),
      notifier: async (_c, title) => { notes.push(title); return 'n'; },
      fixSessionOffer: async () => true,
      fixSessionStarter: async () => 'plain-sess-1',
      stampFixSession: async () => { stamps += 1; return null; },
    });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack:C1' });
    await service.checkWatch(watch.id);
    await Bun.sleep(20);
    expect(stamps).toBe(0);
    expect(notes.some((title) => title.includes('fix session started'))).toBe(true);
  });
});
