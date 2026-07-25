/**
 * persisted-store-housekeeping.test.ts — the standing rule for anything the
 * platform persists across restarts and crashes: recovery must do real
 * housekeeping. Reap records whose owner is gone, bound the store by BOTH a
 * count and an age, validate by content rather than by existence, sweep for as
 * long as the process lives (not only at boot), and disclose what was reaped.
 *
 * Four stores are covered here, one defect each:
 *
 *  1. The append-only retention registry swept exactly ONCE, at runtime
 *     construction. A daemon that stays up for weeks therefore never pruned any
 *     of its six registered stores again after boot. It also had no count bound
 *     at all — only age (30 days) and total size (512 MB), which ten thousand
 *     small fresh files sit comfortably under.
 *  2. The checkpoint cross-process lock left an orphan `.gv-lock.new-<pid>-<hex>`
 *     staging file behind whenever a process died between creating it and
 *     linking it onto the lock path. Nothing ever swept those.
 *  3. Daemon receipts had a 50-record count cap but no age bound at all, and a
 *     torn receipt file read as "no receipts" in complete silence — data loss
 *     and a clean slate look identical from the outside.
 *  4. The last-session pointer was written with a plain writeFileSync, so a
 *     crash mid-write could tear a previously-good pointer; and a pointer at a
 *     session that retention had already reclaimed was never retired.
 */
import { afterEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  AppendOnlyRetentionScheduler,
  APPEND_ONLY_SWEEP_INTERVAL_MS,
  runAppendOnlyRetentionSweep,
  type AppendOnlyRetentionRoots,
} from '../packages/sdk/src/platform/runtime/retention/append-only-registry.ts';
import { resolveScopedDirectory } from '../packages/sdk/src/platform/runtime/surface-root.ts';
import { acquireCrossProcessLock } from '../packages/sdk/src/platform/workspace/checkpoint/cross-process-lock.ts';
import { DaemonReceiptStore, type ReceiptStoreIo } from '../packages/sdk/src/platform/daemon/receipts.ts';
import {
  loadLastConversation,
  readLastSessionPointer,
  writeLastSessionPointer,
} from '../packages/sdk/src/platform/runtime/session-persistence.ts';
import { createSessionSurface, type SessionSurface } from '../packages/sdk/src/platform/runtime/session-surface.ts';
import { SessionManager } from '../packages/sdk/src/platform/sessions/manager.ts';
import { logger } from '../packages/sdk/src/platform/utils/logger.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

/** Write a jsonl file and stamp its mtime, so retention sees a chosen age. */
function writeAgedFile(path: string, contents: string, ageMs: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
  const seconds = (Date.now() - ageMs) / 1000;
  utimesSync(path, seconds, seconds);
}

/** A fake timer handle whose unref() we can observe. */
interface FakeTimer {
  readonly id: number;
  unrefCount: number;
  unref(): void;
}

function makeTimerHarness(): {
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  fireLatest(): void;
  readonly scheduled: Array<{ ms: number; timer: FakeTimer }>;
  readonly cleared: FakeTimer[];
} {
  const scheduled: Array<{ ms: number; timer: FakeTimer }> = [];
  const cleared: FakeTimer[] = [];
  const callbacks: Array<() => void> = [];
  let nextId = 1;
  return {
    scheduled,
    cleared,
    setTimer: (fn, ms) => {
      const timer: FakeTimer = {
        id: nextId++,
        unrefCount: 0,
        unref() {
          this.unrefCount += 1;
        },
      };
      scheduled.push({ ms, timer });
      callbacks.push(fn);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      cleared.push(timer as unknown as FakeTimer);
    },
    fireLatest() {
      const fn = callbacks.pop();
      if (!fn) throw new Error('no scheduled timer callback to fire');
      fn();
    },
  };
}

/** The retention log lines the sweep emits, captured off the shared logger. */
function captureRetentionInfo(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const spy = spyOn(logger, 'info') as Mock<typeof logger.info>;
  spy.mockImplementation((message: string) => {
    if (message.startsWith('[retention]')) lines.push(message);
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('append-only retention sweeps for the life of the process, not only at boot', () => {
  function recoveryRoots(): { roots: AppendOnlyRetentionRoots; recoveryDir: string } {
    const workingDirectory = tempDir(`gv-housekeeping-${randomUUID()}-`);
    const surfaceRoot = 'tui';
    const recoveryDir = resolveScopedDirectory(workingDirectory, surfaceRoot, 'recovery');
    mkdirSync(recoveryDir, { recursive: true });
    return { roots: { workingDirectory, surfaceRoot }, recoveryDir };
  }

  test('the interval is stated in hours, not minutes', () => {
    expect(APPEND_ONLY_SWEEP_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    expect(APPEND_ONLY_SWEEP_INTERVAL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });

  test('RED: a periodic sweep fires more than once and reclaims on a LATER tick', () => {
    const { roots: sweepRoots, recoveryDir } = recoveryRoots();
    const harness = makeTimerHarness();
    const outcomes: Array<number> = [];
    const scheduler = new AppendOnlyRetentionScheduler({
      roots: sweepRoots,
      intervalMs: 1_000,
      setTimer: harness.setTimer,
      clearTimer: harness.clearTimer,
      onSweep: (outcome) => outcomes.push(outcome?.deletedFiles ?? -1),
    });

    scheduler.start();
    expect(harness.scheduled).toHaveLength(1);
    // Unref'd: a pending sweep can never be what holds the process open.
    expect(harness.scheduled[0]?.timer.unrefCount).toBe(1);
    expect(harness.scheduled[0]?.ms).toBe(1_000);

    // Starting twice is safe: no second timer, no second sweep loop.
    scheduler.start();
    expect(harness.scheduled).toHaveLength(1);

    // First tick: nothing to reclaim yet.
    harness.fireLatest();
    expect(outcomes).toEqual([0]);
    expect(harness.scheduled).toHaveLength(2); // re-armed

    // The store only goes stale AFTER boot — this is the case a startup-only
    // sweep can never reach.
    writeAgedFile(join(recoveryDir, 'recovery-late.jsonl'), '{"type":"x"}\n', 45 * DAY_MS);
    harness.fireLatest();
    expect(outcomes).toEqual([0, 1]);
    expect(existsSync(join(recoveryDir, 'recovery-late.jsonl'))).toBe(false);
    expect(harness.scheduled).toHaveLength(3);

    // The disposer really stops it: the timer is cleared and nothing re-arms.
    scheduler.stop();
    expect(harness.cleared).toHaveLength(1);
    expect(scheduler.isRunning).toBe(false);
    const scheduledAtStop = harness.scheduled.length;
    scheduler.stop(); // idempotent
    expect(harness.scheduled).toHaveLength(scheduledAtStop);
  });

  test('a sweep that reclaims nothing writes no log line', () => {
    const { roots: sweepRoots, recoveryDir } = recoveryRoots();
    // A fresh file: under every cap, so there is nothing to disclose.
    writeAgedFile(join(recoveryDir, 'recovery-fresh.jsonl'), '{"type":"x"}\n', 1_000);
    const harness = makeTimerHarness();
    const scheduler = new AppendOnlyRetentionScheduler({
      roots: sweepRoots,
      intervalMs: 1_000,
      setTimer: harness.setTimer,
      clearTimer: harness.clearTimer,
    });

    const captured = captureRetentionInfo();
    try {
      scheduler.start();
      harness.fireLatest();
      harness.fireLatest();
      harness.fireLatest();
    } finally {
      captured.restore();
      scheduler.stop();
    }
    expect(captured.lines).toEqual([]);
    expect(existsSync(join(recoveryDir, 'recovery-fresh.jsonl'))).toBe(true);
  });

  test('a reclaiming sweep DOES disclose what it reaped', () => {
    const { roots: sweepRoots, recoveryDir } = recoveryRoots();
    writeAgedFile(join(recoveryDir, 'recovery-ancient.jsonl'), '{"type":"x"}\n', 45 * DAY_MS);
    const captured = captureRetentionInfo();
    try {
      runAppendOnlyRetentionSweep(sweepRoots);
    } finally {
      captured.restore();
    }
    expect(captured.lines).toContain('[retention] append-only store reclaimed files');
    expect(captured.lines).toContain('[retention] append-only retention sweep reclaimed files');
  });

  test('RED: the file-COUNT bound reclaims a store that is under both the age and size caps', () => {
    const { roots: sweepRoots, recoveryDir } = recoveryRoots();
    // Seven small, recent files: well inside the 30-day age cap and nowhere
    // near the 512 MB size cap. Age + size alone would leave every one.
    for (let i = 0; i < 7; i += 1) {
      writeAgedFile(join(recoveryDir, `recovery-${i}.jsonl`), '{"type":"x"}\n', (7 - i) * 60_000);
    }

    const untouched = runAppendOnlyRetentionSweep(sweepRoots);
    expect(untouched.deletedFiles).toBe(0);
    expect(readdirSync(recoveryDir)).toHaveLength(7);

    const capped = runAppendOnlyRetentionSweep(sweepRoots, { maxFilesOverride: 3 });
    expect(capped.countCappedFiles).toBe(4);
    expect(capped.deletedFiles).toBe(4);
    // Oldest-first: the three NEWEST survive (index 4, 5, 6 are the youngest).
    expect(readdirSync(recoveryDir).sort()).toEqual(['recovery-4.jsonl', 'recovery-5.jsonl', 'recovery-6.jsonl']);

    // Idempotent: the second reap is a no-op, not a second round of deletions.
    const again = runAppendOnlyRetentionSweep(sweepRoots, { maxFilesOverride: 3 });
    expect(again.deletedFiles).toBe(0);
    expect(again.countCappedFiles).toBe(0);
    expect(readdirSync(recoveryDir)).toHaveLength(3);
  });
});

describe('cross-process lock reclaims abandoned staging files', () => {
  test('RED: an orphaned .gv-lock.new-* is reaped while an in-flight one survives', async () => {
    const dir = tempDir(`gv-lockstaging-${randomUUID()}-`);
    const lockPath = join(dir, '.gv-lock');
    const staleMs = 400;

    // The litter a process leaves when it dies between openSync(staging,'wx')
    // and linkSync(staging, lockPath).
    const orphan = join(dir, '.gv-lock.new-999999-deadbeefcafe');
    writeAgedFile(orphan, '{"pid":999999}', 10 * 60 * 1000);
    // Another process's staging file, created microseconds ago and about to be
    // linked. Reaping this would be a genuine defect.
    const inFlight = join(dir, '.gv-lock.new-424242-0badc0ffee00');
    writeFileSync(inFlight, '{"pid":424242}', 'utf-8');

    const release = await acquireCrossProcessLock(lockPath, { staleMs, totalTimeoutMs: 5_000 });
    try {
      expect(existsSync(orphan)).toBe(false);
      expect(existsSync(inFlight)).toBe(true);
    } finally {
      release();
    }

    // Sweeping again is a no-op: the orphan is already gone and the in-flight
    // file (still being refreshed by its owner) is still not old enough.
    await new Promise((resolve) => setTimeout(resolve, staleMs + 100));
    const now = Date.now() / 1000;
    utimesSync(inFlight, now, now);
    const release2 = await acquireCrossProcessLock(lockPath, { staleMs, totalTimeoutMs: 5_000 });
    try {
      expect(existsSync(orphan)).toBe(false);
      expect(existsSync(inFlight)).toBe(true);
    } finally {
      release2();
    }
  });

  test('a normal acquire/release cycle leaves no staging litter of its own', async () => {
    const dir = tempDir(`gv-lockclean-${randomUUID()}-`);
    const lockPath = join(dir, '.gv-lock');
    const release = await acquireCrossProcessLock(lockPath, { totalTimeoutMs: 5_000 });
    release();
    expect(readdirSync(dir).filter((name) => name.includes('.new-'))).toEqual([]);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('daemon receipts are bounded by age as well as count, and disclose a torn file', () => {
  function memoryIo(initial: string | null): { io: ReceiptStoreIo; current(): string | null } {
    let contents = initial;
    return {
      io: {
        read: () => contents,
        write: (_path, next) => {
          contents = next;
        },
      },
      current: () => contents,
    };
  }

  function parsedIds(raw: string | null): string[] {
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<{ id: string }>;
    return parsed.map((entry) => entry.id);
  }

  test('RED: receipts past the age bound are retired at load and the reap is persisted', () => {
    const now = 1_700_000_000_000;
    const store = memoryIo(JSON.stringify([
      { id: 'ancient', text: 'updated from 1.0.0 to 1.0.1', at: now - 20 * DAY_MS },
      { id: 'recent', text: 'restarted after a crash', at: now - 1 * DAY_MS },
    ]));

    const infoSpy = spyOn(logger, 'info') as Mock<typeof logger.info>;
    const messages: string[] = [];
    infoSpy.mockImplementation((message: string) => {
      messages.push(message);
    });
    let receipts: DaemonReceiptStore;
    try {
      receipts = new DaemonReceiptStore('/virtual/receipts.json', { io: store.io, now: () => now });
    } finally {
      infoSpy.mockRestore();
    }

    expect(receipts.list().map((entry) => entry.id)).toEqual(['recent']);
    expect(parsedIds(store.current())).toEqual(['recent']);
    expect(messages).toContain('[daemon-receipt] retired receipts past their age bound');
  });

  test('the count cap still holds, and both bounds are idempotent', () => {
    const now = 1_700_000_000_000;
    const store = memoryIo(null);
    const receipts = new DaemonReceiptStore('/virtual/receipts.json', { io: store.io, now: () => now });
    for (let i = 0; i < 60; i += 1) receipts.record(`event ${i}`);
    expect(receipts.list()).toHaveLength(50);
    expect(receipts.list()[0]?.text).toBe('event 10');

    // Re-loading the same file changes nothing: no re-reap, no re-write drift.
    const before = store.current();
    const reloaded = new DaemonReceiptStore('/virtual/receipts.json', { io: store.io, now: () => now });
    expect(reloaded.list()).toHaveLength(50);
    expect(store.current()).toBe(before);
  });

  test('RED: a torn receipt file is disclosed rather than silently emptied', () => {
    const store = memoryIo('[{"id":"half-written","text":"upda');
    const warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
    const warnings: string[] = [];
    warnSpy.mockImplementation((message: string) => {
      warnings.push(message);
    });
    let receipts: DaemonReceiptStore;
    try {
      receipts = new DaemonReceiptStore('/virtual/receipts.json', { io: store.io, now: () => Date.now() });
    } finally {
      warnSpy.mockRestore();
    }
    expect(receipts.list()).toEqual([]);
    expect(warnings).toContain('[daemon-receipt] receipt file was unreadable — starting from an empty receipt history');
  });

  test('a zero-filled receipt file is torn, not empty', () => {
    const store = memoryIo('   \n');
    const warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
    const warnings: string[] = [];
    warnSpy.mockImplementation((message: string) => {
      warnings.push(message);
    });
    try {
      new DaemonReceiptStore('/virtual/receipts.json', { io: store.io, now: () => Date.now() });
    } finally {
      warnSpy.mockRestore();
    }
    expect(warnings).toContain('[daemon-receipt] receipt file was unreadable — starting from an empty receipt history');
  });

  test('an absent receipt file is NOT reported as torn', () => {
    const store = memoryIo(null);
    const warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
    const warnings: string[] = [];
    warnSpy.mockImplementation((message: string) => {
      warnings.push(message);
    });
    try {
      new DaemonReceiptStore('/virtual/receipts.json', { io: store.io, now: () => Date.now() });
    } finally {
      warnSpy.mockRestore();
    }
    expect(warnings).toEqual([]);
  });

  test('exactly-once delivery survives the new bounds', () => {
    const now = 1_700_000_000_000;
    const store = memoryIo(null);
    const receipts = new DaemonReceiptStore('/virtual/receipts.json', { io: store.io, now: () => now });
    receipts.record('updated from 1.0.0 to 1.0.1');
    expect(receipts.consumeUndelivered()).toHaveLength(1);
    expect(receipts.consumeUndelivered()).toHaveLength(0);
  });
});

describe('the last-session pointer is crash-safe and retires a dangling referent', () => {
  function tempSurface(): { surface: SessionSurface; workingDirectory: string } {
    const base = tempDir(`gv-pointer-${randomUUID()}-`);
    const workingDirectory = join(base, 'work');
    const homeDirectory = join(base, 'home');
    mkdirSync(workingDirectory, { recursive: true });
    mkdirSync(homeDirectory, { recursive: true });
    return {
      surface: createSessionSurface({ surfaceRoot: 'tui', workingDirectory, homeDirectory }),
      workingDirectory,
    };
  }

  test('RED: a torn pointer left by a crash mid-write is rejected, not served', () => {
    const { surface } = tempSurface();
    mkdirSync(surface.sessionsDir, { recursive: true });
    const pointerPath = join(surface.sessionsDir, 'last-session.json');
    // Exactly what a plain writeFileSync interrupted by a crash produces.
    writeFileSync(pointerPath, '{"sessionId": "abc123", "timesta', 'utf-8');
    expect(readLastSessionPointer({ surface })).toBeNull();
  });

  test('the atomic write leaves no temp file behind and publishes a readable pointer', () => {
    const { surface } = tempSurface();
    writeLastSessionPointer('abc123', { surface });
    expect(readLastSessionPointer({ surface })).toBe('abc123');
    const names = readdirSync(surface.sessionsDir);
    expect(names).toEqual(['last-session.json']);
    expect(names.filter((name) => name.includes('.tmp-'))).toEqual([]);
    const parsed = JSON.parse(readFileSync(join(surface.sessionsDir, 'last-session.json'), 'utf-8')) as { sessionId: string };
    expect(parsed.sessionId).toBe('abc123');
  });

  test('a good pointer survives being rewritten (the write can never tear it)', () => {
    const { surface } = tempSurface();
    writeLastSessionPointer('first', { surface });
    writeLastSessionPointer('second', { surface });
    expect(readLastSessionPointer({ surface })).toBe('second');
    expect(readdirSync(surface.sessionsDir)).toEqual(['last-session.json']);
  });

  test('RED: a pointer at a session that no longer exists is retired on load', () => {
    const { surface } = tempSurface();
    writeLastSessionPointer('ghost-session', { surface });
    expect(readLastSessionPointer({ surface })).toBe('ghost-session');

    expect(loadLastConversation({ surface })).toBeNull();
    // The dangling record is gone, not re-resolved on every future load.
    expect(existsSync(join(surface.sessionsDir, 'last-session.json'))).toBe(false);
    expect(readLastSessionPointer({ surface })).toBeNull();
    // Reaping twice is a no-op.
    expect(loadLastConversation({ surface })).toBeNull();
  });

  test('a pointer at a session that DOES exist is loaded and kept', () => {
    const { surface } = tempSurface();
    const manager = new SessionManager(surface.workingDirectory, { surface });
    manager.save('live-session', [{ role: 'user', content: 'hello' }], {
      title: 'live',
      model: 'test-model',
      provider: 'test',
      timestamp: Date.now(),
      saveSource: 'user',
    });
    writeLastSessionPointer('live-session', { surface });

    const loaded = loadLastConversation({ surface });
    expect(loaded?.messages).toHaveLength(1);
    expect(existsSync(join(surface.sessionsDir, 'last-session.json'))).toBe(true);
  });
});
