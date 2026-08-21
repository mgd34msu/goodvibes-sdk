/**
 * test-helper-teardown-guard.test.ts
 *
 * Guards the two helpers the suite relies on to stay leak-free:
 * `trackDisposables()` (test/_helpers/disposables.ts) and `trackGlobalStubs()`
 * (test/_helpers/global-stubs.ts).
 *
 * These helpers are load-bearing: ~40 test files depend on them to stop the
 * pollers and restore the process-wide globals they touch. If either quietly
 * stopped tearing down, nothing else in the suite would fail, the damage
 * lands in *other* files as phantom timer callbacks and a frozen clock. So the
 * teardown behaviour itself is asserted here.
 *
 * Cross-test observation is deliberate: a disposal that is supposed to happen
 * "after each test" can only be proven by a LATER test reading the flag.
 */
import { describe, expect, test } from 'bun:test';

import { trackDisposables } from './_helpers/disposables.ts';
import { trackGlobalStubs } from './_helpers/global-stubs.ts';

const disposables = trackDisposables();
const stubs = trackGlobalStubs();

/**
 * Bun's `typeof fetch` includes a `preconnect` static method that plain mock
 * functions don't have. Attach a no-op stub so test doubles satisfy the type
 * without pretending to implement real preconnect behavior.
 */
function withPreconnect(
  impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(impl, {
    preconnect: (_url: string | URL, _options?: { dns?: boolean; tcp?: boolean; http?: boolean; https?: boolean }) => {},
  });
}

// --------------------------------------------------------------------------
// trackDisposables, method detection
// --------------------------------------------------------------------------
describe('trackDisposables — disposes what a test registers', () => {
  const log: string[] = [];

  test('registers values with dispose/stop/close and returns them unchanged', () => {
    const withDispose = disposables.add({ disposed: false, dispose() { this.disposed = true; log.push('dispose'); } });
    const withStop = disposables.add({ stopped: false, stop() { this.stopped = true; log.push('stop'); } });
    const withClose = disposables.add({ closed: false, close() { this.closed = true; log.push('close'); } });

    // add() hands the value straight back so it can wrap a constructor call.
    expect(withDispose.disposed).toBe(false);
    expect(withStop.stopped).toBe(false);
    expect(withClose.closed).toBe(false);
    expect(disposables.size).toBe(3);
  });

  test('everything registered by the previous test was disposed after it', () => {
    // The real assertion: the afterEach hook fired and drained the registry.
    expect(disposables.size).toBe(0);
    // LIFO, later registrations unwind first.
    expect(log).toEqual(['close', 'stop', 'dispose']);
  });
});

describe('trackDisposables — explicit disposers and bare callbacks', () => {
  const seen: string[] = [];

  test('an explicit disposer overrides method detection', () => {
    const target = { dispose: () => seen.push('WRONG-auto') };
    disposables.add(target, () => { seen.push('explicit'); });
    disposables.defer(() => { seen.push('deferred'); });
    expect(seen).toEqual([]);
  });

  test('the explicit disposer ran and the auto one did not', () => {
    expect(seen).toEqual(['deferred', 'explicit']);
    expect(seen).not.toContain('WRONG-auto');
  });
});

describe('trackDisposables — refuses to silently leak', () => {
  test('a value with no teardown method is rejected loudly', () => {
    expect(() => disposables.add({ notDisposable: true })).toThrow(
      /no dispose\/stop\/close\/destroy\/shutdown method/,
    );
    // Nothing was registered, so nothing is silently leaked.
    expect(disposables.size).toBe(0);
  });

  test('a disposer that throws is surfaced, not swallowed', async () => {
    const local = trackDisposables();
    local.add({ dispose: () => { throw new Error('teardown exploded'); } });
    await expect(local.flush()).rejects.toThrow(/teardown exploded/);
    // The registry is drained even when disposal failed, so a retry is clean.
    expect(local.size).toBe(0);
  });

  test('flush is idempotent and disposes each item exactly once', async () => {
    const local = trackDisposables();
    let count = 0;
    local.add({ dispose: () => { count += 1; } });
    await local.flush();
    await local.flush();
    expect(count).toBe(1);
  });
});

// --------------------------------------------------------------------------
// trackGlobalStubs, unconditional restore
// --------------------------------------------------------------------------
describe('trackGlobalStubs — restores process-wide globals after each test', () => {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;

  test('fetch and Date.now are replaced inside the test', () => {
    stubs.fetch(withPreconnect(async () => new Response('stubbed')));
    stubs.freezeNow(1_234_000);
    expect(globalThis.fetch).not.toBe(realFetch);
    expect(Date.now()).toBe(1_234_000);
  });

  test('both were restored after the previous test', () => {
    expect(globalThis.fetch).toBe(realFetch);
    expect(Date.now).toBe(realNow);
    // A real clock advances; a frozen one does not.
    expect(Date.now()).toBeGreaterThan(1_600_000_000_000);
  });

  test('a throwing test still gets its globals restored', async () => {
    const local = trackGlobalStubs();
    local.fetch(withPreconnect(async () => new Response('x')));
    expect(globalThis.fetch).not.toBe(realFetch);
    // Simulate the failure path that leaves hand-written restores unreached.
    try {
      throw new Error('test body failed');
    } catch {
      local.restoreAll();
    }
    expect(globalThis.fetch).toBe(realFetch);
  });

  test('env is restored, including keys that did not exist before', () => {
    const local = trackGlobalStubs();
    const absent = '__GOODVIBES_GUARD_ABSENT__';
    expect(process.env[absent]).toBeUndefined();
    local.env(absent, 'set-by-test');
    expect(process.env[absent]).toBe('set-by-test');
    local.restoreAll();
    // Restored to ABSENT, not to an empty string.
    expect(absent in process.env).toBe(false);
  });

  test('env restores a pre-existing value rather than deleting it', () => {
    const local = trackGlobalStubs();
    const key = '__GOODVIBES_GUARD_PRESENT__';
    process.env[key] = 'original';
    local.env(key, 'overridden');
    expect(process.env[key]).toBe('overridden');
    local.restoreAll();
    expect(process.env[key]).toBe('original');
    delete process.env[key];
  });

  test('captureConsole collects output and restores the method', () => {
    const local = trackGlobalStubs();
    const original = console.warn;
    const messages = local.captureConsole('warn');
    console.warn('captured', 1);
    expect(messages).toEqual([['captured', 1]]);
    local.restoreAll();
    expect(console.warn).toBe(original);
  });

  test('the shared registry drained after each of the tests above', () => {
    expect(stubs.size).toBe(0);
  });
});
