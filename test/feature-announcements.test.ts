/**
 * feature-announcements.test.ts
 *
 * Announce-once receipts for default-on features: the web surface announces
 * its URL exactly once per install at daemon start, automation exposes a
 * how-to-create-your-first-routine empty state while it has no routines, and
 * the exec sandbox's first contained run yields the one-time "commands now
 * run contained; escalations will ask" line. Once-semantics persist across
 * process restarts via the on-disk store.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DaemonLifecycleRuntime } from '../packages/sdk/src/platform/daemon/facade-lifecycle.js';
import { createDaemonRuntimeAutomationRouteHandlers } from '../packages/daemon-sdk/dist/index.js';
import {
  FeatureAnnouncementStore,
  featureAnnouncementsPath,
  SANDBOX_CONTAINED_ANNOUNCEMENT_ID,
  SANDBOX_CONTAINED_ANNOUNCEMENT_TEXT,
  WEB_SURFACE_ANNOUNCEMENT_ID,
  buildAutomationEmptyState,
  collectStartupAnnouncements,
  createSandboxContainmentAnnouncer,
  resolveWebSurfaceUrl,
} from '../packages/sdk/src/platform/runtime/feature-announcements.js';
import { DEFAULT_CONFIG } from '../packages/sdk/src/platform/config/schema.js';

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-announce-'));
  tmpRoots.push(root);
  return join(root, 'control-plane', 'feature-announcements.json');
}

function fakeConfig(overrides: Record<string, unknown> = {}) {
  return {
    get: (key: string) => {
      if (key in overrides) return overrides[key] as never;
      return key.split('.').reduce<unknown>(
        (cursor, segment) => (cursor as Record<string, unknown>)?.[segment],
        DEFAULT_CONFIG as unknown,
      ) as never;
    },
  };
}

describe('FeatureAnnouncementStore', () => {
  test('record is true exactly once per id, persisted across store instances', () => {
    const path = storePath();
    const store = new FeatureAnnouncementStore(path);
    expect(store.record('some-feature')).toBe(true);
    expect(store.record('some-feature')).toBe(false);
    // A fresh instance over the same file ("restart") stays silent.
    const restarted = new FeatureAnnouncementStore(path);
    expect(restarted.has('some-feature')).toBe(true);
    expect(restarted.record('some-feature')).toBe(false);
    expect(restarted.record('another-feature')).toBe(true);
  });

  test('recording with text queues the line for surface delivery; drainPending delivers exactly once', () => {
    const path = storePath();
    const store = new FeatureAnnouncementStore(path);
    expect(store.record('with-text', 'a line surfaces render')).toBe(true);
    // A re-record neither re-announces nor re-queues.
    expect(store.record('with-text', 'a line surfaces render')).toBe(false);
    // A fresh instance over the same file ("restart") still holds the queue.
    const drained = new FeatureAnnouncementStore(path).drainPending();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.id).toBe('with-text');
    expect(drained[0]!.text).toBe('a line surfaces render');
    expect(typeof drained[0]!.at).toBe('number');
    // Exactly once: the queue is empty for every later reader.
    expect(new FeatureAnnouncementStore(path).drainPending()).toEqual([]);
    // The once-gate survives the drain.
    expect(new FeatureAnnouncementStore(path).record('with-text', 'again')).toBe(false);
  });

  test('a legacy plain-map file reads as announced with nothing pending — old installs never re-announce', () => {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ 'old-feature': 1700000000000 }, null, 2));
    const store = new FeatureAnnouncementStore(path);
    expect(store.has('old-feature')).toBe(true);
    expect(store.record('old-feature', 'text')).toBe(false);
    expect(store.drainPending()).toEqual([]);
  });
});

describe('automation empty state reaches the jobs-list wire response', () => {
  function jobsHandlers(jobs: unknown[], emptyState: (() => { title: string; body: string } | null) | undefined) {
    return createDaemonRuntimeAutomationRouteHandlers({
      automationManager: { listJobs: () => jobs },
      ...(emptyState ? { automationEmptyState: emptyState } : {}),
    } as unknown as Parameters<typeof createDaemonRuntimeAutomationRouteHandlers>[0]);
  }

  test('zero routines with automation enabled serves the how-to empty state on the wire', async () => {
    const handlers = jobsHandlers([], () => buildAutomationEmptyState({ enabled: true, routineCount: 0 }));
    const res = await handlers.getAutomationJobs();
    const body = await (res as Response).json() as { jobs: unknown[]; emptyState?: { title: string; body: string } };
    expect(body.jobs).toEqual([]);
    expect(body.emptyState?.title).toBe('No routines yet');
    expect(body.emptyState?.body).toContain('first routine');
  });

  test('the empty state disappears once a routine exists, and is absent without the seam', async () => {
    const withJob = await (await jobsHandlers([{ id: 'job-1' }], () => buildAutomationEmptyState({ enabled: true, routineCount: 1 })).getAutomationJobs() as Response).json() as { emptyState?: unknown };
    expect(withJob.emptyState).toBeUndefined();
    const withoutSeam = await (await jobsHandlers([], undefined).getAutomationJobs() as Response).json() as { emptyState?: unknown };
    expect(withoutSeam.emptyState).toBeUndefined();
  });
});

describe('announcements reach the consuming receipts read (surface delivery)', () => {
  test('a fired announcement arrives via collectReceipts exactly once, alongside daemon receipts', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'gv-announce-lifecycle-'));
    tmpRoots.push(scratch);
    const configManager = {
      get: (key: string) => (key === 'update.auto' ? false : fakeConfig().get(key)),
      getControlPlaneConfigDir: () => scratch,
    } as unknown as ConstructorParameters<typeof DaemonLifecycleRuntime>[0]['configManager'];
    const runtime = new DaemonLifecycleRuntime({
      configManager,
      platformServiceManager: { status: () => ({ installed: false, running: false }) } as never,
      isIdle: () => true,
    });

    // A runtime-side announcer (same install, same file) fires a line.
    const store = new FeatureAnnouncementStore(featureAnnouncementsPath({ getControlPlaneConfigDir: () => scratch }));
    expect(store.record('web-thing', 'Web surface ready: http://127.0.0.1:9')).toBe(true);

    const first = runtime.collectReceipts();
    const announcement = first.find((entry) => entry.id === 'announcement-web-thing');
    expect(announcement).toBeDefined();
    expect(announcement!.text).toBe('Web surface ready: http://127.0.0.1:9');
    // Exactly once: a second consuming read gets nothing.
    expect(runtime.collectReceipts().find((entry) => entry.id === 'announcement-web-thing')).toBeUndefined();
  });
});

describe('web surface URL announcement', () => {
  test('a stock config announces the loopback URL once at daemon start', () => {
    const store = new FeatureAnnouncementStore(storePath());
    const first = collectStartupAnnouncements({ configManager: fakeConfig(), store });
    expect(first.length).toBe(1);
    expect(first[0]?.id).toBe(WEB_SURFACE_ANNOUNCEMENT_ID);
    expect(first[0]?.text).toContain('http://127.0.0.1:3423');
    expect(first[0]?.text).toContain('this machine only');

    // The next start announces nothing — once means once.
    const second = collectStartupAnnouncements({ configManager: fakeConfig(), store });
    expect(second).toEqual([]);
  });

  test('a disabled web surface announces nothing', () => {
    const store = new FeatureAnnouncementStore(storePath());
    const lines = collectStartupAnnouncements({
      configManager: fakeConfig({ 'web.enabled': false }),
      store,
    });
    expect(lines).toEqual([]);
  });

  test('resolveWebSurfaceUrl prefers the public base URL and falls back to host:port', () => {
    expect(resolveWebSurfaceUrl(fakeConfig())).toBe('http://127.0.0.1:3423');
    expect(resolveWebSurfaceUrl(fakeConfig({ 'web.publicBaseUrl': '' }))).toBe('http://127.0.0.1:3423');
    expect(resolveWebSurfaceUrl(fakeConfig({ 'web.publicBaseUrl': 'https://ops.example' }))).toBe('https://ops.example');
  });
});

describe('automation empty state', () => {
  test('enabled with zero routines exposes the how-to state', () => {
    const state = buildAutomationEmptyState({ enabled: true, routineCount: 0 });
    expect(state?.title).toBe('No routines yet');
    expect(state?.body).toContain('first routine');
  });

  test('it disappears once a routine exists, and is absent when automation is off', () => {
    expect(buildAutomationEmptyState({ enabled: true, routineCount: 1 })).toBeNull();
    expect(buildAutomationEmptyState({ enabled: false, routineCount: 0 })).toBeNull();
  });
});

describe('sandbox containment announcement', () => {
  test('the first contained run announces once with the exact line; later runs are silent', () => {
    const path = storePath();
    const announced: string[] = [];
    const report = createSandboxContainmentAnnouncer(
      new FeatureAnnouncementStore(path),
      (announcement) => announced.push(announcement.text),
    );
    report();
    report();
    report();
    expect(announced).toEqual([SANDBOX_CONTAINED_ANNOUNCEMENT_TEXT]);
    expect(SANDBOX_CONTAINED_ANNOUNCEMENT_TEXT).toBe('commands now run contained; escalations will ask');

    // A restarted process (fresh store over the same file) stays silent too.
    const afterRestart: string[] = [];
    const reportAfterRestart = createSandboxContainmentAnnouncer(
      new FeatureAnnouncementStore(path),
      (announcement) => afterRestart.push(announcement.text),
    );
    reportAfterRestart();
    expect(afterRestart).toEqual([]);
    expect(new FeatureAnnouncementStore(path).has(SANDBOX_CONTAINED_ANNOUNCEMENT_ID)).toBe(true);
  });
});
