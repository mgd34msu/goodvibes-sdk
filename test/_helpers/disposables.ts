/**
 * Automatic teardown for anything a test starts.
 *
 * The whole suite runs in ONE `bun test` process. A test that constructs a
 * scheduler, manager, listener or watcher and never disposes it leaves that
 * object's `setInterval` / `setTimeout` chain running for the remainder of the
 * run, inside every later test file. That is how `provider-stream-retry.test.ts`
 * came to count 4962 `fetch` calls where it expected 2: pollers left behind by
 * unrelated, already-finished tests were still firing.
 *
 * Usage, call `trackDisposables()` ONCE at the top level of a test file:
 *
 *   const disposables = trackDisposables();
 *
 *   test('...', () => {
 *     const scheduler = disposables.add(new KnowledgeScheduler(config));
 *     // ...no teardown to write; it is disposed after this test.
 *   });
 *
 * `add()` returns its argument, so it wraps a constructor call in place.
 *
 * IMPORTANT, why this is a function you must call, and not an import side
 * effect: `bun test` caches modules across test files, so a helper that
 * registered `afterEach` at import time would bind that hook ONLY to the first
 * file that imported it. Every later file would import the cached module,
 * register nothing, and silently get no cleanup. Calling `trackDisposables()`
 * during each file's own evaluation registers the hook in that file's scope,
 * which is the only reliable way to do this under a shared module cache.
 */
import { afterAll, afterEach } from 'bun:test';

type MaybePromise<T> = T | Promise<T>;
type Disposer = () => MaybePromise<void>;

export interface DisposableRegistry {
  /**
   * Register a value for automatic disposal and return it unchanged.
   *
   * With no explicit disposer, the first method the value actually has out of
   * `dispose`, `stop`, `close`, `destroy`, `shutdown` is used. A value with
   * none of those and no explicit disposer is rejected loudly rather than
   * silently leaking.
   */
  add<T>(value: T, disposer?: (value: T) => MaybePromise<void>): T;
  /** Register a bare cleanup callback (unsubscribe functions, temp dirs). */
  defer(fn: Disposer): void;
  /** Dispose everything registered so far. Runs automatically; idempotent. */
  flush(): Promise<void>;
  /** Outstanding registrations, used by this helper's own guard test. */
  readonly size: number;
}

/** Checked in order; the first one the value actually has wins. */
const DISPOSE_METHODS = ['dispose', 'stop', 'close', 'destroy', 'shutdown'] as const;

function hasMethod(value: object, name: string): boolean {
  return typeof (value as Record<string, unknown>)[name] === 'function';
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name ?? 'object';
}

function autoDisposer(value: unknown): Disposer {
  if (typeof value === 'function') {
    // A bare unsubscribe/cleanup function returned by a subscribe() call.
    return value as Disposer;
  }
  if (value !== null && typeof value === 'object') {
    for (const method of DISPOSE_METHODS) {
      if (hasMethod(value, method)) {
        return () => (value as Record<string, () => MaybePromise<void>>)[method]!();
      }
    }
    const symbolDispose = (Symbol as { dispose?: symbol }).dispose;
    if (symbolDispose && hasMethod(value, symbolDispose as unknown as string)) {
      return () => (value as unknown as Record<symbol, () => void>)[symbolDispose]!();
    }
  }
  throw new Error(
    `trackDisposables().add() received a ${describeValue(value)} with no ` +
      `dispose/stop/close/destroy/shutdown method. Pass an explicit disposer: ` +
      `add(value, (v) => v.yourTeardown()).`,
  );
}

export interface TrackOptions {
  /**
   * `'each'` (default) disposes after every test, right for anything built
   * inside a test body. `'all'` disposes once at the end of the file, right
   * for something built in `beforeAll` and shared by the file's tests.
   */
  readonly scope?: 'each' | 'all';
}

export function trackDisposables(options: TrackOptions = {}): DisposableRegistry {
  const entries: Array<{ readonly label: string; readonly dispose: Disposer }> = [];

  const flush = async (): Promise<void> => {
    const failures: string[] = [];
    // Reverse order: later registrations usually depend on earlier ones.
    while (entries.length > 0) {
      const entry = entries.pop();
      if (!entry) break;
      try {
        await entry.dispose();
      } catch (error) {
        failures.push(`${entry.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      // Surfaced, never swallowed, a teardown that throws is a real defect,
      // and hiding it is how a leak survives a green suite.
      throw new Error(`disposal failed for ${failures.length} item(s):\n  ${failures.join('\n  ')}`);
    }
  };

  if (options.scope === 'all') {
    afterAll(flush);
  } else {
    afterEach(flush);
  }

  return {
    add<T>(value: T, disposer?: (value: T) => MaybePromise<void>): T {
      const dispose: Disposer = disposer ? () => disposer(value) : autoDisposer(value);
      entries.push({ label: describeValue(value), dispose });
      return value;
    },
    defer(fn: Disposer): void {
      entries.push({ label: 'deferred cleanup', dispose: fn });
    },
    flush,
    get size(): number {
      return entries.length;
    },
  };
}
