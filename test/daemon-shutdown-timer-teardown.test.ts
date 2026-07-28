/**
 * daemon-shutdown-timer-teardown.test.ts
 *
 * A daemon that is told to stop must leave nothing of its own still ticking.
 *
 * `createRuntimeServices()` starts pollers while it composes: the config-file
 * watch (250ms), the fleet registry tick (750ms), the memory governor (5s), the
 * watcher registry (60s), the cross-session orchestration sweep (1h), the
 * orchestration snapshot writer's reap (1h), the push-subscription sweep (1h),
 * the knowledge scheduler's reconcile timers, and the snapshot / append-only /
 * consolidation schedulers. Every one of those owners had a `stop()` or
 * `dispose()`; nothing called them, because the graph had no disposal seam. A
 * `bootDaemon()` + `stop()` measured on this file left 19 handles live, 8 of
 * them intervals that would tick for the life of the process.
 *
 * Two properties are held down here, and they are different:
 *
 *  1. No poller survives `stop()`. Measured the instant stop() returns, against
 *     the named set of modules that own repeating work. A poller is permanent —
 *     it never drains — so this is the assertion that actually proves the seam.
 *  2. Nothing at all survives shortly after. A handle owned by an operation
 *     that was genuinely in flight when stop() was called (the push store's
 *     fire-and-forget boot recovery sweep holds a cross-process lock, whose
 *     5s mtime-refresh interval lives until the sweep releases it) is not a
 *     leak, but it must still end. This catches anything that merely looks
 *     transient and is not.
 *
 * Deliberately self-contained rather than leaning on the GOODVIBES_LEAK_DETECT
 * preload: it wraps the timer globals for exactly the boot→stop window, so it
 * runs and fails in the ordinary suite. `scripts/leak-scan.ts` measures the
 * same class of defect process-wide across the whole suite.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';

const TOKEN = 'shutdown-teardown-token';

/**
 * Modules that own repeating work started by the runtime graph. A handle
 * attributed to any of these after stop() is a poller that was never disposed —
 * the exact defect this file exists to prevent regressing.
 */
const POLLER_OWNERS = [
  'config/config-file-watcher',
  'runtime/fleet/registry',
  'runtime/memory/memory-governor',
  'watchers/registry',
  'sessions/orchestration/registry',
  'orchestration/persistence',
  'push/subscription-store',
  'state/store-snapshots',
  'runtime/retention/append-only-registry',
  'state/memory-consolidation-scheduler',
  'knowledge/scheduling',
  'agents/wrfc-controller',
] as const;

interface TrackedTimer {
  readonly kind: 'interval' | 'timeout';
  readonly delayMs: number;
  readonly stack: string;
}

const live = new Map<unknown, TrackedTimer>();
let created = 0;

const realSetInterval = globalThis.setInterval;
const realSetTimeout = globalThis.setTimeout;
const realClearInterval = globalThis.clearInterval;
const realClearTimeout = globalThis.clearTimeout;

/**
 * One-shot timeouts are tracked as well as intervals, because a `setTimeout`
 * that reschedules itself is a poller wearing a different hat — three of the
 * schedulers above are exactly that. A timeout leaves the live set when it
 * fires, so an ordinary elapsed sleep never counts as still-live.
 */
function installTimerTracking(): void {
  created = 0;
  live.clear();
  globalThis.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const handle = realSetInterval(fn as never, ms as never, ...(rest as never[]));
    created += 1;
    live.set(handle, { kind: 'interval', delayMs: ms ?? 0, stack: new Error().stack ?? '' });
    return handle;
  }) as typeof globalThis.setInterval;
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    let handle: unknown;
    const wrapped = (...a: unknown[]): void => {
      live.delete(handle);
      (fn as (...x: unknown[]) => void)(...a);
    };
    handle = realSetTimeout(wrapped as never, ms as never, ...(rest as never[]));
    created += 1;
    live.set(handle, { kind: 'timeout', delayMs: ms ?? 0, stack: new Error().stack ?? '' });
    return handle as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;
  globalThis.clearInterval = ((handle: never) => {
    live.delete(handle);
    return realClearInterval(handle);
  }) as typeof globalThis.clearInterval;
  globalThis.clearTimeout = ((handle: never) => {
    live.delete(handle);
    return realClearTimeout(handle);
  }) as typeof globalThis.clearTimeout;
}

function restoreTimerTracking(): void {
  globalThis.setInterval = realSetInterval;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearInterval = realClearInterval;
  globalThis.clearTimeout = realClearTimeout;
}

/** The frame that made the timer — the field that names what still needs disposing. */
function siteOf(stack: string): string {
  for (const line of stack.split('\n').slice(2)) {
    const match = /([^\s()]+\.(?:ts|tsx|js|mjs)):\d+:\d+/.exec(line);
    if (!match) continue;
    if (/daemon-shutdown-timer-teardown|node:internal/.test(line)) continue;
    const fn = /at\s+(?:async\s+)?([^\s(]+)\s*\(/.exec(line)?.[1] ?? '';
    const file = (match[1] ?? '').replace(/^.*\/(test|packages|src)\//, '$1/');
    return fn ? `${fn} (${file})` : file;
  }
  return '<unknown site>';
}

function describeLive(): string[] {
  return [...live.values()].map((t) => `${t.kind} ${t.delayMs}ms ${siteOf(t.stack)}`);
}

let home: string;
let work: string;
let daemon: BootedDaemon;
/** Everything still live the instant stop() returned (plus a microtask grace). */
let liveAtStop: string[] = [];
/** Everything still live after giving genuinely in-flight work time to finish. */
let liveAfterDrain: string[] = [];
let createdDuringRun = 0;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'shutdown-home-'));
  work = mkdtempSync(join(tmpdir(), 'shutdown-work-'));

  installTimerTracking();
  try {
    daemon = await bootDaemon({
      homeDirectory: home,
      workingDir: work,
      daemonHomeDir: join(home, 'daemon'),
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
    });
    await daemon.stop();
    // A microtask grace only: teardown that lands on an `await` chain has run,
    // but nothing has had time to *drain*. This is the strict snapshot.
    await new Promise((resolve) => realSetTimeout(resolve, 50));
    createdDuringRun = created;
    liveAtStop = describeLive();

    // Then give in-flight work a bounded chance to finish. Polling rather than
    // one long sleep so the test costs what it needs and no more.
    const deadline = Date.now() + 10_000;
    while (live.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => realSetTimeout(resolve, 50));
    }
    liveAfterDrain = describeLive();
  } finally {
    restoreTimerTracking();
  }
  // Explicit hook budget: the drain deadline above is 10s, and a regression
  // here means the drain never completes. Without the headroom this hook dies
  // on bun's 5s default and the failure reads as a timeout instead of naming
  // the pollers that survived.
}, 60_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

test('bootDaemon() actually starts timers — the measurement is not vacuous', () => {
  // Guards the false pass where the graph stopped composing anything and the
  // leak count reads zero for entirely the wrong reason.
  expect(createdDuringRun).toBeGreaterThan(10);
});

test('stop() leaves no poller from the runtime graph still running', () => {
  const survivors = liveAtStop.filter((entry) => POLLER_OWNERS.some((owner) => entry.includes(owner)));
  expect(survivors).toEqual([]);
});

test('every timer the daemon started is gone once in-flight work settles', () => {
  expect(liveAfterDrain).toEqual([]);
});
