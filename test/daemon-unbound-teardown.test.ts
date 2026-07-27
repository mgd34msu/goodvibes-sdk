/**
 * daemon-unbound-teardown.test.ts
 *
 * A daemon that never bound a socket still has to release what it started.
 *
 * `DaemonServer` and `HttpListener` both start repeating work in their
 * CONSTRUCTORS, before anything is listening and regardless of whether it ever
 * will be: the companion-chat GC sweep, the batch manager's tick, and the HTTP
 * listener's two rate-limiter eviction sweeps. Both classes then opened stop()
 * with `if (this.server === null) return`, which reads "no socket, nothing to
 * do" — but the socket was never what those timers hung off. Construct, enable,
 * and stop without ever starting (a port collision, a config that keeps the
 * daemon off, a host that changes its mind) and every one of them kept ticking
 * with no reachable teardown left.
 *
 * Measured the same way the shutdown test measures: wrap the timer globals for
 * exactly the construct→stop window, then read what survived. Runs in the
 * ordinary suite, no preload required.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { DaemonServer } from '../packages/sdk/src/platform/daemon/facade.ts';
import { HttpListener } from '../packages/sdk/src/platform/daemon/http-listener.ts';
import { UserAuthManager } from '../packages/sdk/src/platform/security/user-auth.ts';

/**
 * Modules whose repeating work is started by a CONSTRUCTOR, so it exists before
 * any socket does. A survivor from one of these is the defect this file covers.
 */
const CONSTRUCTOR_OWNED = [
  'companion/companion-chat-manager',
  'batch/manager',
  'daemon/http/rate-limiter',
] as const;

interface Tracked { readonly kind: 'interval' | 'timeout'; readonly delayMs: number; readonly stack: string }

const live = new Map<unknown, Tracked>();
let created = 0;

const realSetInterval = globalThis.setInterval;
const realSetTimeout = globalThis.setTimeout;
const realClearInterval = globalThis.clearInterval;
const realClearTimeout = globalThis.clearTimeout;

function install(): void {
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
    const wrapped = (...a: unknown[]): void => { live.delete(handle); (fn as (...x: unknown[]) => void)(...a); };
    handle = realSetTimeout(wrapped as never, ms as never, ...(rest as never[]));
    created += 1;
    live.set(handle, { kind: 'timeout', delayMs: ms ?? 0, stack: new Error().stack ?? '' });
    return handle as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;
  globalThis.clearInterval = ((h: never) => { live.delete(h); return realClearInterval(h); }) as typeof globalThis.clearInterval;
  globalThis.clearTimeout = ((h: never) => { live.delete(h); return realClearTimeout(h); }) as typeof globalThis.clearTimeout;
}

function restore(): void {
  globalThis.setInterval = realSetInterval;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearInterval = realClearInterval;
  globalThis.clearTimeout = realClearTimeout;
}

function siteOf(stack: string): string {
  for (const line of stack.split('\n').slice(2)) {
    const match = /([^\s()]+\.(?:ts|tsx|js|mjs)):\d+:\d+/.exec(line);
    if (!match) continue;
    if (/daemon-unbound-teardown|node:internal/.test(line)) continue;
    const fn = /at\s+(?:async\s+)?([^\s(]+)\s*\(/.exec(line)?.[1] ?? '';
    return `${fn} (${match[1].replace(/^.*\/(test|packages|src)\//, '$1/')})`;
  }
  return '<unknown site>';
}

function describeLive(): string[] {
  return [...live.values()].map((t) => `${t.kind} ${t.delayMs}ms ${siteOf(t.stack)}`);
}

let home: string;
let work: string;
let liveBeforeStop: string[] = [];
let liveAfterStop: string[] = [];
let createdDuringRun = 0;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'unbound-home-'));
  work = mkdtempSync(join(tmpdir(), 'unbound-work-'));

  install();
  try {
    const configManager = new ConfigManager({
      surfaceRoot: 'daemon', configDir: join(home, 'cfg'), workingDir: work, homeDir: home,
    });
    // Enabled, and never started. `serveFactory` is supplied but never called:
    // the point of the case is that nothing ever binds.
    const daemon = new DaemonServer({
      configManager, workingDir: work, homeDirectory: home,
      daemonHomeDir: join(home, 'daemon'), port: 0, host: '127.0.0.1',
    });
    daemon.enable({ daemon: true }, 'unbound-token');
    const listener = new HttpListener({
      configManager,
      port: 0,
      host: '127.0.0.1',
      userAuth: new UserAuthManager({
        bootstrapFilePath: join(home, 'auth-users.json'),
        bootstrapCredentialPath: join(home, 'auth-bootstrap.txt'),
      }),
    });

    liveBeforeStop = describeLive();
    createdDuringRun = created;
    await Promise.all([daemon.stop(), listener.stop()]);
    liveAfterStop = describeLive();

    // Composing the graph starts background work that was genuinely in flight
    // when stop() was called — the checkpoint manager's cross-process lock and
    // its 5s mtime refresh, a git probe, a log flush. None is a poller this
    // object left running, but they are real handles, and this file runs inside
    // the shared-process leak scan where a handle that outlives its file fires
    // inside every later one. Give them a bounded chance to settle rather than
    // handing them on.
    const deadline = Date.now() + 20_000;
    while (live.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => realSetTimeout(resolve, 50));
    }
  } finally {
    restore();
  }
}, 60_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

test('construction alone really does arm timers — the measurement is not vacuous', () => {
  const armed = liveBeforeStop.filter((e) => CONSTRUCTOR_OWNED.some((o) => e.includes(o)));
  expect(createdDuringRun).toBeGreaterThan(0);
  expect(armed).not.toEqual([]);
});

test('stop() on a daemon that never bound a socket still releases what construction started', () => {
  const survivors = liveAfterStop.filter((e) => CONSTRUCTOR_OWNED.some((o) => e.includes(o)));
  expect(survivors).toEqual([]);
});
