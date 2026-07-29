/**
 * housekeeping.ts — recovery-time and periodic garbage collection for
 * everything inbound mail persists: the cursor store, the record store, and
 * the expectation store (docs/inbound-email.md §9). Composes the three the
 * same way `platform/devices/device-housekeeping.ts`'s `DeviceHousekeeper`
 * composes the device grant and capture-artifact stores.
 *
 * Persistence without recovery-time housekeeping does not fail loudly — it
 * silently serves stale or corrupt state forever — so all three are swept on
 * recovery AND on a timer, and every sweep discloses what it removed.
 *
 * Disclosure is written to `inbound-mail-housekeeping.json` beside the three
 * stores: a caller (or a person reading the directory) can always see what
 * was reaped and why, so a deletion is never indistinguishable from data
 * loss.
 */
import { PersistentStore, persistentStoreOrphansReclaimed } from '../../state/persistent-store.js';
import { StoreWriteQueue } from '../../state/store-write-queue.js';
import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';
import type { CursorSweepReport, MailboxCursorStore } from './cursor-store.js';
import type { ExpectationSweepReport, PersistedExpectationStore } from './expectation-store.js';
import type { InboundMailRecordSweepReport, InboundMailStore } from './record-store.js';
import type { HousekeepingTrigger } from './types.js';

/** One store that could not be swept at all, and why. */
export interface InboundMailSweepFailure {
  readonly store: 'cursors' | 'records' | 'expectations' | 'disclosure';
  readonly detail: string;
}

/**
 * What one full pass removed, across all three stores.
 *
 * Each store's report is NULLABLE, and that is the point rather than a
 * convenience: the three used to be swept in one sequential expression, so a
 * throw from the first meant the second and third never ran and a caller could
 * not tell — a full record store and an expired expectation book both survived
 * a "successful" boot because one cursor file had a bad byte in it. A store
 * that could not be swept says so here, in `failures`, and the other two are
 * swept anyway.
 */
export interface InboundMailHousekeepingReport {
  readonly sweptAt: number;
  readonly trigger: HousekeepingTrigger;
  readonly cursors: CursorSweepReport | null;
  readonly records: InboundMailRecordSweepReport | null;
  readonly expectations: ExpectationSweepReport | null;
  /** Empty on a pass where every store swept. */
  readonly failures: readonly InboundMailSweepFailure[];
  /** One-line summary a surface can render without reading the itemised lists. */
  readonly summary: string;
}

/**
 * A report AS PERSISTED, which is not the report as produced.
 *
 * WHAT A DISCLOSURE ACTUALLY NEEDS, and why it is less than the report:
 *
 * A disclosure log exists to answer "what was removed, and why" for something
 * that is now gone. Everything it needs is therefore about the REMOVED. The
 * in-memory `ExpectationSweepReport` also carries `survivors` — the full
 * `VerificationExpectation` objects that did NOT go — because
 * `InboundExpectationRegistry.hydrate()` feeds them straight into the live
 * book at boot. That is a same-process hand-off between two objects, and it
 * has no business being on disk.
 *
 * Writing it anyway made `email-inbound-housekeeping.json` a SECOND COPY of
 * the expectation store: every recipient alias, service domain and purpose,
 * duplicated into a file that expiry reaping never touches. The expectation
 * store reaps an expired grant within its window; the copy of it in the
 * disclosure log survived for the next twenty sweeps regardless — a store
 * nobody declared, holding the exact data the declared one is careful about.
 *
 * So `survivors` is dropped on the way to disk. `retained` already carries the
 * count, and a count is what a disclosure needs about the things that stayed:
 * naming them is not disclosure, it is retention.
 *
 * `removed` is kept, because the removed ARE the disclosure — but bounded. A
 * sweep of a full record store can remove thousands of rows, and twenty of
 * those reports is a log far larger than the stores it describes. Past
 * `MAX_DISCLOSED_REMOVALS` the entries are dropped and `removedTotal` says how
 * many there really were, so the count is never quietly wrong.
 */
export type DisclosedSweep<T extends { readonly removed: readonly unknown[] }> =
  Omit<T, 'survivors' | 'removed'> & {
    readonly removed: readonly T['removed'][number][];
    /** How many removals the pass actually made, when `removed` was truncated. */
    readonly removedTotal: number;
  };

export interface DisclosedHousekeepingReport {
  readonly sweptAt: number;
  readonly trigger: HousekeepingTrigger;
  readonly cursors: DisclosedSweep<CursorSweepReport> | null;
  readonly records: DisclosedSweep<InboundMailRecordSweepReport> | null;
  readonly expectations: DisclosedSweep<ExpectationSweepReport> | null;
  readonly failures: readonly InboundMailSweepFailure[];
  readonly summary: string;
}

interface HousekeepingLog extends Record<string, unknown> {
  readonly version: 1;
  readonly reports: readonly DisclosedHousekeepingReport[];
}

/** Keep the disclosure log itself bounded — it is persisted state too. */
const MAX_DISCLOSURE_REPORTS = 20;

/**
 * How long a disclosure entry is kept, in addition to the count cap.
 *
 * BOTH BOUNDS, because the count cap alone is an age cap only by accident. A
 * daemon sweeping every six hours fills twenty entries in five days, so the
 * count looks like it reaps by age — but the reaping is done by ARRIVALS, and a
 * store nothing writes to has none. A mailbox that goes quiet, a surface
 * switched off, a daemon that stops running: in every one of those the twentieth
 * entry is the last one written and it stays forever, which is the same
 * "persisted state with no GC" the log exists to record about other files.
 *
 * §9's rule is that anything persisted reaps on a clock as well as on a bound,
 * and ninety days is the same order as the record store's own retention: long
 * enough that "what happened to my mail last month" is answerable, short enough
 * that nothing here is indefinite.
 */
export const DEFAULT_DISCLOSURE_RETENTION_MS = 90 * 24 * 60 * 60_000;

/** How many itemised removals one persisted report may carry. See `DisclosedSweep`. */
const MAX_DISCLOSED_REMOVALS = 100;

/** Bound on any single free-text field in the log: a sweep failure's `detail`, a removal's `note`. */
const MAX_DISCLOSED_TEXT_CHARS = 512;

/** Bound on the one-line summary. Assembled from bounded parts, bounded anyway — the log is persisted state. */
const MAX_DISCLOSED_SUMMARY_CHARS = 2_000;

function clampText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** Project one store's sweep report onto what the log persists: no survivors, bounded removals, bounded text. */
function discloseSweep<T extends { readonly removed: readonly { readonly note?: string | undefined }[] }>(
  report: T | null,
): DisclosedSweep<T> | null {
  if (report === null) return null;
  const { survivors: _survivors, removed, ...rest } = report as T & { survivors?: unknown };
  return {
    ...(rest as Omit<T, 'survivors' | 'removed'>),
    removed: removed.slice(0, MAX_DISCLOSED_REMOVALS).map((entry) => (
      typeof entry.note === 'string'
        ? { ...entry, note: clampText(entry.note, MAX_DISCLOSED_TEXT_CHARS) }
        : entry
    )),
    removedTotal: removed.length,
  } as DisclosedSweep<T>;
}

/** One full pass's report, projected onto what the log persists. */
function discloseReport(report: InboundMailHousekeepingReport): DisclosedHousekeepingReport {
  return {
    sweptAt: report.sweptAt,
    trigger: report.trigger,
    cursors: discloseSweep(report.cursors),
    records: discloseSweep(report.records),
    expectations: discloseSweep(report.expectations),
    failures: report.failures.map((failure) => ({
      store: failure.store,
      detail: clampText(failure.detail, MAX_DISCLOSED_TEXT_CHARS),
    })),
    summary: clampText(report.summary, MAX_DISCLOSED_SUMMARY_CHARS),
  };
}

/**
 * Validate a report read back from the log BY CONTENT.
 *
 * `listDisclosures()` used to hand back `log.reports` on the strength of it
 * being an array — the only structure here read without validation, in a file
 * whose own header states the rule (§9: reap, bound, validate by content,
 * sweep, disclose). A hand-edited or half-written entry then flowed straight
 * into whatever rendered it.
 *
 * Only the fields a reader is entitled to rely on are checked, and anything
 * failing is dropped rather than repaired — the same rule the three stores
 * apply to their own records.
 */
export function validateDisclosedHousekeepingReport(value: unknown): DisclosedHousekeepingReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const report = value as Record<string, unknown>;
  if (typeof report.sweptAt !== 'number' || !Number.isFinite(report.sweptAt)) return null;
  if (report.trigger !== 'recovery' && report.trigger !== 'periodic' && report.trigger !== 'manual') return null;
  if (typeof report.summary !== 'string' || report.summary.length > MAX_DISCLOSED_SUMMARY_CHARS) return null;
  if (!Array.isArray(report.failures) || report.failures.length > MAX_DISCLOSED_REMOVALS) return null;
  const failures = report.failures.filter((entry): entry is InboundMailSweepFailure => (
    !!entry && typeof entry === 'object'
    && typeof (entry as InboundMailSweepFailure).store === 'string'
    && typeof (entry as InboundMailSweepFailure).detail === 'string'
    && (entry as InboundMailSweepFailure).detail.length <= MAX_DISCLOSED_TEXT_CHARS
  ));
  if (failures.length !== report.failures.length) return null;
  const sweep = <K extends 'cursors' | 'records' | 'expectations'>(key: K): unknown => {
    const value = report[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) return undefined; // sentinel: invalid
    const entry = value as Record<string, unknown>;
    if (!Array.isArray(entry.removed) || entry.removed.length > MAX_DISCLOSED_REMOVALS) return undefined;
    if (typeof entry.retained !== 'number' || !Number.isFinite(entry.retained)) return undefined;
    // A log written before survivors were dropped still parses; the field is
    // simply not carried forward, so reading an old file cannot resurrect the
    // second copy this projection exists to stop.
    const { survivors: _survivors, ...rest } = entry;
    return rest;
  };
  const cursors = sweep('cursors');
  const records = sweep('records');
  const expectations = sweep('expectations');
  if (cursors === undefined || records === undefined || expectations === undefined) return null;
  return {
    sweptAt: report.sweptAt,
    trigger: report.trigger,
    cursors: cursors as DisclosedHousekeepingReport['cursors'],
    records: records as DisclosedHousekeepingReport['records'],
    expectations: expectations as DisclosedHousekeepingReport['expectations'],
    failures,
    summary: report.summary,
  };
}

export interface InboundMailHousekeeperOptions {
  readonly cursors: MailboxCursorStore;
  readonly records: InboundMailStore;
  readonly expectations: PersistedExpectationStore;
  /** Where the disclosure log is written. */
  readonly disclosurePath: string;
  /** Age bound on the log's own entries. Defaults to `DEFAULT_DISCLOSURE_RETENTION_MS`. */
  readonly disclosureRetentionMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

/** `3 malformed, 1 file-unreadable` — removals grouped by their own reason word. */
function byReason(removed: readonly { readonly reason: string }[]): string {
  const counts = new Map<string, number>();
  for (const removal of removed) counts.set(removal.reason, (counts.get(removal.reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) => `${String(count)} ${reason}`).join(', ');
}

/**
 * The disclosure sentence.
 *
 * A store that did not sweep is named as such rather than omitted: an absent
 * line reads as "nothing to report", and "nothing to report" is precisely the
 * wrong thing to say about a file nobody could read.
 */
function summarize(
  cursors: CursorSweepReport | null,
  records: InboundMailRecordSweepReport | null,
  expectations: ExpectationSweepReport | null,
  failures: readonly InboundMailSweepFailure[],
): string {
  const parts: string[] = [];
  if (cursors !== null && cursors.removed.length > 0) {
    parts.push(`${String(cursors.removed.length)} cursor(s) removed (${byReason(cursors.removed)})`);
  }
  if (records !== null && records.removed.length > 0) {
    parts.push(`${String(records.removed.length)} inbound record(s) removed (${byReason(records.removed)})`);
  }
  if (expectations !== null && expectations.removed.length > 0) {
    parts.push(`${String(expectations.removed.length)} expectation(s) removed (${byReason(expectations.removed)})`);
  }
  const unreadable = [cursors, records, expectations].some(
    (report) => report !== null && report.removed.some((entry) => entry.reason === 'file-unreadable'),
  );
  const retained = [
    cursors === null ? 'cursors NOT SWEPT' : `${String(cursors.retained)} cursor(s)`,
    records === null ? 'records NOT SWEPT' : `${String(records.retained)} record(s)`,
    expectations === null ? 'expectations NOT SWEPT' : `${String(expectations.retained)} expectation(s)`,
  ].join(', ');
  const head = parts.length === 0
    ? 'Inbound mail housekeeping: nothing to reap.'
    : `Inbound mail housekeeping: ${parts.join('; ')}.`;
  const corrupt = unreadable ? ' A store file could not be read and its contents were discarded.' : '';
  // Cursors kept because nobody could say whether their account is still
  // configured. Said out loud rather than folded into `retained`: they were
  // not justified, they were spared, and a count that never falls to zero
  // means a caller that can never answer.
  const unresolved = cursors !== null && cursors.unresolvedAccounts > 0
    ? ` ${String(cursors.unresolvedAccounts)} cursor(s) were kept because the `
      + 'configured-account answer was not available on this pass.'
    : '';
  const failed = failures.length === 0
    ? ''
    : ` ${String(failures.length)} store(s) could not be swept: `
      + `${failures.map((failure) => `${failure.store} (${failure.detail})`).join('; ')}.`;
  // Deleting files with nothing anywhere saying so is the exact objection this
  // round raised against silent write-time bounding. `PersistentStore` reclaims
  // temp files left by a process killed mid-write, and this is where that gets
  // said out loud. Process-wide and cumulative, so it is worded as such — it
  // includes stores this housekeeper does not own.
  const orphans = persistentStoreOrphansReclaimed();
  const reclaimed = orphans === 0
    ? ''
    : ` ${String(orphans)} orphaned temporary file(s) left by an interrupted write `
      + 'have been reclaimed by this daemon since it started.';
  return `${head} Retained ${retained}.${corrupt}${unresolved}${failed}${reclaimed}`;
}

/**
 * Sweeps all three inbound-mail stores and records the disclosure. Construct
 * once at daemon boot, call `runRecoverySweep()` before the watcher serves
 * any mail, and `start()` to keep sweeping on a timer.
 */
export class InboundMailHousekeeper {
  private readonly cursors: MailboxCursorStore;
  private readonly records: InboundMailStore;
  private readonly expectations: PersistedExpectationStore;
  private readonly disclosure: PersistentStore<HousekeepingLog>;
  private readonly disclosureRetentionMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReport: InboundMailHousekeepingReport | null = null;
  /**
   * Orders the disclosure log's read-modify-write. See `sweep`.
   *
   * The log is not a snapshot of anything in memory — each write is the file's
   * own previous contents plus one entry — so the unit that has to be
   * serialised is the READ AND THE WRITE TOGETHER, not the write alone.
   */
  private readonly writes = new StoreWriteQueue();

  constructor(options: InboundMailHousekeeperOptions) {
    this.cursors = options.cursors;
    this.records = options.records;
    this.expectations = options.expectations;
    this.disclosure = new PersistentStore<HousekeepingLog>(options.disclosurePath);
    this.disclosureRetentionMs = options.disclosureRetentionMs ?? DEFAULT_DISCLOSURE_RETENTION_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** The most recent report this process produced, or null before the first sweep. */
  getLastReport(): InboundMailHousekeepingReport | null {
    return this.lastReport;
  }

  /**
   * Disclosure history from disk, newest last.
   *
   * An unreadable log is an empty history rather than an error: the log exists
   * to explain reaping, and refusing to reap because the explanation of the
   * last reap will not parse is the tail wagging the dog.
   */
  async listDisclosures(): Promise<readonly DisclosedHousekeepingReport[]> {
    const { data: log } = await this.disclosure.loadOrDiscard();
    if (!Array.isArray(log?.reports)) return [];
    // Validated by content, and bounded on the way in as well as on the way
    // out: a file claiming ten thousand reports does not become ten thousand
    // objects in memory before being cut to twenty.
    return log.reports
      .slice(-MAX_DISCLOSURE_REPORTS)
      .map(validateDisclosedHousekeepingReport)
      .filter((report): report is DisclosedHousekeepingReport => report !== null)
      .filter((report) => this.now() - report.sweptAt <= this.disclosureRetentionMs);
  }

  /**
   * One full pass over all three stores, with the result disclosed to disk.
   *
   * Each store is swept INDEPENDENTLY. They were swept in one sequential
   * expression, which made the first store's failure the second and third
   * store's failure too — one unreadable cursor file left records past their
   * retention and expired expectations sitting on disk, with no report, no
   * disclosure, and nothing anywhere saying why. Three separate attempts, three
   * separate answers, and the pass itself always produces a report.
   */
  async sweep(trigger: HousekeepingTrigger): Promise<InboundMailHousekeepingReport> {
    const failures: InboundMailSweepFailure[] = [];
    const attempt = async <T>(
      store: InboundMailSweepFailure['store'],
      run: () => Promise<T>,
    ): Promise<T | null> => {
      try {
        return await run();
      } catch (error) {
        failures.push({ store, detail: summarizeError(error) });
        return null;
      }
    };

    const cursors = await attempt('cursors', () => this.cursors.sweep(trigger));
    const records = await attempt('records', () => this.records.sweep(trigger));
    const expectations = await attempt('expectations', () => this.expectations.sweep(trigger));

    // READ AND WRITE IN ONE SERIALISED UNIT, and this is the one store here
    // where ordering the write alone would not have been enough. Every other
    // store in the daemon writes a snapshot of state it already holds in
    // memory; this log writes the FILE'S OWN previous contents plus one entry.
    // Two sweeps overlapping — the recovery sweep runs on `supervisor.start()`,
    // which a config change re-runs, while the 6-hourly timer is mid-pass —
    // therefore both read the same `existing`, both append their own entry, and
    // whichever writes second silently drops the other's. What is lost is the
    // record of a reap: files were removed and the log that exists so a deletion
    // is never indistinguishable from data loss has nothing about it.
    //
    // The report is built inside the unit too, so a failure to READ the log is
    // still in `failures` and still in the summary sentence, exactly as before.
    let report!: InboundMailHousekeepingReport;
    await this.writes.run(async () => {
      const existing = await attempt('disclosure', () => this.listDisclosures()) ?? [];
      report = {
        sweptAt: this.now(),
        trigger,
        cursors,
        records,
        expectations,
        failures,
        summary: summarize(cursors, records, expectations, failures),
      };
      this.lastReport = report;
      // Disclosure is the LAST thing and cannot take the pass down with it: a
      // sweep that reaped correctly and then could not write its own log has
      // still reaped correctly, and the caller needs to be told what happened
      // more than it needs the write to have succeeded.
      await attempt('disclosure', () => this.disclosure.persist({
        version: 1,
        // Projected, never the report itself. See `DisclosedSweep`: the report
        // carries every surviving expectation for the boot hydrator, and putting
        // those on disk made this file an unreaped duplicate of the expectation
        // store.
        //
        // `existing` came back from `listDisclosures()`, which drops entries past
        // `disclosureRetentionMs`. So the age bound is not merely a read-time
        // filter — every sweep physically rewrites the file without them, which
        // is the same "the bound applies on the write" rule the record store now
        // follows and for the same reason.
        reports: [...existing, discloseReport(report)].slice(-MAX_DISCLOSURE_REPORTS),
      }));
    });
    return report;
  }

  /**
   * The recovery pass. Runs before the watcher serves any mail, so a cursor
   * for a de-configured account, a torn record, or an already-expired
   * expectation is removed rather than honoured on the first message after a
   * restart.
   */
  async runRecoverySweep(): Promise<InboundMailHousekeepingReport> {
    return this.sweep('recovery');
  }

  /**
   * Keep sweeping on an interval. A long-lived daemon that only swept at boot
   * would never sweep at all, so this is not optional wiring. The timer is
   * unref'd so it never keeps the process alive by itself.
   */
  start(intervalMs: number): void {
    this.stop();
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.sweep('periodic').then(
        (report) => {
          if (report.failures.length === 0) return;
          logger.warn('Inbound mail housekeeping could not sweep every store', {
            surface: 'email-inbound',
            trigger: 'periodic',
            failures: report.failures.map((failure) => `${failure.store}: ${failure.detail}`),
          });
        },
        // `sweep` handles its own failures, so reaching here means the pass
        // itself broke. Swallowing it silently is how a daemon stops reaping
        // for a month and nothing anywhere says so.
        (error: unknown) => {
          logger.error('Inbound mail housekeeping failed', {
            surface: 'email-inbound',
            trigger: 'periodic',
            detail: summarizeError(error),
          });
        },
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
