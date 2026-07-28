/**
 * supervisor.ts — inbound mail's lifecycle owner (docs/inbound-email.md §3.5).
 *
 * IMAP has no inbound HTTP request, so email is the second of the two adapter
 * lifecycle shapes: a stateful supervisor with `start()` / `stop()` / `status`,
 * owned by `BuiltinChannelRuntime` and armed at boot, exactly like
 * `TelegramIngressSupervisor`. Everything under it — IDLE, the poll fallback,
 * capability classification, backoff, the cursor rules, dedup — already exists
 * and is already tested; this file starts it, stops it, and tells the truth
 * about what it is doing.
 *
 * Four properties, each of which is why this is a file rather than four lines
 * in the composition root.
 *
 * **It rehydrates before it serves.** `runRecoverySweep()` runs first, so a
 * cursor for an account no longer in config, a torn record and an already-
 * expired expectation are gone before the first message is looked at. Then the
 * expectation registry hydrates with each record's ORIGINAL absolute expiry —
 * never a fresh window, because a restart that extended a grant would be a
 * grant nobody remembers issuing (§9.2). Only then is a source started, and it
 * resumes from the persisted cursor, so mail that arrived across the daemon's
 * hourly auto-restart is fetched rather than skipped.
 *
 * **It refuses rather than substitutes.** The source is chosen by
 * `selectInboundMailSource`, whose refusal arm carries the remedial step;
 * a refusal stops the supervisor with that reason in `status`, and it never
 * quietly serves the other source instead (§3.4d). The same rule applies one
 * level down: a selected source the factory cannot build is reported, not
 * swapped.
 *
 * **Its status is what it is doing, not what is configured.** `status` is
 * derived from the running source and the last capability verdict. A mailbox
 * whose credential is still in the config file and whose watcher is dead
 * reports `inactive`, with the reason.
 *
 * **It cannot start work.** It holds stores, a sink, a source factory and a
 * notice sender. There is no agent manager, no session broker and no reply
 * queue in any signature in this file — §2.1's structural removal, at the one
 * seam that would otherwise have been handed all of them.
 */

import { createInboundMailDedup, DedupingInboundMailSink } from './sink.js';
import { capabilityVerdict } from './capability.js';
import { describeInboundMailHealth, type InboundMailHealthEntry } from './health.js';
import {
  describeNoticeRefusal,
  type InboundNoticeHealth,
  type InboundNoticeRefusalState,
} from './notice-health.js';
import { summarizeError } from '../../utils/error-display.js';
import { describeSourceLatency, type InboundMailSource } from './source.js';
import {
  selectInboundMailSource,
  type InboundMailSourceKind,
  type InboundSourceSelection,
  type InboundSourceSelectionInput,
} from './source-selection.js';
import type { InboundExpectationRegistry } from './expectation-registry.js';
import type { PersistedExpectationStore } from './expectation-store.js';
import type { InboundMailHousekeeper } from './housekeeping.js';
import type { MailboxCursorStore } from './cursor-store.js';
import type { InboundMailStore } from './record-store.js';
import type {
  InboundCapabilityTransition,
  InboundCapabilityVerdict,
  InboundMailNote,
  InboundMailObserver,
  InboundMailTerminalFailure,
  InboundMailboxMessage,
} from './ports.js';
import { discloseCursor } from './supervisor-status.js';
import type {
  DisclosedCursor,
  InboundMailRetentionReport,
  InboundMailSourceReport,
  InboundMailStatusSnapshot,
  InboundMailStoreHealth,
} from './supervisor-status.js';
import type { InboundMailboxWatcherStatus } from './watcher.js';
import type { ConfigManager } from '../../config/manager.js';

/**
 * The disclosure shapes, re-exported so a file split does not move the public
 * surface. Their declarations live in `supervisor-status.ts`.
 */
export type {
  DisclosedCursor,
  InboundMailRetentionReport,
  InboundMailSourceReport,
  InboundMailStatusSnapshot,
  InboundMailStoreHealth,
} from './supervisor-status.js';

/**
 * The status triple every poll/socket surface reports (§3.5).
 *
 * `mode` is projected off the watcher's own declaration rather than restated:
 * `'idle' | 'polling' | 'inactive'` is the watcher's vocabulary, and a second
 * copy of it here is a second declaration that can drift from the thing whose
 * behaviour it describes.
 */
export interface InboundMailSupervisorStatus {
  readonly mode: InboundMailboxWatcherStatus['mode'];
  /** Why this mode — and, when inactive, exactly what to fix. */
  readonly reason: string;
  readonly running: boolean;
}

/** The config reads this supervisor makes, projected off the real manager. */
export type InboundMailConfigPort = Pick<ConfigManager, 'get'>;

/**
 * How a selected source is built.
 *
 * A port rather than a `switch` in this file, for one reason: building an IMAP
 * source needs a host, a username and a resolved secret, and building a Gmail
 * source needs an adopted Google credential and a history probe. Those are
 * composition-root facts, and a supervisor that reached for them itself could
 * not be exercised without a machine that has them.
 *
 * Returning `null` means "this build cannot serve that source" and is reported
 * as such — never silently answered with the other one.
 */
export interface InboundMailSourceFactory {
  create(input: {
    readonly kind: InboundMailSourceKind;
    readonly account: string;
    readonly mailbox: string;
    readonly sink: DedupingInboundMailSink;
    readonly observer: InboundMailObserver;
  }): Promise<InboundMailSource | null>;
}

export interface InboundMailSupervisorDeps {
  readonly config: InboundMailConfigPort;
  /** Config account id and mailbox this supervisor watches. */
  readonly account: string;
  readonly mailbox: string;
  readonly sources: InboundMailSourceFactory;
  /**
   * The facts `selectInboundMailSource` needs and this module cannot know: is a
   * Gmail source available, is the mail account a Gmail one, and — when the
   * first is false — why. Asked at `start()`, so a credential adopted after
   * boot is seen on the next start rather than the next restart.
   */
  readonly selectionFacts: () => Promise<Omit<InboundSourceSelectionInput, 'configured'>>;
  readonly cursors: MailboxCursorStore;
  readonly records: InboundMailStore;
  readonly expectations: InboundExpectationRegistry;
  /**
   * The expectation store's live bounds, for disclosure.
   *
   * Projected off the store rather than restated as a constant here: the cap
   * is the store's to enforce, and a number copied into this file would be a
   * second declaration that reports a bound the store is not applying.
   */
  readonly expectationPolicy: Pick<PersistedExpectationStore, 'getPolicy' | 'getCorruption'>;
  readonly housekeeper: InboundMailHousekeeper;
  /** What a found message goes through. Injected: the supervisor owns lifecycle, not intake. */
  readonly handle: (message: InboundMailboxMessage) => Promise<void>;
  /**
   * Whether arriving mail is actually reaching the owner.
   *
   * Written by the intake, read here. A structural notice refusal completes the
   * pass — the cursor advances and the message is never re-announced — so the
   * watcher goes on looking perfectly healthy while every message it finds goes
   * unannounced. That is the condition this reads, and it is why `health()`
   * reports `degraded` for it and `status.reason` says so in words.
   *
   * Optional so a supervisor can be exercised without one, in which case it
   * behaves exactly as before. The composition root passes the same instance it
   * gives the intake.
   */
  readonly noticeHealth?: Pick<InboundNoticeHealth, 'get'> | undefined;
  readonly observer?: InboundMailObserver | undefined;
  readonly now?: (() => number) | undefined;
}

/** Never started, and honest about it. */
const NOT_STARTED: InboundMailSupervisorStatus = {
  mode: 'inactive',
  reason: 'not started',
  running: false,
};

export class InboundMailSupervisor {
  private readonly deps: InboundMailSupervisorDeps;
  private readonly now: () => number;

  private source: InboundMailSource | null = null;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private currentStatus: InboundMailSupervisorStatus = NOT_STARTED;
  private selection: InboundSourceSelection | null = null;
  private verdict: InboundCapabilityVerdict | null = null;
  private terminal: InboundMailTerminalFailure | null = null;
  private starting: Promise<InboundMailSupervisorStatus> | null = null;
  /** Start-time steps that failed without stopping the watcher. Carried into `status`. */
  private degradations: readonly string[] = [];

  constructor(deps: InboundMailSupervisorDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * What this supervisor is doing, with any notice refusal folded into the
   * sentence.
   *
   * Appended here rather than at `settle()` because the two facts arrive at
   * different times: the mode is decided when the source starts, and whether
   * the owner is being told is decided per message, long afterwards. A status
   * that reported the first and not the second is exactly the reading that let
   * a mailbox whose every notice was refused go on saying `idle`.
   */
  get status(): InboundMailSupervisorStatus {
    const refusal = this.noticeRefusal();
    if (refusal === null) return this.currentStatus;
    return {
      ...this.currentStatus,
      reason: `${this.currentStatus.reason} ${describeNoticeRefusal(refusal)}`,
    };
  }

  private noticeRefusal(): InboundNoticeRefusalState | null {
    return this.deps.noticeHealth?.get() ?? null;
  }

  /** The last capability verdict reached, or null before any probe. */
  get capability(): InboundCapabilityVerdict | null {
    return this.verdict;
  }

  /** The last failure only a change can clear, or null. */
  get terminalFailure(): InboundMailTerminalFailure | null {
    return this.terminal;
  }

  /**
   * Arm inbound mail. Safe to call repeatedly: a running supervisor is stopped
   * first, so a config change re-decides cleanly rather than layering a second
   * source on top of the first.
   *
   * Concurrent calls share one start rather than racing — the cluster
   * coordinator and a config-change restart can both arrive, and two
   * simultaneous starts against one mailbox is the duplicate-notice failure
   * the cluster gate exists to prevent, reproduced inside a single process.
   */
  async start(): Promise<InboundMailSupervisorStatus> {
    if (this.starting !== null) return this.starting;
    this.starting = this.runStart();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async runStart(): Promise<InboundMailSupervisorStatus> {
    await this.stop();
    // Cleared per start: a sweep that failed last time and worked this time
    // must not go on being appended to every status sentence.
    this.degradations = [];

    if (!this.deps.config.get('surfaces.email.inbound.enabled')) {
      return this.settle('inactive',
        'inbound mail is switched off (surfaces.email.inbound.enabled=false); set it to true, '
        + 'with at least one account in surfaces.email.inbound.accounts, to watch a mailbox');
    }

    // Rehydration, in the order §9 requires: sweep the stores, THEN bring the
    // expectations back, THEN start reading. A source started first could
    // match a message against an expectation the sweep was about to reap.
    //
    // Neither step is allowed to prevent the watcher from starting. `start()`
    // is called by the cluster gate and by a config change, and an unguarded
    // rejection here rejected out of both — no source, no `settle()`, and a
    // health entry with no reason in it. Housekeeping is maintenance: it makes
    // the state tidier, and a mailbox that goes unread because the tidying
    // failed is a strictly worse outcome than a mailbox read with a stale
    // record in a file. Both failures are carried into `status` instead.
    const degradations: string[] = [];
    try {
      await this.deps.housekeeper.runRecoverySweep();
    } catch (error) {
      degradations.push(
        `The recovery sweep of the inbound stores did not run (${summarizeError(error)}); `
        + 'the watcher started anyway and the stores keep whatever they held.');
    }
    try {
      await this.deps.expectations.hydrate();
    } catch (error) {
      degradations.push(
        `Open expectations could not be restored (${summarizeError(error)}); a verification `
        + 'opened before this restart cannot be matched, and the workstream waiting on it '
        + 'will report that no mail arrived.');
    }
    this.degradations = degradations;

    const facts = await this.deps.selectionFacts();
    // Spread whole, not field by field: `selectionFacts` answers exactly the
    // selector's input minus `configured`, so `gmailUnavailable` — the REASON
    // behind a false `googleAdopted` — cannot be dropped by a copied field list.
    const selection = selectInboundMailSource({
      configured: this.deps.config.get('surfaces.email.inbound.source'),
      ...facts,
    });
    this.selection = selection;
    if (selection.kind === 'refused') {
      return this.settle('inactive', `${selection.detail} ${selection.fix}`);
    }

    const sink = new DedupingInboundMailSink({
      dedup: createInboundMailDedup(this.dedupTtlMs()),
      handle: this.deps.handle,
    });
    const source = await this.deps.sources.create({
      kind: selection.source,
      account: this.deps.account,
      mailbox: this.deps.mailbox,
      sink,
      observer: this.observer(),
    });
    if (source === null) {
      // Reported, never substituted. Serving the other source here would leave
      // the owner with a setting that says one thing while the daemon does
      // another — the silent degradation §3.4b refuses everywhere else.
      return this.settle('inactive',
        `inbound mail selected the ${selection.source} source (${selection.detail}), and this `
        + 'build has no way to construct it. The other source is NOT used in its place; '
        + 'set surfaces.email.inbound.source explicitly to the source this install can serve.');
    }

    this.source = source;
    const abort = new AbortController();
    this.abort = abort;
    const verdict = await source.start(abort.signal);
    this.verdict = verdict;
    if (verdict.state === 'insufficient') {
      // §3.4b: an insufficient mailbox does not run, and the connection is
      // released rather than held through the re-check wait.
      await this.releaseSource();
      return this.settle('inactive', `${verdict.detail}${verdict.fix ? ` ${verdict.fix}` : ''}`);
    }

    this.loop = this.watch(source, abort);
    return this.settle(
      source.latency.kind === 'push' ? 'idle' : 'polling',
      `${selection.detail} ${describeSourceLatency(source.latency)}`,
      true,
    );
  }

  /**
   * Hold the source's run loop and observe how it ends.
   *
   * This was `source.run(signal).catch(() => undefined)`, and that single
   * expression is what made a permanent death invisible: the rejection was
   * discarded unread, nothing was reported, and `status.running` went on
   * saying `true` for a loop that had already returned. A run loop can end in
   * exactly three ways and each has to be answered:
   *
   *   - the signal fired — a deliberate stop, and `stop()` settles the status;
   *   - it returned on its own — the source decided it was done, which nothing
   *     asked it to do, so it is reported as a stop with the reason unknown;
   *   - it threw — the failure is named, routed to the observer as a terminal
   *     failure (the observer is where the OWNER is reached from), and put in
   *     `status`.
   *
   * A superseded controller is ignored: a restart has already replaced this
   * source, and letting the old loop's ending overwrite the new one's status
   * would report a stop for a watcher that is running.
   */
  private watch(source: InboundMailSource, abort: AbortController): Promise<void> {
    return source.run(abort.signal).then(
      () => { this.settleLoopEnd(abort, null); },
      (error: unknown) => { this.settleLoopEnd(abort, error); },
    );
  }

  private settleLoopEnd(abort: AbortController, error: unknown): void {
    if (this.abort !== abort) return;
    if (abort.signal.aborted) return;
    const verdict = error === null
      ? capabilityVerdict('watcher-stopped-unexpectedly',
        'The mail source returned from its run loop without being asked to stop.')
      : capabilityVerdict('watcher-stopped-unexpectedly', summarizeError(error));
    this.verdict = verdict;
    this.announceTerminal({
      account: this.deps.account,
      mailbox: this.deps.mailbox,
      reason: verdict.reason,
      detail: verdict.detail,
      fix: verdict.fix,
      at: new Date(this.now()).toISOString(),
      notice: null,
    });
    this.settle('inactive', `${verdict.detail} ${verdict.fix}`);
  }

  /** Record a terminal failure and forward it, without letting the route's failure become ours. */
  private announceTerminal(failure: InboundMailTerminalFailure): void {
    this.terminal = failure;
    try {
      this.deps.observer?.terminalFailure?.(failure);
    } catch {
      // A notification route that throws must not become a second failure —
      // the same rule the watcher applies at its own observer call.
    }
  }

  /**
   * A setting the running source re-reads on every reconnect has changed; look
   * again now rather than at the next scheduled check.
   *
   * This is the seam that makes `recheckNow()` real. It existed on
   * `InboundMailboxWatcher`, was delegated verbatim by `ImapMailSource`, and was
   * called by NOTHING — its own comment said "called when configuration
   * changed" while no configuration change reached it, because nothing
   * subscribed to any `surfaces.email.*` key anywhere. An owner who fixed a
   * wrong IMAP host waited out `capabilityRecheckMinutes` to find out whether it
   * had worked, or restarted the daemon. Both are the restart this platform is
   * supposed not to need.
   *
   * Deliberately NOT a restart. `start()` re-runs the recovery sweep, re-decides
   * the source and rebuilds the dedup cache, none of which a corrected password
   * warrants — and a restart per settings save is how a mailbox ends up
   * reconnecting in a loop while somebody is still typing. The reconnect the
   * watcher was going to make anyway is simply made now.
   *
   * A no-op when nothing is running, and a no-op on a source that declares no
   * `recheckNow`. Both are honest answers to "look again", not swallowed
   * failures: whether there is anything to look again AT is the source's own
   * business — see `InboundMailSource.recheckNow`.
   */
  recheckNow(): void {
    this.source?.recheckNow?.();
  }

  /**
   * Stop reading and release the connection.
   *
   * Does not resolve until the source has genuinely stopped — the cluster
   * handoff depends on that promise being honest, because the successor node
   * is told to start only after this resolves, and two nodes both holding a
   * connection to one mailbox both notify.
   */
  async stop(): Promise<void> {
    await this.releaseSource();
    if (this.currentStatus.running) {
      this.settle('inactive', 'stopped');
    }
  }

  private async releaseSource(): Promise<void> {
    this.abort?.abort();
    const source = this.source;
    const loop = this.loop;
    this.source = null;
    this.loop = null;
    this.abort = null;
    if (source !== null) await source.stop().catch(() => undefined);
    if (loop !== null) await loop;
  }

  /** Email's health entry, read from live state (never from config presence). */
  health(): InboundMailHealthEntry {
    const status = this.status;
    return describeInboundMailHealth({
      account: this.deps.account,
      mailbox: this.deps.mailbox,
      enabled: Boolean(this.deps.config.get('surfaces.email.inbound.enabled')),
      running: status.running,
      mode: status.mode,
      reason: status.reason,
      verdict: this.verdict,
      noticeRefusal: this.noticeRefusal(),
    });
  }

  /**
   * Everything `email.inbound.status` discloses: the cursors, the open
   * expectations, the capability state, the source in force with its latency,
   * and what each store retains.
   */
  async describeStatus(): Promise<InboundMailStatusSnapshot> {
    const now = this.now();
    // Every read is guarded, and the guard is the whole point of this method
    // existing in the shape it does. `email.inbound.status` is the ONE verb
    // that can explain a broken inbound path, and it used to fail outright on
    // an unreadable cursor file — erroring in exactly the state it exists to
    // disclose. A store it cannot read is reported AS unreadable, in `stores`,
    // rather than taking the answer down with it.
    const unavailable = new Map<InboundMailStoreHealth['store'], string>();
    const read = async <T>(
      store: InboundMailStoreHealth['store'],
      run: () => Promise<T>,
      fallback: T,
    ): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        unavailable.set(store, summarizeError(error));
        return fallback;
      }
    };
    const cursors = await read('cursors', () => this.deps.cursors.list(), []);
    const records = await read('records', () => this.deps.records.list(), []);
    // Counted against the FILE, not against the filtered list above. Deriving
    // the disclosure from a view is what let `retention.records.kept` report
    // two while ten sat on disk — see `InboundMailStore.count`.
    const recordCounts = await read('records', () => this.deps.records.count(), { stored: 0, live: 0 });
    const open = await read('expectations', async () => this.deps.expectations.list(), []);
    const stores = this.describeStores(unavailable);
    const lastSweep = this.deps.housekeeper.getLastReport();
    const recordPolicy = this.deps.records.getPolicy();
    const writeReap = this.deps.records.getWriteReapTally();
    const status = this.status;
    const refusal = this.noticeRefusal();
    return {
      enabled: Boolean(this.deps.config.get('surfaces.email.inbound.enabled')),
      running: status.running,
      mode: status.mode,
      reason: status.reason,
      account: this.deps.account,
      mailbox: this.deps.mailbox,
      source: this.describeSource(),
      capability: this.verdict,
      cursors: cursors.map((cursor) => discloseCursor(cursor, now)),
      expectations: open.map((expectation) => ({
        id: expectation.id,
        serviceDomain: expectation.serviceDomain,
        recipientAddress: expectation.recipientAddress,
        purpose: expectation.purpose,
        openedAt: expectation.openedAt,
        expiresAt: expectation.expiresAt,
        remainingMs: expectation.remainingMs,
      })),
      retention: {
        cursors: { kept: cursors.length, maxCursors: this.deps.cursors.getPolicy().maxCursors },
        records: {
          kept: records.length,
          stored: recordCounts.stored,
          retentionDays: Math.round(recordPolicy.retentionMs / 86_400_000),
          maxRecords: recordPolicy.maxRecords,
          maxBodyExcerptChars: recordPolicy.maxBodyExcerptChars,
          reapedOnWrite: writeReap.expired + writeReap.overCap,
        },
        expectations: {
          open: open.length,
          maxOpen: this.deps.expectationPolicy.getPolicy().maxOpenExpectations,
        },
        lastSweep: lastSweep === null
          ? null
          : {
            sweptAt: lastSweep.sweptAt,
            trigger: lastSweep.trigger,
            summary: lastSweep.summary,
            failures: lastSweep.failures.map((failure) => `${failure.store}: ${failure.detail}`),
          },
      },
      stores,
      noticeDelivery: refusal === null
        ? { state: 'ok' }
        : {
          state: 'refused',
          reason: refusal.reason,
          detail: refusal.detail,
          fix: refusal.fix,
          since: refusal.since,
          unannounced: refusal.unannounced,
        },
      health: this.health(),
    };
  }

  /**
   * One entry per persisted store: read normally, discarded, or unreadable now.
   *
   * Always all three, in a fixed order, because an omitted store reads as a
   * store with nothing to say — and "nothing to say" is the wrong answer about
   * a file whose contents were thrown away.
   */
  private describeStores(
    unavailable: ReadonlyMap<InboundMailStoreHealth['store'], string>,
  ): readonly InboundMailStoreHealth[] {
    const corruption = {
      cursors: this.deps.cursors.getCorruption(),
      records: this.deps.records.getCorruption(),
      expectations: this.deps.expectationPolicy.getCorruption(),
    } as const;
    const order: readonly InboundMailStoreHealth['store'][] = ['cursors', 'records', 'expectations'];
    return order.map((store): InboundMailStoreHealth => {
      const unreadableNow = unavailable.get(store);
      if (unreadableNow !== undefined) {
        return { store, state: 'unavailable', detail: unreadableNow };
      }
      const discarded = corruption[store];
      if (discarded !== null) {
        return {
          store,
          state: 'discarded-unreadable',
          detail: `${discarded.filePath} could not be read (${discarded.detail}); its contents `
            + 'were discarded rather than repaired, and this store is serving what has been '
            + 'written since.',
        };
      }
      return { store, state: 'ok', detail: '' };
    });
  }

  private describeSource(): InboundMailSourceReport {
    const selection = this.selection;
    if (selection === null) {
      return { kind: null, basis: 'not-started', detail: this.currentStatus.reason, latency: '' };
    }
    if (selection.kind === 'refused') {
      return { kind: null, basis: selection.reason, detail: `${selection.detail} ${selection.fix}`, latency: '' };
    }
    return {
      kind: selection.source,
      basis: selection.basis,
      detail: selection.detail,
      latency: this.source === null ? '' : describeSourceLatency(this.source.latency),
    };
  }

  /**
   * The dedup window, in milliseconds.
   *
   * Read from config so the window is tunable, and NOT because it has a
   * correctness floor. It used to say it did — "it must outlast a restart
   * cycle" — and that was structurally false: the cache is built fresh three
   * lines above, inside `runStart()`, which also runs on a config-change
   * restart and on a cluster-gate handoff. A restart does not expire the claim,
   * it destroys the cache, and no value here changes that. A floor guarding a
   * property the mechanism cannot provide at any setting is a floor guarding
   * nothing.
   *
   * What the window genuinely bounds is two passes inside ONE process arriving
   * at the same message — an IDLE wake overlapping a fallback poll, or a retry
   * after a failed pass. Those are seconds apart, so any sane value works and
   * the default is generous rather than critical. What actually stops a
   * restart-crossing duplicate ANNOUNCEMENT is the record store: `intake.ts`
   * reads the message's own record before announcing, and that survives.
   */
  private dedupTtlMs(): number {
    const minutes = this.deps.config.get('surfaces.email.inbound.dedupTtlMinutes');
    return typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
      ? minutes * 60_000
      : 60 * 60_000;
  }

  /**
   * The caller's observer with the two facts `status` is built from kept.
   *
   * Every call forwards. Nothing is filtered — the adapter reads the stream,
   * it does not consume from it.
   */
  private observer(): InboundMailObserver {
    return {
      stateChanged: (transition: InboundCapabilityTransition): void => {
        this.verdict = transition.to;
        if (transition.to.state === 'insufficient') {
          this.settle(
            'inactive',
            `${transition.to.detail}${transition.to.fix ? ` ${transition.to.fix}` : ''}`,
          );
        } else if (this.loop !== null) {
          // The OTHER direction, which used to be missing entirely. The
          // capability re-probe runs hourly precisely so that fixing a password
          // or a scope does not need a restart — and with only the
          // `insufficient` arm written, the recovery reached the verdict and
          // never reached the status: `health()` went on answering `degraded`,
          // and `status` went on saying `inactive`, for a watcher that was
          // reading mail again. Gated on the loop existing so a transition
          // during `start()`, before there is anything running, cannot report
          // `running: true` ahead of the loop it describes.
          this.terminal = null;
          const source = this.source;
          this.settle(
            source !== null && source.latency.kind === 'poll' ? 'polling' : 'idle',
            `${transition.to.detail}${transition.to.fix ? ` ${transition.to.fix}` : ''}`,
            true,
          );
        }
        this.deps.observer?.stateChanged?.(transition);
      },
      terminalFailure: (failure: InboundMailTerminalFailure): void => {
        this.announceTerminal(failure);
      },
      note: (note: InboundMailNote): void => {
        this.deps.observer?.note?.(note);
      },
    };
  }

  /**
   * Set the status, with anything that degraded at start-time appended.
   *
   * Appended rather than kept in a separate field nobody reads: `reason` is the
   * one string every surface renders, and a start that half-worked has to be
   * visible in the sentence the owner is actually shown.
   */
  private settle(
    mode: InboundMailSupervisorStatus['mode'],
    reason: string,
    running = false,
  ): InboundMailSupervisorStatus {
    const full = this.degradations.length === 0
      ? reason
      : `${reason} ${this.degradations.join(' ')}`;
    this.currentStatus = { mode, reason: full, running };
    return this.currentStatus;
  }
}
