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
  classifyLocalFailure,
  classifyOpenFailure,
  classifyReadFailure,
  errorText,
  resolveIdleSupport,
  verdictForOpenConnection,
} from './capability.js';
import { runIdleLoop, type IdleWakeSummary } from './idle-watcher.js';
import { anySignal } from './any-signal.js';
import { resolveMailboxStartPosition } from './mailbox-position.js';
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
  MailboxCursorPort,
  RandomSource,
  WatcherClock,
} from './ports.js';
import type { MailboxCursor } from './types.js';

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
  /**
   * Consecutive failed reconnect attempts. 0 once a connection has drained.
   *
   * Deliberately NOT "0 while connected", which is what it used to say and
   * what the code used to do. Opening a socket is not progress on its own: a
   * watcher that connects, fails its drain, disconnects and connects again is
   * making no progress at all, and resetting the count on the connect turned
   * an escalating backoff into a flat one that hammered the provider forever.
   * The count clears when a drain completes — when the connection has done the
   * thing it exists to do.
   */
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
 * How many passes may end in an unexpected throw before it stops being treated
 * as a condition that will clear.
 *
 * Not one — a full disk during a log rotation, or a state directory being
 * replaced by an installer, recovers within seconds and a watcher that gave up
 * on the first one would need a restart it should not need. Not unbounded
 * either: retrying forever is how a permanently unwritable cursor becomes a
 * watcher that looks busy and delivers nothing. Ten attempts on the reconnect
 * backoff spans minutes, which is long enough for anything transient and short
 * enough that the owner hears about anything else the same hour.
 */
const MAX_CONSECUTIVE_LOCAL_FAILURES = 10;

/**
 * How many drains may end in an unreadable FETCH answer before the mailbox is
 * called unreadable rather than retried.
 *
 * The same ceiling, for the same reason, as the throw path above — and it was
 * missing, which is the whole of the defect this constant closes. A drain that
 * ends in `read-failed` because the server's answer could not be parsed is
 * correct to retry: the message is still in the mailbox, the cursor has not
 * moved past it, and one torn response on one socket really does clear on the
 * next connection. What is not correct is retrying it forever. The unreadable
 * response is produced by the SERVER's wire format and this CLIENT's parser,
 * neither of which changes between attempts, so a batch that came back
 * unreadable ten times in a row will come back unreadable the eleventh time,
 * and the eleven-thousandth.
 *
 * The cost of not having this is not merely a stuck mailbox. The retry rides
 * the reconnect backoff, and the backoff only escalates if it is not being
 * reset — see `drainOnce`, which is now the only place that resets it. Before
 * that, a successful TCP connect reset the schedule and every reconnect
 * restarted from attempt zero: a flat 500 ms of sleep between logins,
 * indefinitely, against a provider that permits fifteen concurrent
 * connections. Ten attempts on an escalating backoff spans minutes, which is
 * long enough for anything genuinely transient and short enough that the owner
 * hears about anything else the same hour.
 */
const MAX_CONSECUTIVE_UNREADABLE_DRAINS = 10;

/**
 * The "nothing was thrown" marker.
 *
 * A sentinel rather than `null` or `undefined`, because both are values a
 * `throw` can legally carry, and a watcher that decided "nothing went wrong"
 * from `throw undefined` would go back to being silently dead.
 */
const NOTHING_THREW: unique symbol = Symbol('nothing-threw');

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
  /** Unexpected throws in a row, with no completed drain in between. */
  private localFailures = 0;
  /** Drains ending in an unreadable answer in a row, with none completed in between. */
  private unreadableDrains = 0;

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

  /**
   * Begin watching. Idempotent; a second call while running does nothing.
   *
   * The runner is cleared when the loop ends, whatever ended it. `status.running`
   * is read off this field, and a field that stays set after the loop returned
   * is the exact lie this round exists to remove: a dead watcher reporting that
   * it is running.
   */
  start(): void {
    if (this.runner !== null) return;
    if (this.shutdown.signal.aborted) this.shutdown = new AbortController();
    const runner: Promise<void> = this.run().finally(() => {
      if (this.runner === runner) this.runner = null;
    });
    this.runner = runner;
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
      let unexpected: unknown = NOTHING_THREW;
      try {
        await this.serve(connection);
      } catch (error) {
        // Everything below `serve` that can throw rather than report: the
        // cursor store's `advance`, which `poll-loop.ts` calls OUTSIDE its
        // `try` because a store write is not a protocol failure. It reaches
        // here through `drainMailboxDelta` -> `drainOnce` -> `onWake` ->
        // `runIdleLoop` -> `serve`, and before this catch existed it kept
        // going: out of `run`, out of the source's `run`, into a supervisor
        // `.catch(() => undefined)`. One transient disk error ended inbound
        // mail permanently, with `email.inbound.status` still reporting a
        // healthy IDLE. Held rather than handled here, because the connection
        // has to be released first — the same rule `settleTerminal` follows.
        unexpected = error;
      } finally {
        this.mode = 'inactive';
        await connection.close().catch(() => undefined);
      }
      if (unexpected !== NOTHING_THREW) await this.handleUnexpectedFailure(unexpected);
      // After the socket is released, never while holding it — see
      // `settleTerminal`.
      await this.settleTerminal();
    }
  }

  /**
   * A throw that no reporting path claimed.
   *
   * Classified rather than logged: a full disk is a wait, an unwritable state
   * directory is a decision, and the two need different answers. Either way the
   * loop stays alive and the verdict stops saying healthy — the failure this
   * catch exists to prevent is not the throw, it is the silence after it.
   */
  private async handleUnexpectedFailure(error: unknown): Promise<void> {
    this.localFailures += 1;
    const { verdict, terminal } = classifyLocalFailure(
      error,
      this.localFailures,
      MAX_CONSECUTIVE_LOCAL_FAILURES,
    );
    if (terminal) {
      this.reportTerminal(verdict, null);
      return;
    }
    this.tracker.record(verdict);
    await this.pauseBeforeReconnect(verdict.reason);
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

    // Protocol half (incl. why a missing UIDNEXT is derived, never assumed to
    // be 0) in `mailbox-position.ts`; the verdict policy is here.
    const position = await resolveMailboxStartPosition({
      status,
      wire: connection.wire,
      mailbox: this.settings.mailbox,
      timeoutMs: this.settings.operationTimeoutMs,
      signal: this.shutdown.signal,
    });
    if (position.outcome === 'search-failed') {
      // A refused SEARCH is routinely transient (§13.1) — never terminal here.
      const search = classifyReadFailure(position.error, 'search');
      if (search.terminal) {
        this.reportTerminal(search.verdict, search.notice);
        return;
      }
      this.tracker.record(search.verdict);
      await this.pauseBeforeReconnect(search.verdict.reason);
      return;
    }
    if (position.outcome === 'position-unknown') {
      // The mailbox reports messages and names none. The only mark left is 0,
      // and 0 replays all of them.
      this.reportTerminal(capabilityVerdict('mailbox-position-unknown', position.detail), null);
      return;
    }

    const resolution = await this.deps.cursors.resolve({
      account: this.settings.account,
      mailbox: this.settings.mailbox,
      serverUidValidity: status.uidValidity,
      currentHighestUid: position.highestUid,
      currentMessageCount: position.messageCount,
    });
    this.cursor = resolution.cursor;
    if (resolution.kind === 'first-run') {
      this.note('cursor-established',
        `Listening from UID ${resolution.cursor.lastSeenUid} onwards; `
        + `${resolution.skippedMessageCount} message(s) already in the mailbox were `
        + 'not read. The daemon starts listening now rather than backfilling.'
        + position.disclosure);
    } else if (resolution.kind === 'uid-validity-changed') {
      this.note('cursor-reset',
        `The mailbox reports a different UIDVALIDITY, so every stored UID names `
        + `nothing and the position was re-established at UID `
        + `${resolution.cursor.lastSeenUid}; `
        + `${resolution.skippedMessageCount} message(s) already present are not `
        + 'replayed. A rebuilt server index is not a reason to re-announce a '
        + 'year of old mail.'
        + position.disclosure);
    }

    // The email layer owns this decision and resolves "the server said
    // nothing" by asking. Reading `connection.report.idle` here instead would
    // be a second answer to the same question.
    const idle = await resolveIdleSupport(connection.reader);
    const useIdle = this.settings.mode !== 'poll' && idle.supported;
    this.tracker.record(verdictForOpenConnection({ mode: this.settings.mode, idle }));
    // `connectBackoff` is deliberately NOT reset here. A connection that opens
    // and then cannot drain has demonstrated nothing about the condition the
    // backoff exists to space out, and resetting on the open turned every
    // reconnect into attempt zero — a flat half-second between logins for as
    // long as the drain kept failing. `drainOnce` resets it, on the completed
    // drain. `authRetried` does clear here, because a server that accepted
    // this sign-in HAS disproved the thing that flag remembers.
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
    // Every drain this loop completed counts, not only the one that ended it.
    // A poll loop that ran for hours and then hit one bad fetch has proved the
    // connection works; without this the consecutive counters would carry
    // across those hours as though nothing in between had succeeded.
    if (result.completedDrains > 0) this.noteDrainCompleted();
    if (result.outcome === 'stopped') return;
    await this.handleDrainFailure({
      outcome: result.outcome === 'read-failed' ? 'read-failed' : 'delivery-failed',
      found: 0,
      delivered: 0,
      vanished: 0,
      cursor: result.cursor,
      error: result.error,
      phase: result.phase,
      unreadableFetch: result.unreadableFetch,
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
    if (report.outcome === 'complete') this.noteDrainCompleted();
    return report;
  }

  /**
   * A drain finished the work it was for. Everything that counts consecutive
   * failures clears here, and ONLY here.
   *
   * One place rather than three, because these three counters answer the same
   * question — "has anything actually worked lately?" — and three copies of
   * that answer is three chances for one of them to keep counting through a
   * mailbox that has been healthy for a week. The escalations they feed are
   * about CONSECUTIVE failures for exactly this reason: one bad minute a week
   * apart must never add up to a permanent verdict.
   *
   * `connectBackoff` belongs in this set and used to sit on the connection
   * instead. A completed drain is the only evidence that a connection is good
   * for the thing connections are for.
   */
  private noteDrainCompleted(): void {
    this.deliveryBackoff.reset();
    this.connectBackoff.reset();
    this.localFailures = 0;
    this.unreadableDrains = 0;
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
    if (report.outcome === 'read-failed' && report.unreadableFetch) {
      await this.handleUnreadableDrain(report.error);
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

  /**
   * A drain that stopped because the server's answer could not be read.
   *
   * Retried, and bounded. Retrying is right: the cursor is below the message,
   * the message is still in the mailbox, and one torn response on one socket
   * does clear. Bounding it is right for the opposite reason: the response
   * shape is the server's and the parser is ours, and neither changes between
   * attempts, so a batch that will not read has no next time in which to read.
   *
   * Between the two lies the failure this method exists to make impossible —
   * a mailbox retrying an unreadable batch forever, delivering nothing,
   * reporting `degraded`, and opening a connection every few hundred
   * milliseconds against a provider that counts them. The owner is told once,
   * with what could not be read, and the watcher stops rather than becoming
   * the outage.
   */
  private async handleUnreadableDrain(error: unknown): Promise<void> {
    this.unreadableDrains += 1;
    const text = errorText(error);
    if (this.unreadableDrains >= MAX_CONSECUTIVE_UNREADABLE_DRAINS) {
      this.reportTerminal(capabilityVerdict('fetch-unreadable',
        `${text} This has now happened ${String(this.unreadableDrains)} times in a row with no `
        + 'drain completing in between, so the answer is not going to become readable by asking '
        + 'again.'), null);
      return;
    }
    this.tracker.record(capabilityVerdict('reconnecting',
      `${text} Attempt ${String(this.unreadableDrains)} of `
      + `${String(MAX_CONSECUTIVE_UNREADABLE_DRAINS)} before the mailbox is reported as one `
      + 'this daemon cannot read.'));
    await this.pauseBeforeReconnect('reconnecting');
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
