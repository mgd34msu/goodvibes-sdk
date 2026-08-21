/**
 * imap-source.ts, the existing IMAP watcher, presented as an
 * `InboundMailSource` (docs/inbound-email.md §3.4d).
 *
 * This file is an ADAPTER and deliberately nothing else. IDLE, the poll
 * fallback, capability classification, the single credential retry, the
 * reconnect backoff, the cursor rules and the terminal-failure disclosure all
 * live in `watcher.ts` and the modules under it, already tested against a
 * scripted IMAP server. Re-expressing any of that here would be a second
 * implementation of the thing that is hard, and the second one is the one that
 * would be wrong, this round has already paid for that lesson twice, with a
 * hand-copied connection report and a hand-written cursor double.
 *
 * So everything below delegates. What is genuinely new is only the shape:
 *
 *   - `start()` has to ANSWER with a verdict, while the watcher REPORTS its
 *     verdicts to an observer as they change. The adapter therefore wraps the
 *     caller's observer, keeps the first transition, and hands it back. Every
 *     later transition still reaches the caller's observer untouched, which is
 *     the contract the watcher already has and the one the supervisor already
 *     consumes, `start()` returning a value does not make it a second channel
 *     for the same information.
 *
 *   - `run()` is the watcher's own loop, awaited. The watcher's `start()` is
 *     what enters that loop, so `start()` here really does begin work rather
 *     than merely probe. That is a property of the IMAP protocol and not a
 *     shortcut: capability on IMAP is discovered by connecting and asking, and
 *     an insufficient verdict already stops the loop, closes the socket and
 *     waits out `capabilityRecheckMs` inside the watcher. A caller that gets
 *     an `insufficient` verdict from `start()` and never calls `run()` must
 *     still call `stop()`, the interface says so, and it is what releases the
 *     re-check wait.
 *
 * Why `latency` is not the constant `{ kind: 'push' }`
 * ───────────────────────────────────────────────────
 * IMAP IDLE is true push, and for the default configuration that is exactly
 * what this reports. But `surfaces.email.inbound.mode` can be set to `poll`,
 * and a server that does not advertise IDLE is served by the poll fallback,
 * in both of those cases the connection is being ASKED on a timer, and the
 * worst case is the whole interval. `latency` exists so a surface can render a
 * number instead of the word "real-time" (see `source.ts`); reporting `push`
 * while polling every two minutes would put the exact sentence that field
 * exists to prevent in front of the owner. So it reports what is IN FORCE, the
 * same rule the Gmail source follows, and reads `pollIntervalMs`, the
 * interval the watcher was configured with, rather than inventing a number.
 */

import type {
  InboundCapabilityVerdict,
  InboundCapabilityTransition,
  InboundMailNote,
  InboundMailObserver,
  InboundMailTerminalFailure,
} from './ports.js';
import type { InboundMailSource, SourceLatency } from './source.js';
import {
  InboundMailboxWatcher,
  type InboundMailboxWatcherDeps,
  type InboundMailboxWatcherStatus,
} from './watcher.js';

/**
 * The IMAP watcher behind the source seam.
 *
 * Takes the watcher's own dependency record rather than a narrowed copy of it:
 * a restated dependency shape is a second declaration that can drift from the
 * one the watcher actually reads, and this file adds no requirement of its own.
 */
export class ImapMailSource implements InboundMailSource {
  readonly kind = 'imap' as const;

  private readonly watcher: InboundMailboxWatcher;
  private readonly pollIntervalMs: number;
  /** Set to `poll` when the owner configured polling rather than push. */
  private readonly configuredMode: 'idle' | 'poll' | 'auto';
  private readonly caller: InboundMailObserver | undefined;

  private firstVerdict: InboundCapabilityVerdict | null = null;
  private announceFirst: ((verdict: InboundCapabilityVerdict) => void) | null = null;
  private readonly firstVerdictReached: Promise<InboundCapabilityVerdict>;

  constructor(deps: InboundMailboxWatcherDeps) {
    this.caller = deps.observer;
    this.pollIntervalMs = deps.settings.pollIntervalMs;
    this.configuredMode = deps.settings.mode;
    this.firstVerdictReached = new Promise<InboundCapabilityVerdict>((resolve) => {
      this.announceFirst = resolve;
    });
    this.watcher = new InboundMailboxWatcher({ ...deps, observer: this.observer() });
  }

  /**
   * What the watcher is doing, unchanged.
   *
   * Exposed because the supervisor folds it into the standard channel status
   * snapshot, and because the source interface deliberately carries no status:
   * a `MailboxOpenReport`, a `UIDVALIDITY` and a body probe are IMAP facts and
   * have no Gmail counterpart, so they belong on the concrete source.
   */
  get status(): InboundMailboxWatcherStatus {
    return this.watcher.status;
  }

  /** Re-probe now rather than at the next scheduled check. Delegated verbatim. */
  recheckNow(): void {
    this.watcher.recheckNow();
  }

  /**
   * What the owner is told about delay, as it stands right now.
   *
   * `polling` here means the loop that is actually running, configured
   * polling, or the fallback after a server turned out to have no IDLE. Before
   * the first connection the watcher's mode is `inactive`, so the answer is
   * taken from the configuration instead: `poll` was chosen deliberately and is
   * true before the socket opens, while `auto` and `idle` are a request for
   * push that has not yet been answered.
   */
  get latency(): SourceLatency {
    const mode = this.watcher.status.mode;
    if (mode === 'polling' || (mode === 'inactive' && this.configuredMode === 'poll')) {
      return { kind: 'poll', worstCaseMs: this.pollIntervalMs };
    }
    return { kind: 'push' };
  }

  /**
   * Connect and answer with the first verdict the watcher reaches.
   *
   * The first verdict is not always the final one, a refused credential is
   * retried exactly once, so its first transition is `reconnecting` and the
   * `insufficient` verdict follows a moment later. That is the watcher's
   * behaviour and it is right; the later verdict reaches the caller through
   * the observer and through `terminalFailure`, which is where a supervisor
   * already listens for it.
   */
  async start(signal: AbortSignal): Promise<InboundCapabilityVerdict> {
    this.watcher.start();
    if (this.firstVerdict !== null) return this.firstVerdict;

    let abandon: (value: null) => void = () => undefined;
    const abandoned = new Promise<null>((resolve) => { abandon = resolve; });
    const onAbort = (): void => { abandon(null); };
    if (signal.aborted) abandon(null);
    else signal.addEventListener('abort', onAbort, { once: true });
    try {
      const reached = await Promise.race([this.firstVerdictReached, abandoned]);
      // Abandoned before the watcher reached any verdict at all: the status
      // verdict is the honest answer ("has not connected yet"), never a
      // fabricated healthy one.
      return reached ?? this.watcher.status.verdict;
    } finally {
      // A no-op when the listener was never added, which is why it is
      // unconditional: a conditional remove is one more state to get wrong.
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Run until aborted.
   *
   * The loop is the watcher's, entered by `start()`; this awaits it and stops
   * it when the signal fires. Calling `run()` without `start()` returns
   * immediately, because there is no loop to await, that is a caller error
   * rather than a state to invent.
   */
  async run(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      await this.stop();
      return;
    }
    const onAbort = (): void => { void this.stop(); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.watcher.whenSettled();
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Stop watching and release the socket. Safe to call twice. */
  async stop(): Promise<void> {
    await this.watcher.stop();
  }

  /**
   * The caller's observer with one addition: the first transition is kept so
   * `start()` can answer with it.
   *
   * Every method forwards. Nothing is filtered, nothing is re-ordered, and the
   * caller sees the first transition too, the adapter reads the stream, it
   * does not consume from it.
   */
  private observer(): InboundMailObserver {
    return {
      stateChanged: (transition: InboundCapabilityTransition): void => {
        if (this.firstVerdict === null) {
          this.firstVerdict = transition.to;
          this.announceFirst?.(transition.to);
          this.announceFirst = null;
        }
        this.caller?.stateChanged?.(transition);
      },
      terminalFailure: (failure: InboundMailTerminalFailure): void => {
        this.caller?.terminalFailure?.(failure);
      },
      note: (note: InboundMailNote): void => {
        this.caller?.note?.(note);
      },
    };
  }
}
