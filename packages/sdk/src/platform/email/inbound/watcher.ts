/**
 * One mailbox, watched: the connection lifecycle the IDLE and poll loops sit
 * inside.
 *
 * `idle-watcher.ts` knows how to hold an IDLE and `poll-loop.ts` knows how to
 * find what arrived. Neither knows what to do when the socket dies, when the
 * credential is refused, or when the server turns out not to support push —
 * and those are the cases that decide whether this capability is worth having,
 * because they are the ones that end with the owner hearing nothing.
 *
 * What this file guarantees
 * ─────────────────────────
 * **No message is lost across a reconnect.** Recovery is not "resume the
 * stream"; it is "ask what is above the persisted cursor". Whatever arrived
 * while the socket was down is above the cursor, so the first thing a fresh
 * connection does — before IDLE, before polling — is drain the delta. The
 * cursor advances only behind completed work, so a crash mid-message
 * re-delivers rather than skips, and dedup absorbs the duplicate.
 *
 * **"Cannot" and "not yet" stay different.** A watcher waiting out a backoff
 * is `degraded`, never `insufficient`. Nothing is lost by waiting; the delta
 * is still above the cursor. `insufficient` is reserved for a verdict about
 * capability — a refused credential, an unopenable mailbox, a server that will
 * not hand over message data — and in that state the watcher does not run,
 * says so once, and re-probes on a timer so that fixing the cause does not
 * need a restart.
 *
 * **A terminal failure is surfaced, not filed.** A rejected credential ends
 * with `terminalFailure` on the observer carrying the exact remedial step, so
 * the supervisor can route it somewhere authoritative. Silent permanent death
 * is the failure this whole round exists to eliminate; recording it in a
 * status object nobody opens is the same failure with a paper trail.
 *
 * **A connection limit is not an outage.** Gmail permits fifteen concurrent
 * IMAP connections and `EmailService` opens a fresh one per request on top of
 * the one held here, so hitting it is an expected Tuesday. It backs off on a
 * longer ceiling and reports `degraded` in the provider's own words, because
 * asking again sooner cannot clear a limit that our own asking is part of.
 */

import {
  BackoffSchedule,
  DEFAULT_BACKOFF_POLICY,
  type BackoffPolicy,
} from './backoff.js';
import {
  CapabilityStateTracker,
  capabilityVerdict,
  classifyOpenFailure,
  classifyReadFailure,
  errorText,
  resolveIdleSupport,
  verdictForOpenConnection,
} from './capability.js';
import { runIdleLoop, type IdleWakeSummary } from './idle-watcher.js';
import { drainMailboxDelta, runPollLoop, type MailboxDeltaReport } from './poll-loop.js';
import type { EmailCapabilityFailureNotice, ImapBodyProbeVerdict } from '../imap-client.js';
import type {
  InboundCapabilityReason,
  InboundCapabilityVerdict,
  InboundMailObserver,
  InboundMailSink,
  InboundMailTerminalFailure,
  InboundWatcherSettings,
  MailboxConnection,
  MailboxConnectionPort,
  MailboxCursor,
  MailboxCursorPort,
  RandomSource,
  WatcherClock,
} from './ports.js';

export interface InboundMailboxWatcherDeps {
  readonly settings: InboundWatcherSettings;
  readonly connections: MailboxConnectionPort;
  readonly cursors: MailboxCursorPort;
  readonly sink: InboundMailSink;
  readonly clock: WatcherClock;
  readonly random: RandomSource;
  readonly observer?: InboundMailObserver | undefined;
  readonly backoffPolicy?: BackoffPolicy | undefined;
}

/** What the supervisor folds into the standard channel status snapshot. */
export interface InboundMailboxWatcherStatus {
  readonly account: string;
  readonly mailbox: string;
  readonly running: boolean;
  readonly mode: 'idle' | 'polling' | 'inactive';
  readonly verdict: InboundCapabilityVerdict;
  readonly cursor: MailboxCursor | null;
  /** Non-null once the watcher has stopped for a reason only a change fixes. */
  readonly terminalFailure: InboundMailTerminalFailure | null;
  /** Consecutive failed connection attempts. 0 while connected. */
  readonly reconnectAttempts: number;
  /** Completed connections, for telling "flapping" from "up". */
  readonly connections: number;
  /**
   * What the last connection's connect-time body probe found, or `null`
   * before any connection has opened.
   *
   * Kept distinct from `verdict` on purpose: `{ probed: false }` (an empty
   * mailbox at connect time) is not a capability problem and does not change
   * `verdict` at all, but it is a different fact from `{ probed: true, ok:
   * true }` and has to stay visible as one — reading either as "fine, same as
   * the other" is the exact silent-degradation mistake `ImapBodyProbeVerdict`
   * exists to make impossible to write by accident.
   */
  readonly bodyProbe: ImapBodyProbeVerdict | null;
}

/**
 * Combine several abort signals into one.
 *
 * The clock takes a single signal and several things can end a wait — a
 * shutdown, a re-probe request, an inner race. Composed here rather than
 * threaded through every sleep, and disposed so a long-lived signal does not
 * accumulate listeners from every wait that ever used it.
 */
function anySignal(signals: readonly AbortSignal[]): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const relay = (): void => { controller.abort(); };
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', relay, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of signals) signal.removeEventListener('abort', relay);
    },
  };
}

export class InboundMailboxWatcher {
  private readonly deps: InboundMailboxWatcherDeps;
  private readonly settings: InboundWatcherSettings;
  private readonly tracker: CapabilityStateTracker;
  /** Escalates on failed connections; reset when a connection works. */
  private readonly connectBackoff: BackoffSchedule;
  /** Escalates on refused deliveries; reset when a drain completes. */
  private readonly deliveryBackoff: BackoffSchedule;

  private shutdown = new AbortController();
  private runner: Promise<void> | null = null;
  private recheckWake: AbortController | null = null;
  private cursor: MailboxCursor | null = null;
  private mode: 'idle' | 'polling' | 'inactive' = 'inactive';
  private terminal: InboundMailTerminalFailure | null = null;
  private authRetried = false;
  private connectionCount = 0;
  private lastBodyProbe: ImapBodyProbeVerdict | null = null;
  /** Set when a verdict only a change can clear was reported this pass. */
  private pendingRecheck = false;

  constructor(deps: InboundMailboxWatcherDeps) {
    this.deps = deps;
    this.settings = deps.settings;
    this.tracker = new CapabilityStateTracker({
      account: deps.settings.account,
      mailbox: deps.settings.mailbox,
      clock: deps.clock,
      observer: deps.observer,
    });
    const policy = deps.backoffPolicy ?? {
      ...DEFAULT_BACKOFF_POLICY,
      ceilingMs: deps.settings.maxBackoffMs,
    };
    this.connectBackoff = new BackoffSchedule(policy, deps.random);
    this.deliveryBackoff = new BackoffSchedule(policy, deps.random);
  }

  get status(): InboundMailboxWatcherStatus {
    return {
      account: this.settings.account,
      mailbox: this.settings.mailbox,
      running: this.runner !== null && !this.shutdown.signal.aborted,
      mode: this.mode,
      verdict: this.tracker.current
        ?? capabilityVerdict('reconnecting', 'The watcher has not connected yet.'),
      cursor: this.cursor,
      terminalFailure: this.terminal,
      reconnectAttempts: this.connectBackoff.attempts,
      connections: this.connectionCount,
      bodyProbe: this.lastBodyProbe,
    };
  }

  /** Begin watching. Idempotent; a second call while running does nothing. */
  start(): void {
    if (this.runner !== null) return;
    if (this.shutdown.signal.aborted) this.shutdown = new AbortController();
    this.runner = this.run();
  }

  /** Stop watching and wait for the loop to unwind. Safe to call twice. */
  async stop(): Promise<void> {
    this.shutdown.abort();
    this.recheckWake?.abort();
    const runner = this.runner;
    this.runner = null;
    if (runner !== null) await runner;
    this.mode = 'inactive';
  }

  /**
   * Re-probe now instead of at the next scheduled check.
   *
   * Called when configuration changed. An owner who has just fixed a password
   * should not wait out an hour-long timer to find out whether it worked, and
   * a restart to pick up a setting is a restart the daemon should not need.
   */
  recheckNow(): void {
    this.recheckWake?.abort();
  }

  /** Await the run loop. Test seam; production uses `start()` / `stop()`. */
  async whenSettled(): Promise<void> {
    if (this.runner !== null) await this.runner;
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  private async run(): Promise<void> {
    while (!this.shutdown.signal.aborted) {
      let connection: MailboxConnection;
      try {
        connection = await this.deps.connections.open();
      } catch (error) {
        await this.handleOpenFailure(error);
        await this.settleTerminal();
        continue;
      }
      this.connectionCount += 1;
      try {
        await this.serve(connection);
      } finally {
        this.mode = 'inactive';
        await connection.close().catch(() => undefined);
      }
      // After the socket is released, never while holding it — see
      // `settleTerminal`.
      await this.settleTerminal();
    }
  }

  /**
   * Wait out the capability re-check, when the last attempt ended in a verdict
   * only a change can clear.
   *
   * Deliberately outside the `finally` that closes the connection, and this
   * placement is the whole point of the method. An `insufficient` watcher does
   * not run — and one that sat on an open IMAP connection for an hour while
   * refusing to read from it would still be holding one of the provider's
   * simultaneous-connection slots. Gmail allows fifteen and `EmailService`
   * takes a fresh one per request, so spending one on a mailbox we have
   * already decided we cannot read is the same limit pressure with none of
   * the benefit, and it would make our own `server-unavailable` verdict more
   * likely on every other mailbox.
   */
  private async settleTerminal(): Promise<void> {
    if (!this.pendingRecheck) return;
    this.pendingRecheck = false;
    await this.waitForRecheck();
  }

  /**
   * One connection's working life: reconcile the cursor, decide push or poll,
   * drain what arrived while we were away, then hold the chosen loop.
   */
  private async serve(connection: MailboxConnection): Promise<void> {
    const status = connection.report.mailbox;
    if (status.uidValidity === null) {
      this.reportTerminal(capabilityVerdict(
        'uidvalidity-missing',
        `The server opened '${this.settings.mailbox}' without reporting a UIDVALIDITY.`,
      ), null);
      return;
    }

    // The connect-time body probe (§3.4d "Scope sufficiency applies to
    // both"): on a non-empty mailbox, `connection.report.bodyProbe` already
    // answers "will this server hand over a body" before anything below this
    // point has run — before the cursor is resolved and before any
    // expectation could be opened. A refusal here is the SAME finding the
    // reactive path (`handleDrainFailure`) would reach on the first real
    // fetch, just reached sooner, so it is classified through the identical
    // `classifyReadFailure` and can turn out non-terminal (a `[LIMIT]`-style
    // refusal is a server condition, not a body-access verdict) as well as
    // terminal. `{ probed: false }` — an empty mailbox, or nothing to
    // conclude from — changes nothing here: the watcher runs and the
    // reactive path remains the answer for this mailbox.
    this.lastBodyProbe = connection.report.bodyProbe;
    const bodyProbe = connection.report.bodyProbe;
    if (bodyProbe.probed && !bodyProbe.ok) {
      const { verdict, terminal, notice } = classifyReadFailure(
        new Error(bodyProbe.detail),
        'fetch',
      );
      if (terminal) {
        this.reportTerminal(verdict, notice);
        return;
      }
      this.tracker.record(verdict);
      await this.pauseBeforeReconnect(verdict.reason);
      return;
    }

    const resolution = await this.deps.cursors.resolve({
      account: this.settings.account,
      mailbox: this.settings.mailbox,
      uidValidity: status.uidValidity,
      uidNext: status.uidNext,
      exists: status.exists,
    });
    this.cursor = resolution.cursor;
    if (resolution.origin === 'established') {
      this.note('cursor-established',
        `Listening from UID ${resolution.cursor.lastSeenUid} onwards; `
        + `${resolution.skippedMessages} message(s) already in the mailbox were `
        + 'not read. The daemon starts listening now rather than backfilling.');
    } else if (resolution.origin !== 'stored') {
      this.note('cursor-reset',
        `The stored position was discarded (${resolution.origin}) and re-established `
        + `at UID ${resolution.cursor.lastSeenUid}. Mail already in the mailbox is `
        + 'not replayed.');
    }

    // The email layer owns this decision and resolves "the server said
    // nothing" by asking. Reading `connection.report.idle` here instead would
    // be a second answer to the same question.
    const idle = await resolveIdleSupport(connection.reader);
    const useIdle = this.settings.mode !== 'poll' && idle.supported;
    this.tracker.record(verdictForOpenConnection({ mode: this.settings.mode, idle }));
    this.connectBackoff.reset();
    this.authRetried = false;
    this.mode = useIdle ? 'idle' : 'polling';

    // Everything that arrived while we were disconnected is above the cursor.
    // This runs before either loop, which is the whole of "a reconnect never
    // loses messages".
    const recovery = await this.drain(connection, useIdle ? 'idle' : 'poll');
    if (recovery !== 'continue') return;

    if (!useIdle) {
      await this.holdPollLoop(connection);
      return;
    }
    await this.holdIdleLoop(connection);
  }

  private async holdIdleLoop(connection: MailboxConnection): Promise<void> {
    let halted: MailboxDeltaReport | null = null;
    const result = await runIdleLoop({
      wire: connection.wire,
      clock: this.deps.clock,
      settings: this.settings,
      signal: this.shutdown.signal,
      observer: this.deps.observer,
      onWake: async (_wake: IdleWakeSummary): Promise<'continue' | 'halt'> => {
        const report = await this.drainOnce(connection, 'idle');
        if (report.outcome === 'complete' || report.outcome === 'aborted') return 'continue';
        halted = report;
        return 'halt';
      },
    });

    if (halted !== null) {
      await this.handleDrainFailure(halted);
      return;
    }
    if (result.outcome === 'idle-refused') {
      // The server advertised IDLE and then refused it. Reconnecting would
      // find the same refusal, so this falls back on the SAME connection.
      this.tracker.record(capabilityVerdict('polling-idle-refused', errorText(result.error)));
      this.mode = 'polling';
      await this.holdPollLoop(connection);
      return;
    }
    if (result.outcome === 'stopped') return;
    // 'connection-lost' and 'reissue-stalled' both mean: this socket is done.
    // A stalled re-issue is the liveness probe failing, which is the only way
    // a silently-dead connection is ever distinguishable from a quiet one.
    this.tracker.record(capabilityVerdict('reconnecting',
      result.outcome === 'reissue-stalled'
        ? 'The IDLE re-issue did not complete within the operation timeout, so '
          + 'the connection is treated as dead and rebuilt.'
        : errorText(result.error)));
    await this.pauseBeforeReconnect('reconnecting');
  }

  private async holdPollLoop(connection: MailboxConnection): Promise<void> {
    const result = await runPollLoop({
      settings: this.settings,
      reader: connection.reader,
      wire: connection.wire,
      cursors: this.deps.cursors,
      sink: this.deps.sink,
      clock: this.deps.clock,
      observer: this.deps.observer,
      cursor: this.requireCursor(),
      via: 'poll',
      signal: this.shutdown.signal,
    });
    this.cursor = result.cursor;
    if (result.outcome === 'stopped') return;
    await this.handleDrainFailure({
      outcome: result.outcome === 'read-failed' ? 'read-failed' : 'delivery-failed',
      found: 0,
      delivered: 0,
      vanished: 0,
      cursor: result.cursor,
      error: result.error,
      phase: result.phase,
    });
  }

  // -------------------------------------------------------------------------
  // Draining
  // -------------------------------------------------------------------------

  private async drainOnce(
    connection: MailboxConnection,
    via: 'idle' | 'poll',
  ): Promise<MailboxDeltaReport> {
    const report = await drainMailboxDelta({
      settings: this.settings,
      reader: connection.reader,
      wire: connection.wire,
      cursors: this.deps.cursors,
      sink: this.deps.sink,
      clock: this.deps.clock,
      observer: this.deps.observer,
      cursor: this.requireCursor(),
      via,
      signal: this.shutdown.signal,
    });
    this.cursor = report.cursor;
    if (report.outcome === 'complete') this.deliveryBackoff.reset();
    return report;
  }

  private async drain(
    connection: MailboxConnection,
    via: 'idle' | 'poll',
  ): Promise<'continue' | 'stop'> {
    const report = await this.drainOnce(connection, via);
    if (report.outcome === 'complete') return 'continue';
    if (report.outcome === 'aborted') return 'stop';
    await this.handleDrainFailure(report);
    return 'stop';
  }

  /**
   * A drain that did not complete.
   *
   * A refused FETCH means the mailbox opens and its contents are withheld —
   * arrival can be observed and never read, which is a capability verdict and
   * not something reconnecting fixes. A dead socket is a reconnect. A sink
   * that refused a message is neither: the message is still above the cursor
   * and will be handed over again, so this pauses on its own escalation rather
   * than re-labelling the connection.
   */
  private async handleDrainFailure(report: MailboxDeltaReport): Promise<void> {
    if (report.outcome === 'delivery-failed') {
      await this.sleep(this.deliveryBackoff.next());
      return;
    }
    const { verdict, terminal, notice } = classifyReadFailure(
      report.error,
      report.phase ?? 'fetch',
    );
    if (terminal) {
      this.reportTerminal(verdict, notice);
      return;
    }
    this.tracker.record(verdict);
    await this.pauseBeforeReconnect(verdict.reason);
  }

  // -------------------------------------------------------------------------
  // Failure handling
  // -------------------------------------------------------------------------

  private async handleOpenFailure(error: unknown): Promise<void> {
    const { verdict, terminal, notice } = classifyOpenFailure(error);

    // A rejected credential is retried EXACTLY ONCE, to absorb an OAuth token
    // that expired between connections and can be refreshed on the next open.
    // The second rejection is believed: retrying a bad password on a backoff
    // loop is how an account gets locked.
    if (terminal && verdict.reason === 'credentials-rejected' && !this.authRetried) {
      this.authRetried = true;
      this.tracker.record(capabilityVerdict('reconnecting',
        'The credential was refused once. Retrying a single time in case a '
        + 'token expired mid-connection and can be refreshed.'));
      await this.pauseBeforeReconnect('reconnecting');
      return;
    }
    if (terminal) {
      this.reportTerminal(verdict, notice);
      return;
    }
    this.tracker.record(verdict);
    await this.pauseBeforeReconnect(verdict.reason);
  }

  /**
   * Report a condition only a change can clear, and arm the wait for it.
   *
   * Three things happen and all three matter: the state goes `insufficient`
   * (so the watcher stops rather than looking armed), the observer is told
   * ONCE for this transition (so an hourly re-probe does not become an hourly
   * alarm), and the wait is interruptible (so `recheckNow()` after a config
   * change retries immediately).
   *
   * The waiting itself is left to `settleTerminal`, which runs after the
   * connection has been released.
   */
  private reportTerminal(
    verdict: InboundCapabilityVerdict,
    notice: EmailCapabilityFailureNotice | null,
  ): void {
    const announced = this.tracker.record(verdict);
    this.mode = 'inactive';
    const failure: InboundMailTerminalFailure = {
      account: this.settings.account,
      mailbox: this.settings.mailbox,
      reason: verdict.reason,
      detail: verdict.detail,
      fix: verdict.fix,
      at: new Date(this.deps.clock.now()).toISOString(),
      notice,
    };
    this.terminal = failure;
    this.pendingRecheck = true;
    if (announced) {
      try {
        this.deps.observer?.terminalFailure?.(failure);
      } catch {
        // A notification route that throws must not become a second failure.
      }
    }
  }

  /**
   * Wait out the capability re-probe interval, or until somebody says the
   * configuration changed.
   *
   * Deliberately not a tight loop: re-probing a refused credential every
   * second is how an account gets locked, and re-probing it once an hour is
   * enough for "he fixed it and did not restart the daemon" to just work.
   */
  private async waitForRecheck(): Promise<void> {
    const wake = new AbortController();
    this.recheckWake = wake;
    const combined = anySignal([this.shutdown.signal, wake.signal]);
    try {
      await this.deps.clock.sleep(this.settings.capabilityRecheckMs, combined.signal);
    } finally {
      combined.dispose();
      this.recheckWake = null;
    }
  }

  private async pauseBeforeReconnect(reason: InboundCapabilityReason): Promise<void> {
    const ceiling = reason === 'server-unavailable'
      ? this.settings.serverUnavailableBackoffMs
      : undefined;
    await this.sleep(this.connectBackoff.next(ceiling));
  }

  private async sleep(ms: number): Promise<void> {
    await this.deps.clock.sleep(ms, this.shutdown.signal);
  }

  private requireCursor(): MailboxCursor {
    const cursor = this.cursor;
    if (cursor === null) {
      throw new Error(
        'The mailbox cursor has not been resolved yet; the watcher cannot read '
        + 'a mailbox before it knows where it left off.',
      );
    }
    return cursor;
  }

  private note(
    kind: 'cursor-established' | 'cursor-reset',
    detail: string,
  ): void {
    try {
      this.deps.observer?.note?.({
        account: this.settings.account,
        mailbox: this.settings.mailbox,
        kind,
        detail,
        at: new Date(this.deps.clock.now()).toISOString(),
      });
    } catch {
      // An observer that throws must not stop the mail being read.
    }
  }
}
