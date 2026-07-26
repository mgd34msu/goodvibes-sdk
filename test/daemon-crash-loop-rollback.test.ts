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
 *   - the two honest refusals — nothing to restore, and never twice in a row.
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
  readonly receipts: () => readonly { text: string }[];
}

function rollbackHarness(overrides: {
  readonly artifact?: DaemonLifecycleRuntimeOptions['updateArtifact'];
  readonly installed?: Record<string, string>;
  readonly threshold?: number;
} = {}): RollbackHarness {
  const scratch = mkdtempSync(join(tmpdir(), 'crash-loop-'));
  scratchDirs.push(scratch);
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
  const { io: markerIo } = memoryMarkerIo();
  const { io: rollbackIo, files } = memoryUpdateIo(
    overrides.installed ?? { [EXEC_PATH]: 'bad-build', [PREVIOUS_PATH]: 'good-build' },
  );
  const exits: number[] = [];
  const stops: number[] = [];
  const stderr: string[] = [];
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
    ...(overrides.artifact !== undefined ? { updateArtifact: overrides.artifact } : {}),
  });
  return { runtime, files, exits, stops, stderr, receipts: () => runtime.receiptStore().list() };
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
