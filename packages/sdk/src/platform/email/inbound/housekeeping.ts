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
import type { CursorSweepReport, MailboxCursorStore } from './cursor-store.js';
import type { ExpectationSweepReport, PersistedExpectationStore } from './expectation-store.js';
import type { InboundMailRecordSweepReport, InboundMailStore } from './record-store.js';
import type { HousekeepingTrigger } from './types.js';

/** What one full pass removed, across all three stores. */
export interface InboundMailHousekeepingReport {
  readonly sweptAt: number;
  readonly trigger: HousekeepingTrigger;
  readonly cursors: CursorSweepReport;
  readonly records: InboundMailRecordSweepReport;
  readonly expectations: ExpectationSweepReport;
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

function summarize(cursors: CursorSweepReport, records: InboundMailRecordSweepReport, expectations: ExpectationSweepReport): string {
  const totalRemoved = cursors.removed.length + records.removed.length + expectations.removed.length;
  if (totalRemoved === 0) {
    return `Inbound mail housekeeping: nothing to reap (${String(cursors.retained)} cursor(s), ${String(records.retained)} record(s), ${String(expectations.retained)} expectation(s) retained).`;
  }
  const parts: string[] = [];
  if (cursors.removed.length > 0) {
    const byReason = new Map<string, number>();
    for (const removal of cursors.removed) byReason.set(removal.reason, (byReason.get(removal.reason) ?? 0) + 1);
    parts.push(`${String(cursors.removed.length)} cursor(s) removed (${[...byReason].map(([reason, count]) => `${String(count)} ${reason}`).join(', ')})`);
  }
  if (records.removed.length > 0) {
    const byReason = new Map<string, number>();
    for (const removal of records.removed) byReason.set(removal.reason, (byReason.get(removal.reason) ?? 0) + 1);
    parts.push(`${String(records.removed.length)} inbound record(s) removed (${[...byReason].map(([reason, count]) => `${String(count)} ${reason}`).join(', ')})`);
  }
  if (expectations.removed.length > 0) {
    const byReason = new Map<string, number>();
    for (const removal of expectations.removed) byReason.set(removal.reason, (byReason.get(removal.reason) ?? 0) + 1);
    parts.push(`${String(expectations.removed.length)} expectation(s) removed (${[...byReason].map(([reason, count]) => `${String(count)} ${reason}`).join(', ')})`);
  }
  return `Inbound mail housekeeping: ${parts.join('; ')}. Retained ${String(cursors.retained)} cursor(s), ${String(records.retained)} record(s), ${String(expectations.retained)} expectation(s).`;
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

  /** Disclosure history from disk, newest last. */
  async listDisclosures(): Promise<readonly InboundMailHousekeepingReport[]> {
    const log = await this.disclosure.load();
    return Array.isArray(log?.reports) ? log.reports : [];
  }

  /** One full pass over all three stores, with the result disclosed to disk. */
  async sweep(trigger: HousekeepingTrigger): Promise<InboundMailHousekeepingReport> {
    const cursors = await this.cursors.sweep(trigger);
    const records = await this.records.sweep(trigger);
    const expectations = await this.expectations.sweep(trigger);
    const report: InboundMailHousekeepingReport = {
      sweptAt: this.now(),
      trigger,
      cursors,
      records,
      expectations,
      summary: summarize(cursors, records, expectations),
    };
    this.lastReport = report;
    const existing = await this.listDisclosures();
    await this.disclosure.persist({
      version: 1,
      reports: [...existing, report].slice(-MAX_DISCLOSURE_REPORTS),
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
      void this.sweep('periodic').catch(() => undefined);
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
