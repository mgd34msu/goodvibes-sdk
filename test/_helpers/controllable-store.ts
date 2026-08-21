/**
 * controllable-store.ts
 *
 * A real `PersistentStore` with a knob on the write, plus the temp-directory
 * plumbing that goes with it.
 *
 * This is the harness the approval-broker ordering defect was reproduced with,
 * lifted here verbatim so every store that shares that defect is pinned by the
 * same technique instead of a third one. The failure it reproduces happened on
 * a 2-vCPU CI runner, where one write was slow because two fsyncs were
 * contending; `delayNextMs` makes a write slow ON PURPOSE, so the same
 * interleaving happens deterministically on an idle machine rather than when a
 * loaded box happens to produce it.
 *
 * Everything below the knob is the real `PersistentStore`, so the atomic rename
 * being raced is the actual one and not a model of it.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentStore } from '../../packages/sdk/src/platform/state/persistent-store.js';

export class ControllableStore<T extends Record<string, unknown>> extends PersistentStore<T> {
  /** Applied to the next write only, before it reaches the disk. */
  delayNextMs = 0;
  /** The next write rejects instead of writing. Consumed by that write. */
  failNext = false;
  /**
   * Fail the Nth write of this store's life, counted from 1.
   *
   * Needed where the write that has to fail is not the next one: with a write
   * queue in place the writes are ordered, so "the third one" names a specific
   * write precisely, and a test can single out a write several deep in the
   * queue without racing to set a flag at the right instant.
   */
  failWriteNumber: number | null = null;
  /** Writes that have started, and writes that have finished either way. */
  started = 0;
  finished = 0;

  /**
   * The delay is applied AFTER the bytes are formed, not before.
   *
   * This matters for the callers that hand `persist` a LIVE object rather than
   * a copy, `DaemonBatchManager` passes `this.data`, `KVState` passes its own
   * map. `PersistentStore.persist` serialises what it is given a few
   * microtasks in, so for those callers the write's content is fixed early and
   * only its RENAME is late. That is also what the CI failure was: a slow
   * fsync, which is slow after the content exists. Sleeping before the capture
   * would model a write that is slow before it has looked at anything, and a
   * test built on that would let a stale write pick up state written while it
   * was asleep, which is to say it would pass with the defect still in place.
   */
  override async persist(data: T): Promise<void> {
    this.started += 1;
    const fail = this.failNext || this.failWriteNumber === this.started;
    this.failNext = false;
    const delay = this.delayNextMs;
    this.delayNextMs = 0;
    // Exactly the projection `persist` itself would write, taken now.
    const captured = JSON.parse(JSON.stringify(data)) as T;
    try {
      if (delay > 0) await new Promise<void>((resolve) => { setTimeout(resolve, delay); });
      if (fail) throw new Error('store unavailable');
      await super.persist(captured);
    } finally {
      this.finished += 1;
    }
  }
}

export interface ControllableStoreFixture<T extends Record<string, unknown>> {
  readonly store: ControllableStore<T>;
  readonly path: string;
  readonly dir: string;
  readonly cleanup: () => void;
}

/** A ControllableStore over a fresh temp directory, plus its cleanup. */
export function makeControllableStore<T extends Record<string, unknown>>(
  prefix: string,
  fileName = 'store.json',
): ControllableStoreFixture<T> {
  const dir = mkdtempSync(join(tmpdir(), `gv-${prefix}-`));
  const path = join(dir, fileName);
  return {
    store: new ControllableStore<T>(path),
    path,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Point an object's internal store field at a ControllableStore.
 *
 * Most of these classes build their `PersistentStore` from a path in their own
 * constructor and take no store argument. Widening every one of their public
 * constructors purely so a test can slow a write down would put a testing seam
 * in the shipped API surface of nine classes; swapping the field is confined to
 * the test. `private` is a compile-time notion in TypeScript, so the assignment
 * is an ordinary property write at run time.
 *
 * `field` is named explicitly rather than guessed, so a rename shows up here as
 * a failing test rather than as a test that quietly stops exercising anything.
 */
export function replaceInternalStore(owner: object, field: string, store: unknown): void {
  const target = owner as Record<string, unknown>;
  if (!(field in target)) {
    throw new Error(`replaceInternalStore: '${field}' is not a field of ${owner.constructor.name}`);
  }
  target[field] = store;
}

/**
 * What is ACTUALLY on disk right now, or null when the file is absent or
 * unreadable.
 *
 * Reading the file rather than asking the object under test is the whole point:
 * these tests are about the bytes that survive a restart, and every one of the
 * defects being pinned leaves the in-memory state correct.
 */
export function readOnDisk<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}
