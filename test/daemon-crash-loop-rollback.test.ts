/**
 * Crash-loop auto-rollback: a verified update that turns out to be a bad build
 * must not leave the daemon restarting into the same failure forever.
 *
 * Covered here:
 *   - the failed-start counter itself (bounded, content-validated, and reset
 *     by a fully-started boot or an orderly stop);
 *   - the trigger: three consecutive rapid boots that never reached a
 *     fully-started daemon;
 *   - the receipt, and the handover onto the restored binary;
 *   - the two honest refusals, nothing to restore, and never twice in a row.
 *
 * Filesystem, clock, and process exit are all injected; no real binary is
 * swapped and no real time passes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CRASH_LOOP_WINDOW_MS,
  MAX_TRACKED_FAILED_STARTS,
  readLifecycleMarker,
  recordDaemonAutoRollback,
  recordDaemonCleanShutdown,
  recordDaemonStart,
  recordDaemonStartAttempt,
  type LifecycleMarkerIo,
} from '../packages/sdk/src/platform/daemon/lifecycle-marker.ts';
import {
  CRASH_LOOP_FAILED_START_THRESHOLD,
  crashLoopRollbackReceipt,
  decideCrashLoopRollback,
} from '../packages/sdk/src/platform/daemon/boot-rollback.ts';
import { DaemonLifecycleRuntime, type DaemonLifecycleRuntimeOptions } from '../packages/sdk/src/platform/daemon/facade-lifecycle.ts';
import { PREVIOUS_FILE_SUFFIX, type UpdateFileIo } from '../packages/sdk/src/platform/runtime/self-update.ts';

const MARKER = '/state/daemon-lifecycle.json';
const EXEC_PATH = '/opt/gv/goodvibes-daemon';
const PREVIOUS_PATH = `${EXEC_PATH}${PREVIOUS_FILE_SUFFIX}`;

const scratchDirs: string[] = [];
afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

function memoryMarkerIo(): { io: LifecycleMarkerIo; files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    io: {
      read: (path) => files.get(path) ?? null,
      write: (path, contents) => void files.set(path, contents),
    },
  };
}

function memoryUpdateIo(initial: Record<string, string>): { io: UpdateFileIo; files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    io: {
      writeFile: (path, data) => void files.set(path, data.toString('utf-8')),
      rename: (from, to) => {
        const data = files.get(from);
        if (data === undefined) throw new Error(`rename source missing: ${from}`);
        files.delete(from);
        files.set(to, data);
      },
      chmod: () => {},
      exists: (path) => files.has(path),
      mkdir: () => {},
    },
  };
}

describe('failed-start counter (lifecycle marker)', () => {
  test('counts consecutive boots that never reached a fully-started daemon', () => {
    const { io } = memoryMarkerIo();
    let clock = 1_000_000;
    const now = (): number => clock;
    // Each boot records its attempt and is told how many attempts before it failed.
    expect(recordDaemonStartAttempt(MARKER, { io, now }).failedStarts).toBe(0);
    clock += 5_000;
    expect(recordDaemonStartAttempt(MARKER, { io, now }).failedStarts).toBe(1);
    clock += 5_000;
    expect(recordDaemonStartAttempt(MARKER, { io, now }).failedStarts).toBe(2);
    clock += 5_000;
    expect(recordDaemonStartAttempt(MARKER, { io, now }).failedStarts).toBe(3);
  });

  test('a fully-started boot resets the streak, so the next failure starts from zero', () => {
    const { io } = memoryMarkerIo();
    let clock = 1_000_000;
    const now = (): number => clock;
    recordDaemonStartAttempt(MARKER, { io, now });
    clock += 1_000;
    recordDaemonStartAttempt(MARKER, { io, now });
    clock += 1_000;
    // This boot made it all the way up.
    recordDaemonStart(MARKER, { io, now, pid: 4242 });
    clock += 1_000;
    expect(recordDaemonStartAttempt(MARKER, { io, now }).failedStarts).toBe(0);
  });

  test('an orderly stop resets the streak too', () => {
    const { io } = memoryMarkerIo();
    let clock = 1_000_000;
    const now = (): number => clock;
    recordDaemonStartAttempt(MARKER, { io, now });
    recordDaemonStartAttempt(MARKER, { io, now });
    recordDaemonCleanShutdown(MARKER, { io, now });
    clock += 1_000;
    expect(recordDaemonStartAttempt(MARKER, { io, now }).failedStarts).toBe(0);
  });

  test('a start attempt leaves the previous run\'s crash state readable at fully-started', () => {
    const { io } = memoryMarkerIo();
    const now = (): number => 1_000_000;
    recordDaemonStart(MARKER, { io, now, pid: 1 }); // a daemon comes up...
    // ...and dies without an orderly stop; the next boot records its attempt.
    const attempt = recordDaemonStartAttempt(MARKER, { io, now });
    expect(attempt.crashed).toBe(true);
    // The attempt write must not erase the crash signal the started hook reads.
    expect(recordDaemonStart(MARKER, { io, now, pid: 2 }).crashed).toBe(true);
  });

  test('boots spread wider than the crash-loop window are not a crash loop', () => {
    const { io } = memoryMarkerIo();
    let clock = 1_000_000;
    const now = (): number => clock;
    recordDaemonStartAttempt(MARKER, { io, now });
    clock += DEFAULT_CRASH_LOOP_WINDOW_MS + 1;
    expect(recordDaemonStartAttempt(MARKER, { io, now }).failedStarts).toBe(0);
  });

  test('marker state is validated by content and bounded', () => {
    const { io, files } = memoryMarkerIo();
    const now = (): number => 1_000_000;

    files.set(MARKER, 'not json at all {{{');
    expect(recordDaemonStartAttempt(MARKER, { io, now }).failedStarts).toBe(0);

    files.set(MARKER, JSON.stringify({ state: 'weird', at: 5, failedStarts: 99 }));
    const foreign = recordDaemonStartAttempt(MARKER, { io, now });
    expect(foreign.failedStarts).toBe(0);
    expect(foreign.crashed).toBe(false);

    files.set(MARKER, JSON.stringify({ state: 'running', at: 1, failedStarts: 1e9, streakStartedAt: 999_999, autoRollbackAt: 'yesterday' }));
    const bounded = recordDaemonStartAttempt(MARKER, { io, now });
    expect(bounded.failedStarts).toBe(MAX_TRACKED_FAILED_STARTS);
    // A non-numeric rollback stamp is dropped, never read as "already rolled back".
    expect(bounded.autoRollbackAt).toBeUndefined();
    expect(JSON.parse(files.get(MARKER)!).failedStarts).toBe(MAX_TRACKED_FAILED_STARTS);
  });

  test('an auto-rollback stamp survives later boots until a fully-started one clears it', () => {
    const { io } = memoryMarkerIo();
    let clock = 1_000_000;
    const now = (): number => clock;
    recordDaemonAutoRollback(MARKER, { io, now });
    clock += 1_000;
    expect(recordDaemonStartAttempt(MARKER, { io, now }).autoRollbackAt).toBe(1_000_000);
    clock += 1_000;
    recordDaemonStart(MARKER, { io, now, pid: 7 });
    clock += 1_000;
    expect(recordDaemonStartAttempt(MARKER, { io, now }).autoRollbackAt).toBeUndefined();
  });
});

describe('crash-loop decision', () => {
  test('rolls back only once the threshold of failed starts is reached', () => {
    expect(decideCrashLoopRollback({ failedStarts: 2, autoRollbackAt: undefined })).toEqual({ rollback: false, reason: 'healthy' });
    expect(decideCrashLoopRollback({ failedStarts: CRASH_LOOP_FAILED_START_THRESHOLD, autoRollbackAt: undefined }))
      .toEqual({ rollback: true, failedStarts: 3 });
  });

  test('never twice in a row: a rollback already fired and no healthy boot has re-armed it', () => {
    expect(decideCrashLoopRollback({ failedStarts: 5, autoRollbackAt: 1_000 }))
      .toEqual({ rollback: false, reason: 'already-rolled-back' });
  });

  test('the receipt names the failure count and what came back', () => {
    const text = crashLoopRollbackReceipt({
      failedStarts: 3,
      restored: [{ label: 'daemon binary' }],
      at: new Date(2026, 6, 12, 14, 30).getTime(),
    });
    expect(text).toStartWith('rolled back to the previously installed version at 14:30');
    expect(text).toContain('failed to start 3 times in a row');
    expect(text).toContain('daemon binary');
  });
});

interface RollbackHarness {
  readonly runtime: DaemonLifecycleRuntime;
  readonly files: Map<string, string>;
  readonly exits: number[];
  readonly stops: number[];
  readonly stderr: string[];
  /** Lines put in front of the owner over a working channel. */
  readonly alerts: string[];
  /** The lifecycle marker as persisted, so the rejection record is readable in a test. */
  readonly marker: () => ReturnType<typeof readLifecycleMarker>;
  /** The state directory, so a second harness can model the NEXT process on the same host. */
  readonly scratch: string;
  /** The marker filesystem, shareable with a second harness for the same reason. */
  readonly markerFs: { io: LifecycleMarkerIo; files: Map<string, string> };
  readonly receipts: () => readonly { text: string }[];
}

function rollbackHarness(overrides: {
  readonly artifact?: DaemonLifecycleRuntimeOptions['updateArtifact'];
  readonly installed?: Record<string, string>;
  readonly threshold?: number;
  /** Share one marker filesystem across two harnesses to model two PROCESSES. */
  readonly marker?: { io: LifecycleMarkerIo; files: Map<string, string> };
  /** Share one state directory too, so the second harness reads the first's marker and receipts. */
  readonly controlPlaneDir?: string;
} = {}): RollbackHarness {
  const scratch = overrides.controlPlaneDir ?? mkdtempSync(join(tmpdir(), 'crash-loop-'));
  if (overrides.controlPlaneDir === undefined) scratchDirs.push(scratch);
  const config = new Map<string, unknown>([
    ['update.auto', false], // the loop is not what these tests exercise
    ['service.enabled', false], // boot promotion is a separate path
    ['service.serviceName', 'goodvibes-crash-loop-test'],
    ['update.rollbackAfterFailedStarts', overrides.threshold ?? 3],
  ]);
  const configManager = {
    get: (key: string) => config.get(key),
    getControlPlaneConfigDir: () => scratch,
  } as unknown as DaemonLifecycleRuntimeOptions['configManager'];
  const platformServiceManager = {
    // Unsupervised and un-installable: the handover reduces to the observable exit.
    status: () => ({ installed: false, running: false }),
    install: () => { throw new Error('no service manager in this test'); },
  } as unknown as DaemonLifecycleRuntimeOptions['platformServiceManager'];
  const { io: markerIo, files: markerFiles } = overrides.marker ?? memoryMarkerIo();
  const { io: rollbackIo, files } = memoryUpdateIo(
    overrides.installed ?? { [EXEC_PATH]: 'bad-build', [PREVIOUS_PATH]: 'good-build' },
  );
  const exits: number[] = [];
  const stops: number[] = [];
  const stderr: string[] = [];
  const alerts: string[] = [];
  const runtime = new DaemonLifecycleRuntime({
    stderr: { write: (chunk: string) => void stderr.push(chunk) },
    configManager,
    platformServiceManager,
    isIdle: () => true,
    markerIo,
    rollbackIo,
    now: () => new Date(2026, 6, 12, 14, 30).getTime(),
    exitProcess: (code: number) => { exits.push(code); },
    stopGracefully: () => { stops.push(Date.now()); },
    isCompiledBinary: () => true,
    alertOwner: (text: string) => void alerts.push(text),
    ...(overrides.artifact !== undefined ? { updateArtifact: overrides.artifact } : {}),
  });
  return {
    runtime,
    files,
    exits,
    stops,
    stderr,
    alerts,
    scratch,
    markerFs: { io: markerIo, files: markerFiles },
    // The runtime owns its marker path; the memory filesystem only ever holds
    // that one file, so reading "the marker" needs no path duplication here.
    marker: () => {
      const path = [...markerFiles.keys()][0];
      return path === undefined ? null : readLifecycleMarker(path, markerIo);
    },
    receipts: () => runtime.receiptStore().list(),
  };
}

const ARTIFACT = { version: '2.0.0', execPath: EXEC_PATH };

describe('crash-loop rollback at boot', () => {
  test('three failed starts restore the kept previous binary, record a receipt, and hand over', async () => {
    const h = rollbackHarness({ artifact: ARTIFACT });
    // Boots 1-3 record a start attempt and never reach a fully-started daemon.
    expect(h.runtime.onStarting()).toBe(false);
    expect(h.runtime.onStarting()).toBe(false);
    expect(h.runtime.onStarting()).toBe(false);
    expect(h.files.get(EXEC_PATH)).toBe('bad-build');

    // Boot 4 finds three failures behind it and refuses to repeat them.
    expect(h.runtime.onStarting()).toBe(true);
    expect(h.files.get(EXEC_PATH)).toBe('good-build');
    // The exchange keeps the failing build, so a hand-run rollback rolls forward again.
    expect(h.files.get(PREVIOUS_PATH)).toBe('bad-build');

    const receipts = h.receipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.text).toStartWith('rolled back to the previously installed version at 14:30');
    expect(receipts[0]!.text).toContain('failed to start 3 times in a row');

    // The activity log flushes asynchronously and this process is about to
    // hand over, so the reason also goes out synchronously on stderr.
    expect(h.stderr.join('')).toContain('rolled back to the kept previous version');

    await Bun.sleep(10);
    // The handover took the orderly stop path before exiting, so shutdown hooks fire.
    expect(h.stops).toHaveLength(1);
    expect(h.exits).toEqual([0]);
  });

  test('a healthy boot in the middle resets the counter — no rollback', () => {
    const h = rollbackHarness({ artifact: ARTIFACT });
    expect(h.runtime.onStarting()).toBe(false);
    expect(h.runtime.onStarting()).toBe(false);
    h.runtime.onStarted(); // reached fully-started
    expect(h.runtime.onStarting()).toBe(false);
    expect(h.runtime.onStarting()).toBe(false);
    expect(h.runtime.onStarting()).toBe(false);
    expect(h.files.get(EXEC_PATH)).toBe('bad-build');
    h.runtime.onStopping(false);
  });

  test('never twice in a row: a second crash loop after a rollback is refused, not ping-ponged', async () => {
    const h = rollbackHarness({ artifact: ARTIFACT });
    for (let i = 0; i < 4; i++) h.runtime.onStarting();
    await Bun.sleep(10);
    expect(h.files.get(EXEC_PATH)).toBe('good-build');
    // The restored build fails just as hard: four more boots, and the daemon
    // stays on it rather than exchanging back onto the build it just rejected.
    for (let i = 0; i < 4; i++) expect(h.runtime.onStarting()).toBe(false);
    expect(h.files.get(EXEC_PATH)).toBe('good-build');
    expect(h.receipts()).toHaveLength(1);
  });

  test('no kept previous copy: the boot continues and no rollback is claimed', async () => {
    const h = rollbackHarness({ artifact: ARTIFACT, installed: { [EXEC_PATH]: 'bad-build' } });
    for (let i = 0; i < 4; i++) expect(h.runtime.onStarting()).toBe(false);
    await Bun.sleep(10);
    expect(h.files.get(EXEC_PATH)).toBe('bad-build');
    expect(h.receipts()).toHaveLength(0);
    expect(h.exits).toEqual([]);
    // Said out loud rather than continuing in silence on a build that will not start.
    expect(h.stderr.join('')).toContain('no kept previous version is on disk');
  });

  test('host-managed updates (no artifact identity): boots are never counted and nothing is restored', () => {
    const h = rollbackHarness({});
    for (let i = 0; i < 6; i++) expect(h.runtime.onStarting()).toBe(false);
    expect(h.files.get(EXEC_PATH)).toBe('bad-build');
    expect(h.receipts()).toHaveLength(0);
  });

  test('update.rollbackAfterFailedStarts=0 leaves a bad update in place for a hand-run rollback', () => {
    const h = rollbackHarness({ artifact: ARTIFACT, threshold: 0 });
    for (let i = 0; i < 6; i++) expect(h.runtime.onStarting()).toBe(false);
    expect(h.files.get(EXEC_PATH)).toBe('bad-build');
    expect(h.receipts()).toHaveLength(0);
  });
});

/**
 * A streak accuses a BUILD. The failure this pins: a daemon that had been up
 * for ten and a half hours rolled itself back to the kept previous binary, and
 * that older binary could not start at all, the machine had no daemon from
 * that night until the next morning. The streak it acted on was not its own.
 */
describe('the failed-start streak is scoped to the build it accuses', () => {
  test('a streak recorded by one version does not carry over to the version that replaced it', () => {
    const { io } = memoryMarkerIo();
    let clock = 1_000_000;
    const now = (): number => clock;
    // 1.24.1 fails to start twice, in quick succession.
    recordDaemonStartAttempt(MARKER, { io, now, version: '1.24.1' });
    clock += 2_000;
    expect(recordDaemonStartAttempt(MARKER, { io, now, version: '1.24.1' }).failedStarts).toBe(1);
    clock += 2_000;
    // The binary on disk is now a different one (an update, a rollback, a
    // hand-run install). Its first boot starts from zero: it has not failed.
    expect(recordDaemonStartAttempt(MARKER, { io, now, version: '1.27.0' }).failedStarts).toBe(0);
    clock += 2_000;
    expect(recordDaemonStartAttempt(MARKER, { io, now, version: '1.27.0' }).failedStarts).toBe(1);
  });

  test('a marker with no version recorded (an older install) still counts, so upgrading in place loses nothing', () => {
    const { io } = memoryMarkerIo();
    let clock = 1_000_000;
    const now = (): number => clock;
    recordDaemonStartAttempt(MARKER, { io, now });
    clock += 2_000;
    expect(recordDaemonStartAttempt(MARKER, { io, now, version: '1.27.0' }).failedStarts).toBe(1);
  });

  test('an in-process restart cycle is not a boot: a daemon that came up cannot accumulate failed starts', () => {
    const h = rollbackHarness({ artifact: ARTIFACT });
    // This process boots and reaches a fully-started daemon.
    expect(h.runtime.onStarting()).toBe(false);
    h.runtime.onStarted();
    // Six control-plane binding changes, each re-entering start() and stop().
    // None of them is a boot that failed, so none of them counts toward the
    // crash-loop threshold and the binary on disk is never touched.
    for (let i = 0; i < 6; i++) {
      h.runtime.onStopping(true);
      expect(h.runtime.onStarting()).toBe(false);
      h.runtime.onStarted();
    }
    expect(h.files.get(EXEC_PATH)).toBe('bad-build'); // unchanged: nothing was restored
    expect(h.alerts).toEqual([]);
    // Nor does a restart cycle mint a crash receipt: the marker it reads is the
    // one THIS process wrote moments ago, which of course still says `running`.
    expect(h.receipts()).toHaveLength(0);
  });

  test('a genuine crash is still reported once, on the first fully-started moment of the NEXT process', () => {
    const first = rollbackHarness({ artifact: ARTIFACT });
    first.runtime.onStarting();
    first.runtime.onStarted();
    // No orderly stop, this process died. The marker is left saying `running`.
    expect(first.marker()?.state).toBe('running');
    expect(first.receipts()).toHaveLength(0);

    // The next process, same host, same marker and receipt store.
    const next = rollbackHarness({
      artifact: ARTIFACT,
      marker: first.markerFs,
      controlPlaneDir: first.scratch,
    });
    next.runtime.onStarting();
    next.runtime.onStarted();
    const receipts = next.receipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.text).toStartWith('restarted after a crash at');
    // And it is reported once, not again on every restart cycle that follows.
    next.runtime.onStopping(true);
    next.runtime.onStarting();
    next.runtime.onStarted();
    expect(next.receipts()).toHaveLength(1);
  });
});

/**
 * The cycle: install, fail three starts, roll back, and, one check interval
 * later, download and install the identical release again. Two byte-identical
 * rollback receipts two days apart, and an installed daemon three releases
 * behind, is what that looks like from outside.
 */
describe('a rollback records the version it rejected', () => {
  test('the rejected version is persisted, so the update loop can refuse to reinstall it', async () => {
    const h = rollbackHarness({ artifact: ARTIFACT });
    for (let i = 0; i < 4; i++) h.runtime.onStarting();
    await Bun.sleep(10);
    expect(h.files.get(EXEC_PATH)).toBe('good-build');
    expect(h.marker()?.rejectedVersion).toBe('2.0.0');
  });

  test('the rejection outlives the restored build coming up healthy — that is the whole point', () => {
    const { io } = memoryMarkerIo();
    const now = (): number => 1_000_000;
    recordDaemonAutoRollback(MARKER, { io, now, rejectedVersion: '2.0.0' });
    // The restored 1.9.0 boots and reaches fully-started. Its update loop runs
    // moments later; the rejection has to still be readable, or it downloads
    // 2.0.0 again.
    recordDaemonStart(MARKER, { io, now, pid: 99, version: '1.9.0' });
    expect(readLifecycleMarker(MARKER, io)?.rejectedVersion).toBe('2.0.0');
    // A clean shutdown keeps it too, a restart must not un-reject a bad build.
    recordDaemonCleanShutdown(MARKER, { io, now, version: '1.9.0' });
    expect(readLifecycleMarker(MARKER, io)?.rejectedVersion).toBe('2.0.0');
  });

  test('the rejection clears when the rejected version itself starts successfully — never a permanent pin', () => {
    const { io } = memoryMarkerIo();
    const now = (): number => 1_000_000;
    recordDaemonAutoRollback(MARKER, { io, now, rejectedVersion: '2.0.0' });
    // The owner reinstalled 2.0.0 by hand and it came up. The rejection was
    // about this host, and this host now disagrees with it.
    recordDaemonStart(MARKER, { io, now, pid: 99, version: '2.0.0' });
    expect(readLifecycleMarker(MARKER, io)?.rejectedVersion).toBeUndefined();
  });

  test('a rejected version is content-validated like every other persisted field', () => {
    const { io, files } = memoryMarkerIo();
    files.set(MARKER, JSON.stringify({
      state: 'running', at: 1, failedStarts: 0,
      rejectedVersion: 'x'.repeat(500), // absurd; not carried into a log line or an alert
      version: { not: 'a string' },
    }));
    const marker = readLifecycleMarker(MARKER, io);
    expect(marker?.rejectedVersion).toBeUndefined();
    expect(marker?.version).toBeUndefined();
  });

  test('the rollback tells the owner directly instead of leaving a receipt nobody consumes', async () => {
    const h = rollbackHarness({ artifact: ARTIFACT });
    for (let i = 0; i < 4; i++) h.runtime.onStarting();
    await Bun.sleep(10);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toContain('rolled itself back');
    expect(h.alerts[0]).toContain('from v2.0.0');
    expect(h.alerts[0]).toContain('3 starts in a row');
    // And it says what happens next, so the owner is not left to guess whether
    // the machine will ever update again.
    expect(h.alerts[0]).toContain('until a newer one ships');
  });
});
