/**
 * store-write-ordering-registries.test.ts
 *
 * The same defect as `store-write-ordering.test.ts`, in the stores behind the
 * automation scheduler, the workspace registry, the cron scheduler, CI watches,
 * the principal registry and the channel-profile registry. Same harness, same
 * rule for the assertion: the REAL consequence, read back off the file, not a
 * statement about ordering.
 *
 * `WorkspaceRegistrationStore` is the exception in kind rather than degree. Its
 * mutations are read-modify-writes with no in-memory state behind them, and it
 * is the one store a second PROCESS writes, so ordering the write alone would
 * not close it. Both halves of its remedy, the in-process chain and the
 * advisory lock, get their own test.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from './_helpers/test-timeout.js';
import { makeControllableStore, readOnDisk, replaceInternalStore } from './_helpers/controllable-store.js';

import { AutomationJobStore } from '../packages/sdk/src/platform/automation/store/jobs.js';
import { AutomationRunStore } from '../packages/sdk/src/platform/automation/store/runs.js';
import { AutomationRouteStore } from '../packages/sdk/src/platform/automation/store/routes.js';
import { AutomationSourceStore } from '../packages/sdk/src/platform/automation/store/sources.js';
import type { AutomationSourceRecord } from '../packages/sdk/src/platform/automation/sources.js';
import type { AutomationJob } from '../packages/sdk/src/platform/automation/jobs.js';
import type { AutomationRun } from '../packages/sdk/src/platform/automation/runs.js';
import type { AutomationRouteBinding } from '../packages/sdk/src/platform/automation/routes.js';
import { WorkspaceRegistrationStore } from '../packages/sdk/src/platform/workspace/registration/index.js';
import { TaskScheduler } from '../packages/sdk/src/platform/scheduler/scheduler.js';
import { CiWatchService, CiWatchStore } from '../packages/sdk/src/platform/ci-watch/index.js';
import type { CiJob, CiStatusSource } from '../packages/sdk/src/platform/ci-watch/index.js';
import { PrincipalRegistry } from '../packages/sdk/src/platform/principals/registry.js';
import { PrincipalStore } from '../packages/sdk/src/platform/principals/store.js';
import { ChannelProfileRegistry } from '../packages/sdk/src/platform/channel-profiles/registry.js';
import { ChannelProfileStore } from '../packages/sdk/src/platform/channel-profiles/store.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `gv-${prefix}-`));
}

// ---------------------------------------------------------------------------
// The automation stores. AutomationManager and AutomationService both write
// every one of their files through these classes, so the ordering property the
// two of them depend on is proved where it actually lives.
// ---------------------------------------------------------------------------

function makeAutomationJob(overrides: Partial<AutomationJob> = {}): AutomationJob {
  const now = Date.now();
  return {
    id: 'job-nightly',
    labels: [],
    createdAt: now,
    updatedAt: now,
    name: 'Nightly report',
    status: 'enabled',
    enabled: true,
    schedule: { kind: 'every', intervalMs: 3_600_000 },
    execution: { prompt: 'do it', target: { kind: 'isolated' } },
    delivery: { mode: 'surface', targets: [], fallbackTargets: [], includeSummary: false, includeTranscript: false, includeLinks: false },
    failure: { action: 'retry', maxConsecutiveFailures: 3, cooldownMs: 1_000, retryPolicy: { maxAttempts: 1, delayMs: 1_000, strategy: 'fixed' } },
    source: { id: 'src-1', kind: 'schedule', label: 'schedule', enabled: true, createdAt: now, updatedAt: now, metadata: {} },
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    deleteAfterRun: false,
    ...overrides,
  } as AutomationJob;
}

function makeAutomationRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  const now = Date.now();
  return {
    id: 'run-1',
    labels: [],
    createdAt: now,
    updatedAt: now,
    jobId: 'job-nightly',
    status: 'running',
    triggeredBy: { id: 'src-1', kind: 'schedule', label: 'schedule', enabled: true, createdAt: now, updatedAt: now, metadata: {} },
    target: { kind: 'isolated' },
    execution: { prompt: 'do it', target: { kind: 'isolated' } },
    queuedAt: now,
    forceRun: false,
    dueRun: true,
    attempt: 1,
    deliveryIds: [],
    ...overrides,
  } as AutomationRun;
}

interface RunsFileShape extends Record<string, unknown> {
  readonly runs: readonly { readonly id: string; readonly status: string }[];
}
interface JobsFileShape extends Record<string, unknown> {
  readonly jobs: readonly { readonly id: string; readonly enabled: boolean }[];
}
interface RoutesFileShape extends Record<string, unknown> {
  readonly routes: readonly { readonly id: string }[];
}
interface SourcesFileShape extends Record<string, unknown> {
  readonly sources: readonly { readonly id: string }[];
}

describe('AutomationRunStore — a completed run does not read back as running', () => {
  test("a concurrent run's slower write cannot restore the earlier status", async () => {
    const { store, path, cleanup } = makeControllableStore<RunsFileShape>('automation-runs-order', 'automation-runs.json');
    try {
      const runs = new AutomationRunStore(path);
      replaceInternalStore(runs, 'store', store);

      const running = makeAutomationRun({ status: 'running' });
      await runs.save([running]);

      // The daemon runs up to `automation.maxConcurrentRuns` (4) at once and
      // every one of them saves the WHOLE run map. This is a second run's save,
      // carrying the view in which the first run is still going.
      store.delayNextMs = 250;
      const neighbour = runs.save([running]);
      await waitFor(() => store.started >= 2);

      await runs.save([makeAutomationRun({ status: 'completed', endedAt: Date.now() })]);
      await neighbour;
      await waitFor(() => store.finished >= 3);

      // What the reconciler reads after a restart. A 'running' run whose agent
      // is gone is treated as work that never finished, so the job executes
      // again, a completed automation run repeated.
      expect(readOnDisk<RunsFileShape>(path)?.runs[0]?.status).toBe('completed');
    } finally {
      cleanup();
    }
  });
});

describe('AutomationJobStore — a disabled job does not come back enabled', () => {
  test("a neighbouring run's slower write cannot re-enable the job", async () => {
    const { store, path, cleanup } = makeControllableStore<JobsFileShape>('automation-jobs-order', 'automation-jobs.json');
    try {
      const jobs = new AutomationJobStore(path);
      replaceInternalStore(jobs, 'store', store);

      const enabled = makeAutomationJob({ enabled: true });
      await jobs.save([enabled]);

      store.delayNextMs = 250;
      const neighbour = jobs.save([enabled]);
      await waitFor(() => store.started >= 2);

      await jobs.save([makeAutomationJob({ enabled: false, status: 'paused' })]);
      await neighbour;
      await waitFor(() => store.finished >= 3);

      // An enabled job on disk is one the scheduler arms a timer for at boot,
      // so this is an automation running on a schedule its owner switched off.
      expect(readOnDisk<JobsFileShape>(path)?.jobs[0]?.enabled).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe('AutomationRouteStore — a removed route binding does not come back', () => {
  test('a slower upsert cannot restore a binding removed after it', async () => {
    const { store, path, cleanup } = makeControllableStore<RoutesFileShape>('automation-routes-order', 'automation-routes.json');
    try {
      const routes = new AutomationRouteStore(path);
      replaceInternalStore(routes, 'store', store);

      const now = Date.now();
      const binding = {
        id: 'route-1', kind: 'session', surfaceKind: 'telegram', surfaceId: 'tg-1',
        externalId: 'chat-9', jobId: 'job-nightly', lastSeenAt: now, createdAt: now,
        updatedAt: now, metadata: {},
      } as unknown as AutomationRouteBinding;
      await routes.save([binding]);

      // AutomationService.upsertRun rewrites this whole file on every run, and
      // removeJob rewrites it to drop the deleted job's bindings. They overlap.
      store.delayNextMs = 250;
      const upserting = routes.save([binding]);
      await waitFor(() => store.started >= 2);

      await routes.save([]);
      await upserting;
      await waitFor(() => store.finished >= 3);

      // A binding for a deleted job is a route that still delivers a deleted
      // automation's output into somebody's chat.
      expect(readOnDisk<RoutesFileShape>(path)?.routes ?? []).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe('AutomationSourceStore — a removed source does not come back', () => {
  test('a slower upsert cannot restore a source removed after it', async () => {
    const { store, path, cleanup } = makeControllableStore<SourcesFileShape>('automation-sources-order', 'automation-sources.json');
    try {
      const sources = new AutomationSourceStore(path);
      replaceInternalStore(sources, 'store', store);

      const now = Date.now();
      const source = {
        id: 'src-webhook', kind: 'webhook', label: 'deploy hook', enabled: true,
        createdAt: now, updatedAt: now, metadata: {},
      } as unknown as AutomationSourceRecord;
      await sources.save([source]);

      // AutomationService writes this file from upsertJob AND upsertRun, both
      // of which fire it inside a Promise.all alongside other stores.
      store.delayNextMs = 250;
      const upserting = sources.save([source]);
      await waitFor(() => store.started >= 2);

      await sources.save([]);
      await upserting;
      await waitFor(() => store.finished >= 3);

      // A source is what a run's provenance points at, so one that comes back
      // after removal is a trigger the operator deleted still naming itself as
      // the reason work ran.
      expect(readOnDisk<SourcesFileShape>(path)?.sources ?? []).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// WorkspaceRegistrationStore, read-modify-write, and cross-process.
// ---------------------------------------------------------------------------

describe('WorkspaceRegistrationStore — no registration is lost', () => {
  test('two registrations at once both survive (the in-process chain)', async () => {
    const dir = tempDir('workspace-order');
    try {
      const store = new WorkspaceRegistrationStore({
        path: join(dir, 'workspaces.json'),
        homeDir: '/home/dev',
        daemonStateDir: '/home/dev/.goodvibes',
        probe: () => ({}),
      });

      // Both read the empty registry before either writes. Unless the whole
      // read-modify-write is serialised, the second write replaces the first and
      // one project is registered nowhere, no coverage, and nothing says so.
      await Promise.all([store.add('/home/dev/proj-a'), store.add('/home/dev/proj-b')]);

      const snapshot = await store.snapshot();
      expect(snapshot.workspaces.map((w) => w.root).sort()).toEqual(['/home/dev/proj-a', '/home/dev/proj-b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('two registrations at once both survive with no file to lock (the chain alone)', async () => {
    // `:memory:` is the store's declared injectable-I/O seam, and it has no
    // lock file to contend on, the in-process chain is the whole of the
    // serialisation there, which is why it is not redundant with the lock.
    const store = new WorkspaceRegistrationStore({
      path: ':memory:',
      homeDir: '/home/dev',
      daemonStateDir: '/home/dev/.goodvibes',
      probe: () => ({}),
    });
    await Promise.all([store.add('/home/dev/mem-a'), store.add('/home/dev/mem-b')]);
    const snapshot = await store.snapshot();
    expect(snapshot.workspaces.map((w) => w.root).sort()).toEqual(['/home/dev/mem-a', '/home/dev/mem-b']);
  });

  test('two INSTANCES on the same file both survive (the advisory lock)', async () => {
    const dir = tempDir('workspace-xproc');
    const path = join(dir, 'workspaces.json');
    const make = (): WorkspaceRegistrationStore => new WorkspaceRegistrationStore({
      path, homeDir: '/home/dev', daemonStateDir: '/home/dev/.goodvibes', probe: () => ({}),
    });
    try {
      // Separate instances have separate in-process chains, which is the
      // `goodvibes register` CLI writing the same user-scoped file the running
      // daemon writes. Only the lock file orders these two.
      const cli = make();
      const daemon = make();
      await Promise.all([cli.add('/home/dev/proj-cli'), daemon.add('/home/dev/proj-daemon')]);

      const snapshot = await make().snapshot();
      expect(snapshot.workspaces.map((w) => w.root).sort()).toEqual(['/home/dev/proj-cli', '/home/dev/proj-daemon']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// TaskScheduler, a removed task does not come back and fire again.
// ---------------------------------------------------------------------------

interface SchedulerFileShape extends Record<string, unknown> {
  readonly tasks: readonly { readonly id: string }[];
}

describe('TaskScheduler — a removed task does not come back', () => {
  test('an earlier unawaited save cannot restore a task deleted after it', async () => {
    const { store, path, cleanup } = makeControllableStore<SchedulerFileShape>('scheduler-order', 'scheduler.json');
    try {
      const scheduler = new TaskScheduler({ storePath: path });
      replaceInternalStore(scheduler, 'store', store);

      const task = scheduler.add({ name: 'nightly', cron: '0 3 * * *', prompt: 'run the report', enabled: true });
      await waitFor(() => store.finished >= 1);

      // None of add/remove/setEnabled waits for its own write, so two of them
      // are trivially in flight at once.
      store.delayNextMs = 250;
      scheduler.setEnabled(task.id, true);
      await waitFor(() => store.started >= 2);

      expect(scheduler.remove(task.id)).toBe(true);
      await waitFor(() => store.finished >= 3);

      // A task on disk is a cron the next daemon start arms a timer for, so
      // this is a scheduled agent spawning on a schedule nobody wants.
      expect(readOnDisk<SchedulerFileShape>(path)?.tasks ?? []).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// CiWatchService, a deleted watch does not come back and notify again.
// ---------------------------------------------------------------------------

interface CiWatchFileShape extends Record<string, unknown> {
  readonly subscriptions: readonly { readonly id: string }[];
}

describe('CiWatchService — a deleted watch does not come back', () => {
  test('a poll already in flight cannot restore the watch deleted while it ran', async () => {
    const { store, path, cleanup } = makeControllableStore<CiWatchFileShape>('ci-watch-order', 'ci-watches.json');
    try {
      const jobs: CiJob[] = [{ name: 'build', status: 'in_progress', conclusion: null }];
      const source: CiStatusSource = { fetchJobs: async () => jobs };
      const watchStore = new CiWatchStore(path);
      replaceInternalStore(watchStore, 'store', store);
      const service = new CiWatchService({ source, store: watchStore });

      const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'tui' });

      // checkWatch polls the forge and only writes when that returns, so its
      // write is requested long before it lands.
      store.delayNextMs = 250;
      const checking = service.checkWatch(watch.id);
      await waitFor(() => store.started >= 2);

      expect(await service.deleteWatch(watch.id)).toBe(true);
      await checking;
      await waitFor(() => store.finished >= 3);

      // A watch on disk is one the poller keeps checking and notifying about,
      // after the operator was told it was gone.
      expect(readOnDisk<CiWatchFileShape>(path)?.subscriptions ?? []).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// PrincipalRegistry, a deleted principal stops resolving.
// ---------------------------------------------------------------------------

describe('PrincipalRegistry — a deleted principal does not come back', () => {
  test('a slower create cannot restore a principal deleted after it', async () => {
    const { store, path, cleanup } = makeControllableStore<Record<string, unknown>>('principals-order', 'principals.json');
    try {
      const principalStore = new PrincipalStore(path);
      replaceInternalStore(principalStore, 'store', store);
      const registry = new PrincipalRegistry(principalStore);

      const person = await registry.create({
        name: 'Contractor',
        kind: 'user',
        identities: [{ channel: 'telegram', value: '4242' }],
      });

      store.delayNextMs = 250;
      const creating = registry.create({ name: 'Bot', kind: 'bot' });
      await waitFor(() => store.started >= 2);

      expect(await registry.delete(person.id)).toBe(true);
      await creating;
      await waitFor(() => store.finished >= 3);

      // What the next daemon start resolves. The registry is what channel
      // intake maps a sender identity through, so a deleted principal on disk
      // means messages are still attributed to somebody who was unmapped.
      const fresh = new PrincipalRegistry(new PrincipalStore(path));
      const resolution = await fresh.resolveByIdentity({ channel: 'telegram', value: '4242' });
      expect(resolution.known).toBe(false);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// ChannelProfileRegistry, a deleted binding stops resolving.
// ---------------------------------------------------------------------------

describe('ChannelProfileRegistry — a deleted binding does not come back', () => {
  test('a slower set cannot restore a binding deleted after it', async () => {
    const { store, path, cleanup } = makeControllableStore<Record<string, unknown>>('channel-profiles-order', 'channel-profiles.json');
    try {
      const profileStore = new ChannelProfileStore(path);
      replaceInternalStore(profileStore, 'store', store);
      const registry = new ChannelProfileRegistry(profileStore);

      await registry.set({ surfaceKind: 'telegram', channelId: 'chat-9', model: 'expensive-model' });

      store.delayNextMs = 250;
      const setting = registry.set({ surfaceKind: 'slack', model: 'other-model' });
      await waitFor(() => store.started >= 2);

      expect(await registry.delete('telegram', 'chat-9')).toBe(true);
      await setting;
      await waitFor(() => store.finished >= 3);

      // The binding decides the model and permission mode a channel-originated
      // session runs under, so one that comes back is a channel still running
      // under defaults its owner unbound.
      const fresh = new ChannelProfileRegistry(new ChannelProfileStore(path));
      expect(await fresh.resolve('telegram', 'chat-9')).toBeNull();
    } finally {
      cleanup();
    }
  });
});
