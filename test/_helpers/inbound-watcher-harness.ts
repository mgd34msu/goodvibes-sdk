/**
 * The injected halves of the inbound watcher, as things a test can drive.
 *
 * Everything the watcher would otherwise reach for — the clock, the random
 * source behind backoff jitter, the cursor store, the sink mail is handed to,
 * the observer its status goes to — arrives as a port, and these are the test
 * implementations. Nothing here sleeps for real: the 27-minute IDLE re-issue
 * and the 5-minute backoff ceiling are asserted by moving a number.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailboxCursorStore } from '../../packages/sdk/src/platform/email/inbound/cursor-store.ts';
import type { CursorResolution } from '../../packages/sdk/src/platform/email/inbound/cursor-store.ts';
import type { MailboxCursor } from '../../packages/sdk/src/platform/email/inbound/types.ts';
import type {
  InboundCapabilityTransition,
  InboundMailNote,
  InboundMailObserver,
  InboundMailSink,
  InboundMailTerminalFailure,
  InboundMailboxMessage,
  MailboxCursorPort,
  WatcherClock,
} from '../../packages/sdk/src/platform/email/inbound/ports.ts';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

interface Sleeper {
  readonly at: number;
  readonly wake: () => void;
}

/** Let pending microtasks and I/O callbacks run. */
export async function flush(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  }
}

/**
 * Wait, in real milliseconds, until `predicate` holds.
 *
 * Real time is unavoidable here because the fake IMAP server is a real
 * loopback socket, so "the watcher has received the response" is genuinely
 * asynchronous. The waits are milliseconds, not minutes: everything with a
 * long duration in it runs on the fake clock instead.
 */
export async function waitFor(
  predicate: () => boolean,
  what: string,
  // Below bun's own per-test timeout on purpose: when a wait never completes,
  // the useful failure names the condition that never held, and the harness
  // has to lose that race to the runner for the name to be printed.
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 2); });
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${what}`);
}

export class FakeClock implements WatcherClock {
  private time = 1_753_000_000_000;
  private readonly sleepers = new Set<Sleeper>();

  now(): number {
    return this.time;
  }

  /** How many waits are currently outstanding. */
  get pending(): number {
    return this.sleepers.size;
  }

  /** The shortest outstanding wait, in milliseconds from now. */
  get nextDueIn(): number {
    let soonest = Number.POSITIVE_INFINITY;
    for (const sleeper of this.sleepers) soonest = Math.min(soonest, sleeper.at - this.time);
    return soonest;
  }

  sleep(ms: number, signal?: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted === true || ms <= 0) {
        resolve();
        return;
      }
      let done = false;
      const settle = (): void => {
        if (done) return;
        done = true;
        this.sleepers.delete(sleeper);
        signal?.removeEventListener('abort', settle);
        resolve();
      };
      const sleeper: Sleeper = { at: this.time + ms, wake: settle };
      this.sleepers.add(sleeper);
      signal?.addEventListener('abort', settle, { once: true });
    });
  }

  /** Move time forward and wake everything that came due, oldest first. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      let due: Sleeper | null = null;
      for (const sleeper of this.sleepers) {
        if (sleeper.at > target) continue;
        if (due === null || sleeper.at < due.at) due = sleeper;
      }
      if (due === null) break;
      this.time = Math.max(this.time, due.at);
      due.wake();
      await flush(2);
    }
    this.time = Math.max(this.time, target);
    await flush(2);
  }

  /** Wait, in real time, until at least `count` waits are outstanding. */
  async waitForSleepers(count = 1, what = 'a scheduled wait'): Promise<void> {
    await waitFor(() => this.sleepers.size >= count, what);
  }

  /**
   * Wait until a wait shorter than `maxMs` is outstanding.
   *
   * Distinguishing a short wait from a long one matters: the IDLE re-issue
   * timer is armed for twenty-seven minutes and is almost always pending, so
   * "some wait exists" is true before the backoff a test is actually waiting
   * for has been armed — and advancing past a wait that has not been created
   * yet leaves the test hanging on a timer that will never come due.
   */
  async waitForDue(maxMs: number, what = 'a short scheduled wait'): Promise<void> {
    await waitFor(() => this.sleepers.size > 0 && this.nextDueIn <= maxMs, what);
  }
}

// ---------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------

/**
 * An in-memory `MailboxCursorPort` implementing the §4 rules the real store
 * will implement against disk: a first run establishes the mark without
 * backfilling, and a changed `UIDVALIDITY` discards rather than replays.
 */
/**
 * The REAL `MailboxCursorStore`, with an audit trail wrapped round it.
 *
 * This used to be a hand-written in-memory cursor store, and that was a third
 * implementation of the same rules — after the persisted store landed in its
 * own lane there were two production declarations of `MailboxCursor` and two
 * computations of "where does the cursor go next", and they had already
 * disagreed: the store clamps with `Math.max(existing, incoming)` so a cursor
 * never moves backwards, and the fake assigned unconditionally. A test double
 * that reimplements the thing under test can pass while the real store fails.
 *
 * So this DELEGATES. Every method forwards to a real store on a temp file;
 * only the ordering audit is added. The tests therefore exercise the actual
 * persistence, including resume-above-the-stored-cursor across a restart.
 */
export class RecordingCursorStore implements MailboxCursorPort {
  private readonly inner: MailboxCursorStore;
  /** Every `advance`, in call order — the audit for "only after work". */
  readonly advances: number[] = [];
  /**
   * Every `resolve`, in call order — the audit for WHERE a cursor was
   * established, as distinct from where it later ended up.
   *
   * The two are easy to confuse, and the difference is the whole of the
   * backfill defect: a watcher that establishes at UID 0 and then replays the
   * mailbox ends with the same stored `lastSeenUid` as one that established at
   * the top and delivered nothing. The end state cannot tell them apart. The
   * argument passed in here can.
   */
  readonly resolves: Array<{
    readonly currentHighestUid: number;
    readonly currentMessageCount: number;
  }> = [];

  constructor(inner: MailboxCursorStore) {
    this.inner = inner;
  }

  async get(account: string, mailbox: string): Promise<MailboxCursor | null> {
    return this.inner.get(account, mailbox);
  }

  async resolve(input: {
    readonly account: string;
    readonly mailbox: string;
    readonly serverUidValidity: number;
    readonly currentHighestUid: number;
    readonly currentMessageCount: number;
  }): Promise<CursorResolution> {
    this.resolves.push({
      currentHighestUid: input.currentHighestUid,
      currentMessageCount: input.currentMessageCount,
    });
    return this.inner.resolve(input);
  }

  async advance(input: {
    readonly account: string;
    readonly mailbox: string;
    readonly uidValidity: number;
    readonly lastSeenUid: number;
  }): Promise<MailboxCursor> {
    const cursor = await this.inner.advance(input);
    this.advances.push(input.lastSeenUid);
    return cursor;
  }
}

/**
 * Build a real cursor store on a throwaway file, optionally pre-seeded as a
 * previous run would have left it.
 *
 * Seeding goes through `resolve` + `advance` rather than writing the file by
 * hand, so a seeded test starts from a state the store itself can produce.
 */
/**
 * ONE scratch directory for this whole test process, cleared by the suites
 * that use it.
 *
 * `makeCursorStore` used to `mkdtemp` per call and hand the path back for the
 * caller to delete. Every caller forgot, and one night's runs left 53
 * `goodvibes-inbound-cursor-*` directories behind — a share of the leak that
 * exhausted this host's tmpfs inodes (1,046,761 of 1,048,576 used while disk
 * sat at 24%, so `df -h` looked healthy and every write failed anyway).
 *
 * One directory per PROCESS rather than per store, so a suite building thirty
 * stores costs one inode instead of thirty.
 *
 * TWO cleanup mechanisms were tried here before this one, and BOTH silently
 * did nothing — which is worth recording, because each looked obviously
 * correct:
 *
 *   - an `afterEach` registered at this module's top level does not apply to
 *     the suite that imports it;
 *   - `process.on('exit')` is never fired by bun's test runner at all
 *     (verified with a probe: the handler does not run).
 *
 * So cleanup is `cleanupInboundScratch`, called from an `afterAll` in each
 * suite that uses this helper — the one place cleanup demonstrably runs. A
 * source-level test would be the way to stop a future suite forgetting; for
 * two files, the call plus this note is proportionate.
 */
let scratchRoot: string | null = null;
let scratchCounter = 0;

function scratchFile(name: string): string {
  if (scratchRoot === null) {
    scratchRoot = mkdtempSync(join(tmpdir(), 'goodvibes-inbound-cursor-'));
  }
  scratchCounter += 1;
  return join(scratchRoot, `${String(scratchCounter)}-${name}`);
}

/** Remove this process's scratch directory. Safe to call more than once. */
export function cleanupInboundScratch(): void {
  if (scratchRoot === null) return;
  rmSync(scratchRoot, { recursive: true, force: true });
  scratchRoot = null;
}

export async function makeCursorStore(seed?: {
  readonly account: string;
  readonly mailbox: string;
  readonly uidValidity: number;
  readonly lastSeenUid: number;
}): Promise<{ store: RecordingCursorStore; dir: string }> {
  const path = scratchFile('cursors.json');
  const inner = new MailboxCursorStore(path);
  if (seed !== undefined) {
    await inner.resolve({
      account: seed.account,
      mailbox: seed.mailbox,
      serverUidValidity: seed.uidValidity,
      currentHighestUid: seed.lastSeenUid,
      currentMessageCount: 0,
    });
  }
  return { store: new RecordingCursorStore(inner), dir: path };
}


// ---------------------------------------------------------------------------
// The sink and the observer
// ---------------------------------------------------------------------------

export class RecordingSink implements InboundMailSink {
  readonly delivered: InboundMailboxMessage[] = [];
  /** UIDs to refuse ONCE, then accept — the crash-mid-processing simulation. */
  readonly refuseOnce = new Set<number>();
  /** Every UID handed over, including the refused attempts. */
  readonly attempts: number[] = [];

  async deliver(message: InboundMailboxMessage): Promise<void> {
    this.attempts.push(message.uid);
    if (this.refuseOnce.has(message.uid)) {
      this.refuseOnce.delete(message.uid);
      throw new Error(`the sink refused UID ${message.uid}`);
    }
    this.delivered.push(message);
  }

  get subjects(): string[] {
    return this.delivered.map((message) => message.envelope.subject);
  }

  get uids(): number[] {
    return this.delivered.map((message) => message.uid);
  }
}

export class RecordingObserver implements InboundMailObserver {
  readonly transitions: InboundCapabilityTransition[] = [];
  readonly terminals: InboundMailTerminalFailure[] = [];
  readonly notes: InboundMailNote[] = [];

  stateChanged(transition: InboundCapabilityTransition): void {
    this.transitions.push(transition);
  }

  terminalFailure(failure: InboundMailTerminalFailure): void {
    this.terminals.push(failure);
  }

  note(note: InboundMailNote): void {
    this.notes.push(note);
  }

  /** Transitions into `insufficient`, which is what gets announced to the owner. */
  get insufficientAnnouncements(): InboundCapabilityTransition[] {
    return this.transitions.filter((entry) => entry.to.state === 'insufficient');
  }

  get states(): string[] {
    return this.transitions.map((entry) => `${entry.to.state}:${entry.to.reason}`);
  }
}

/** A random source that hands back the same draw every time. */
export function fixedRandom(value: number): () => number {
  return () => value;
}

/** A random source that walks a list, repeating the last value. */
export function scriptedRandom(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)] ?? 0;
    index += 1;
    return value;
  };
}
