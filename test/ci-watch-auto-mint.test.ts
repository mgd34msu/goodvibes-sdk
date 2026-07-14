/**
 * ci-watch-auto-mint.test.ts — CI watches mint and retire themselves.
 *
 * Work done through the platform that pushes a branch (a successful exec
 * containing `git push`, or a GitService push) creates its own watch with no
 * ceremony; the daemon poller covers it like any other watch; a red verdict
 * raises the "fix this?" offer; the delivered terminal verdict retires the
 * watch. The scripted path (ci.watches.create) survives untouched.
 */
import { describe, expect, test } from 'bun:test';
import {
  CiWatchAutoMinter,
  detectCiPushInCommand,
  execCommandsFromArgs,
  parseGitHubSlug,
  DEFAULT_AUTO_WATCH_CHANNEL,
} from '../packages/sdk/src/platform/ci-watch/auto-watch.ts';
import { CiWatchService } from '../packages/sdk/src/platform/ci-watch/service.ts';
import { runCiWatchPollPass } from '../packages/sdk/src/platform/ci-watch/poller.ts';
import type { CiJob, CiWatchSubscription, FixSessionBrief } from '../packages/sdk/src/platform/ci-watch/types.ts';

/** In-memory watch store (the subscriptions seam). */
function memoryStore() {
  let subs: CiWatchSubscription[] = [];
  return {
    load: async () => [...subs],
    save: async (next: CiWatchSubscription[]) => { subs = [...next]; },
    get current() { return subs; },
  };
}

function job(name: string, conclusion: string | null, status = 'completed'): CiJob {
  return { name, status, conclusion, url: `https://ci.example/${name}` };
}

async function settle(): Promise<void> {
  // Let the fire-and-forget mint path settle.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('push detection', () => {
  test('detects git push forms and gh pr create', () => {
    expect(detectCiPushInCommand('git push')).toEqual({ kind: 'push', branch: undefined });
    expect(detectCiPushInCommand('git push origin feature-x')).toEqual({ kind: 'push', branch: 'feature-x' });
    expect(detectCiPushInCommand('git push -u origin feature-x')).toEqual({ kind: 'push', branch: 'feature-x' });
    expect(detectCiPushInCommand('git push origin HEAD:release-line')).toEqual({ kind: 'push', branch: 'release-line' });
    expect(detectCiPushInCommand('bun test && git push origin main')).toEqual({ kind: 'push', branch: 'main' });
    expect(detectCiPushInCommand('gh pr create --fill')).toEqual({ kind: 'pr' });
    expect(detectCiPushInCommand('git status')).toBeNull();
    expect(detectCiPushInCommand('echo git push')).toBeNull();
  });

  test('parses GitHub slugs from ssh/https remotes and refuses non-GitHub', () => {
    expect(parseGitHubSlug('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(parseGitHubSlug('https://github.com/owner/repo')).toBe('owner/repo');
    expect(parseGitHubSlug('ssh://git@github.com/owner/repo.git')).toBe('owner/repo');
    expect(parseGitHubSlug('https://gitlab.com/owner/repo.git')).toBeNull();
  });

  test('extracts commands from exec-tool args', () => {
    expect(execCommandsFromArgs({ commands: [{ cmd: 'git push' }, { cmd: 'ls' }] })).toEqual(['git push', 'ls']);
    expect(execCommandsFromArgs({ commands: 'not-an-array' })).toEqual([]);
  });
});

describe('the full self-minting lifecycle', () => {
  test('platform push -> watch exists -> red -> fix-this offer -> verdict delivered -> watch gone', async () => {
    const store = memoryStore();
    // The CI source starts red (the push broke CI).
    let jobs: CiJob[] = [job('build', 'failure'), job('lint', 'success')];
    const notifications: Array<{ channel: string; title: string }> = [];
    const offers: FixSessionBrief[] = [];

    const service = new CiWatchService({
      source: { fetchJobs: async () => jobs },
      store,
      notifier: async (channel, title) => {
        notifications.push({ channel, title });
        return `note-${notifications.length}`;
      },
      fixSessionStarter: async () => ({ sessionId: 'fix-sess-1' }),
      fixSessionOffer: async (brief) => {
        offers.push(brief);
        return { accepted: false, offerCallId: 'offer-1' }; // human declines; machinery proved
      },
    });

    const minter = new CiWatchAutoMinter({
      service,
      workingDirectory: '/work/project',
      resolveRepoSlug: async () => 'owner/repo',
      resolveCurrentBranch: async () => 'main',
    });

    // 1. Work through the platform pushes a branch — the exec observer seam.
    minter.onToolExecuted('exec', { commands: [{ cmd: 'git push -u origin feature-ci' }] }, true);
    await settle();

    // The watch exists with no ceremony, on the pushed branch, delivering to
    // the default operator surface.
    const watches = await service.listWatches();
    expect(watches.length).toBe(1);
    expect(watches[0]!.repo).toBe('owner/repo');
    expect(watches[0]!.ref).toBe('feature-ci');
    expect(watches[0]!.deliveryChannel).toBe(DEFAULT_AUTO_WATCH_CHANNEL);

    // 2. The daemon poller covers the self-minted watch like any other.
    const pollSummary = await runCiWatchPollPass(service);
    expect(pollSummary).toContain('checked 1/1');
    await settle();

    // 3. Red verdict: notified AND the "fix this?" offer arrived.
    expect(notifications.length).toBe(1);
    expect(notifications[0]!.title).toContain('CI failed');
    expect(offers.length).toBe(1);
    expect(offers[0]!.failingJobs).toEqual(['build']);

    // 4. The terminal verdict was delivered — the watch retired itself.
    expect((await service.listWatches()).length).toBe(0);
    expect(pollSummary).toContain('1 retired');
  });

  test('failed pushes and non-exec tools never mint', async () => {
    const store = memoryStore();
    const service = new CiWatchService({ source: { fetchJobs: async () => [] }, store });
    const minter = new CiWatchAutoMinter({
      service,
      workingDirectory: '/work',
      resolveRepoSlug: async () => 'owner/repo',
      resolveCurrentBranch: async () => 'main',
    });

    minter.onToolExecuted('exec', { commands: [{ cmd: 'git push' }] }, false); // failed exec
    minter.onToolExecuted('write', { commands: [{ cmd: 'git push' }] }, true); // wrong tool
    minter.onToolExecuted('exec', { commands: [{ cmd: 'git status' }] }, true); // no push
    await settle();
    expect((await service.listWatches()).length).toBe(0);
  });

  test('non-GitHub remotes are a silent no-op; duplicates are not minted', async () => {
    const store = memoryStore();
    const service = new CiWatchService({ source: { fetchJobs: async () => [] }, store });

    const noRepo = new CiWatchAutoMinter({
      service,
      workingDirectory: '/w',
      resolveRepoSlug: async () => null,
      resolveCurrentBranch: async () => 'main',
    });
    noRepo.onToolExecuted('exec', { commands: [{ cmd: 'git push' }] }, true);
    await settle();
    expect((await service.listWatches()).length).toBe(0);

    const minter = new CiWatchAutoMinter({
      service,
      workingDirectory: '/w',
      resolveRepoSlug: async () => 'owner/repo',
      resolveCurrentBranch: async () => 'main',
    });
    minter.onToolExecuted('exec', { commands: [{ cmd: 'git push origin main' }] }, true);
    await settle();
    minter.onToolExecuted('exec', { commands: [{ cmd: 'git push origin main' }] }, true);
    await settle();
    expect((await service.listWatches()).length).toBe(1);
  });

  test('the GitService-path tap mints the same way', async () => {
    const store = memoryStore();
    const service = new CiWatchService({ source: { fetchJobs: async () => [] }, store });
    const minter = new CiWatchAutoMinter({
      service,
      workingDirectory: '/w',
      resolveRepoSlug: async () => 'owner/repo',
      resolveCurrentBranch: async () => 'main',
    });
    minter.onGitPushed({ cwd: '/w', branch: 'hotfix' });
    await settle();
    const watches = await service.listWatches();
    expect(watches.length).toBe(1);
    expect(watches[0]!.ref).toBe('hotfix');
  });

  test('the scripted path survives: an explicit createWatch coexists with auto-minted ones', async () => {
    const store = memoryStore();
    const service = new CiWatchService({ source: { fetchJobs: async () => [] }, store });
    const scripted = await service.createWatch({ repo: 'owner/repo', ref: 'main', deliveryChannel: 'ntfy' });
    expect(scripted.deliveryChannel).toBe('ntfy');
    const minter = new CiWatchAutoMinter({
      service,
      workingDirectory: '/w',
      resolveRepoSlug: async () => 'owner/repo',
      resolveCurrentBranch: async () => 'other-branch',
    });
    minter.onToolExecuted('exec', { commands: [{ cmd: 'git push' }] }, true);
    await settle();
    expect((await service.listWatches()).length).toBe(2);
  });
});
