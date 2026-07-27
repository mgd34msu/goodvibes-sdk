/**
 * Scoped replacement of process-wide globals, restored without fail.
 *
 * Every test file in this repo shares ONE process, so `globalThis.fetch`,
 * `Date.now`, `console.*` and `process.env` are shared mutable state. Two
 * failure modes follow, and both have actually happened here:
 *
 *  - A test replaces `globalThis.fetch` and restores it on the last line of the
 *    test body. The test throws, the line never runs, and every later file gets
 *    the stub.
 *  - A test freezes `Date.now` for the duration of an async body. Any
 *    background work running concurrently in the same process — a retry
 *    backoff, a staleness check, an idle sweep — reads a clock that never
 *    advances and silently misbehaves.
 *
 * This helper makes the restore automatic and unconditional: it runs in
 * `afterEach`, so it happens even when the test throws.
 *
 *   const stubs = trackGlobalStubs();
 *
 *   test('...', async () => {
 *     stubs.fetch(async () => new Response('{}'));
 *     // ...no restore to write.
 *   });
 *
 * Prefer an injectable seam on the code under test over freezing `Date.now` at
 * all; use `freezeNow` only where the code reads the global clock directly and
 * accepts no clock parameter.
 *
 * IMPORTANT — call `trackGlobalStubs()` at the top level of each test file.
 * `bun test` caches modules across files, so a helper that registered its
 * `afterEach` at import time would bind that hook only to the first file that
 * imported it and every later file would silently get no restore.
 */
import { afterEach } from 'bun:test';

type ConsoleMethod = 'debug' | 'error' | 'info' | 'log' | 'warn';

export interface GlobalStubRegistry {
  /** Replace `globalThis.fetch` for the rest of the current test. */
  fetch(impl: typeof globalThis.fetch): void;
  /** Freeze `Date.now()` at a fixed epoch for the rest of the current test. */
  freezeNow(nowMs: number): void;
  /** Set or (with `undefined`) unset an environment variable. */
  env(key: string, value: string | undefined): void;
  /** Capture a console method; returns the array that collects its arguments. */
  captureConsole(method: ConsoleMethod): unknown[][];
  /** Replace any other global property by name. */
  global(key: string, value: unknown): void;
  /** Restore everything now. Runs automatically after each test; idempotent. */
  restoreAll(): void;
  /** Outstanding stubs — used by this helper's own guard test. */
  readonly size: number;
}

export function trackGlobalStubs(): GlobalStubRegistry {
  const restores: Array<() => void> = [];

  const restoreAll = (): void => {
    // Reverse order so nested stubs of the same key unwind correctly.
    while (restores.length > 0) {
      const restore = restores.pop();
      try {
        restore?.();
      } catch {
        // A restore must never be the reason a test fails; the remaining
        // restores still have to run.
      }
    }
  };

  afterEach(restoreAll);

  const stubGlobalKey = (key: string, value: unknown): void => {
    const target = globalThis as unknown as Record<string, unknown>;
    const existed = key in target;
    const original = target[key];
    restores.push(() => {
      if (existed) target[key] = original;
      else delete target[key];
    });
    target[key] = value;
  };

  return {
    fetch(impl: typeof globalThis.fetch): void {
      stubGlobalKey('fetch', impl);
    },
    freezeNow(nowMs: number): void {
      const originalNow = Date.now;
      restores.push(() => {
        Date.now = originalNow;
      });
      Date.now = () => nowMs;
    },
    env(key: string, value: string | undefined): void {
      const existed = key in process.env;
      const original = process.env[key];
      restores.push(() => {
        if (existed && original !== undefined) process.env[key] = original;
        else delete process.env[key];
      });
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    },
    captureConsole(method: ConsoleMethod): unknown[][] {
      const original = console[method];
      const messages: unknown[][] = [];
      restores.push(() => {
        console[method] = original;
      });
      console[method] = ((...args: unknown[]): void => {
        messages.push(args);
      }) as typeof console[ConsoleMethod];
      return messages;
    },
    global: stubGlobalKey,
    restoreAll,
    get size(): number {
      return restores.length;
    },
  };
}
