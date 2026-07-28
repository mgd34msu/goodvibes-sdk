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
import { describeInboundMailHealth, type InboundMailHealthEntry } from './health.js';
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
import type { InboundMailboxWatcherStatus } from './watcher.js';
import type { InboundSourceCursor } from './source-cursor.js';
import type { ConfigManager } from '../../config/manager.js';

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
 * Which source is in force, and what it costs.
 *
 * `latency` is carried as the SENTENCE `describeSourceLatency` produces rather
 * than as a raw number, because the whole reason `SourceLatency` is on the
 * interface is that "real-time" must never be claimed for a poll — and a
 * consumer handed `{ kind: 'poll', worstCaseMs }` is a consumer that can write
 * that sentence itself, wrongly.
 */
export interface InboundMailSourceReport {
  readonly kind: InboundMailSourceKind | null;
  /** `forced`, `google-adopted`, … or the refusal reason when nothing runs. */
  readonly basis: string;
  readonly detail: string;
  /** Empty string before a source exists to state its latency. */
  readonly latency: string;
}

/** What a store retains, for the disclosure §9 requires. */
export interface InboundMailRetentionReport {
  readonly cursors: { readonly kept: number; readonly maxCursors: number };
  readonly records: {
    readonly kept: number;
    readonly retentionDays: number;
    readonly maxRecords: number;
    readonly maxBodyExcerptChars: number;
  };
  readonly expectations: { readonly open: number; readonly maxOpen: number };
  /** The last housekeeping pass this process ran, or null before the first. */
  readonly lastSweep: {
    readonly sweptAt: number;
    readonly trigger: string;
    readonly summary: string;
  } | null;
}

/** One persisted cursor, as `email.inbound.status` discloses it. */
export interface DisclosedCursor {
  readonly account: string;
  readonly mailbox: string;
  readonly source: InboundSourceCursor['source'];
  /**
   * The position, as a string on both sources.
   *
   * A Gmail `historyId` is a decimal uint64 that must never be parsed to a
   * number, and an IMAP position is two numbers rather than one, so a single
   * numeric field could only be wrong for one of them.
   */
  readonly position: string;
  readonly updatedAt: string;
  readonly ageMs: number;
}

/** The whole disclosure `email.inbound.status` answers with. */
export interface InboundMailStatusSnapshot {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly mode: InboundMailboxWatcherStatus['mode'];
  readonly reason: string;
  readonly account: string;
  readonly mailbox: string;
  readonly source: InboundMailSourceReport;
  readonly capability: InboundCapabilityVerdict | null;
  readonly cursors: readonly DisclosedCursor[];
  readonly expectations: readonly {
    readonly id: string;
    readonly serviceDomain: string;
    readonly recipientAddress: string;
    readonly purpose: string;
    readonly openedAt: string;
    readonly expiresAt: string;
    readonly remainingMs: number;
  }[];
  readonly retention: InboundMailRetentionReport;
  readonly health: InboundMailHealthEntry;
}

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
   * The two facts `selectInboundMailSource` needs that this module cannot
   * know: whether Google credentials are adopted on this machine, and whether
   * the configured mail account is a Gmail one. Asked at `start()` so a
   * credential adopted after boot is seen on the next start rather than at the
   * next restart.
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
  readonly expectationPolicy: Pick<PersistedExpectationStore, 'getPolicy'>;
  readonly housekeeper: InboundMailHousekeeper;
  /** What a found message goes through. Injected: the supervisor owns lifecycle, not intake. */
  readonly handle: (message: InboundMailboxMessage) => Promise<void>;
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

  constructor(deps: InboundMailSupervisorDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  get status(): InboundMailSupervisorStatus {
    return this.currentStatus;
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

    if (!this.deps.config.get('surfaces.email.inbound.enabled')) {
      return this.settle('inactive',
        'inbound mail is switched off (surfaces.email.inbound.enabled=false); set it to true, '
        + 'with at least one account in surfaces.email.inbound.accounts, to watch a mailbox');
    }

    // Rehydration, in the order §9 requires: sweep the stores, THEN bring the
    // expectations back, THEN start reading. A source started first could
    // match a message against an expectation the sweep was about to reap.
    await this.deps.housekeeper.runRecoverySweep();
    await this.deps.expectations.hydrate();

    const facts = await this.deps.selectionFacts();
    const selection = selectInboundMailSource({
      configured: this.deps.config.get('surfaces.email.inbound.source'),
      googleAdopted: facts.googleAdopted,
      mailAccountIsGmail: facts.mailAccountIsGmail,
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

    this.loop = source.run(abort.signal).catch(() => undefined);
    return this.settle(
      source.latency.kind === 'push' ? 'idle' : 'polling',
      `${selection.detail} ${describeSourceLatency(source.latency)}`,
      true,
    );
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
    return describeInboundMailHealth({
      account: this.deps.account,
      mailbox: this.deps.mailbox,
      enabled: Boolean(this.deps.config.get('surfaces.email.inbound.enabled')),
      running: this.currentStatus.running,
      mode: this.currentStatus.mode,
      reason: this.currentStatus.reason,
      verdict: this.verdict,
    });
  }

  /**
   * Everything `email.inbound.status` discloses: the cursors, the open
   * expectations, the capability state, the source in force with its latency,
   * and what each store retains.
   */
  async describeStatus(): Promise<InboundMailStatusSnapshot> {
    const now = this.now();
    const cursors = await this.deps.cursors.list();
    const records = await this.deps.records.list();
    const open = this.deps.expectations.list();
    const lastSweep = this.deps.housekeeper.getLastReport();
    const recordPolicy = this.deps.records.getPolicy();
    return {
      enabled: Boolean(this.deps.config.get('surfaces.email.inbound.enabled')),
      running: this.currentStatus.running,
      mode: this.currentStatus.mode,
      reason: this.currentStatus.reason,
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
          retentionDays: Math.round(recordPolicy.retentionMs / 86_400_000),
          maxRecords: recordPolicy.maxRecords,
          maxBodyExcerptChars: recordPolicy.maxBodyExcerptChars,
        },
        expectations: {
          open: open.length,
          maxOpen: this.deps.expectationPolicy.getPolicy().maxOpenExpectations,
        },
        lastSweep: lastSweep === null
          ? null
          : { sweptAt: lastSweep.sweptAt, trigger: lastSweep.trigger, summary: lastSweep.summary },
      },
      health: this.health(),
    };
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
   * Read from config rather than left at the module default because the value
   * has a correctness floor: it must outlast a restart cycle, or a message
   * fetched just before the daemon's hourly auto-restart comes back after it
   * with its claim already expired and is announced twice.
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
          this.currentStatus = {
            mode: 'inactive',
            reason: `${transition.to.detail}${transition.to.fix ? ` ${transition.to.fix}` : ''}`,
            running: false,
          };
        }
        this.deps.observer?.stateChanged?.(transition);
      },
      terminalFailure: (failure: InboundMailTerminalFailure): void => {
        this.terminal = failure;
        this.deps.observer?.terminalFailure?.(failure);
      },
      note: (note: InboundMailNote): void => {
        this.deps.observer?.note?.(note);
      },
    };
  }

  private settle(
    mode: InboundMailSupervisorStatus['mode'],
    reason: string,
    running = false,
  ): InboundMailSupervisorStatus {
    this.currentStatus = { mode, reason, running };
    return this.currentStatus;
  }
}

function discloseCursor(cursor: InboundSourceCursor, now: number): DisclosedCursor {
  const updatedAt = Date.parse(cursor.updatedAt);
  return {
    account: cursor.account,
    mailbox: cursor.mailbox,
    source: cursor.source,
    position: cursor.source === 'gmail'
      ? `historyId ${cursor.historyId}`
      : `UIDVALIDITY ${String(cursor.uidValidity)} / UID ${String(cursor.lastSeenUid)}`,
    updatedAt: cursor.updatedAt,
    ageMs: Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : 0,
  };
}
