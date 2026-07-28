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
import { PersistentStore } from '../../state/persistent-store.js';
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

interface HousekeepingLog extends Record<string, unknown> {
  readonly version: 1;
  readonly reports: readonly InboundMailHousekeepingReport[];
}

/** Keep the disclosure log itself bounded — it is persisted state too. */
const MAX_DISCLOSURE_REPORTS = 20;

export interface InboundMailHousekeeperOptions {
  readonly cursors: MailboxCursorStore;
  readonly records: InboundMailStore;
  readonly expectations: PersistedExpectationStore;
  /** Where the disclosure log is written. */
  readonly disclosurePath: string;
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
  const failed = failures.length === 0
    ? ''
    : ` ${String(failures.length)} store(s) could not be swept: `
      + `${failures.map((failure) => `${failure.store} (${failure.detail})`).join('; ')}.`;
  return `${head} Retained ${retained}.${corrupt}${failed}`;
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
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReport: InboundMailHousekeepingReport | null = null;

  constructor(options: InboundMailHousekeeperOptions) {
    this.cursors = options.cursors;
    this.records = options.records;
    this.expectations = options.expectations;
    this.disclosure = new PersistentStore<HousekeepingLog>(options.disclosurePath);
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
  async listDisclosures(): Promise<readonly InboundMailHousekeepingReport[]> {
    const { data: log } = await this.disclosure.loadOrDiscard();
    return Array.isArray(log?.reports) ? log.reports : [];
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

    const existing = await attempt('disclosure', () => this.listDisclosures()) ?? [];
    const report: InboundMailHousekeepingReport = {
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
      reports: [...existing, report].slice(-MAX_DISCLOSURE_REPORTS),
    }));
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
