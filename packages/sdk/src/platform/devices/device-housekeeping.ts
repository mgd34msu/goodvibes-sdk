/**
 * device-housekeeping.ts, recovery-time and periodic garbage collection for
 * everything the paired-device feature persists.
 *
 * Two stores outlive a restart: the grants ledger (durable "always allow"
 * approvals) and the retained capture artifacts. Persistence without
 * recovery-time housekeeping does not fail loudly, it silently serves stale or
 * corrupt state forever, so both are swept on recovery AND on a timer, and
 * every sweep discloses what it removed.
 *
 * Disclosure is written to `device-housekeeping.json` beside the stores, the
 * same way the checkpoint adoption path writes `checkpoints-moved.json`: a
 * caller (or a person reading the directory) can always see what was reaped and
 * why, so a deletion is never indistinguishable from data loss.
 */
import { PersistentStore } from '../state/persistent-store.js';
import type { DeviceGrantStore, DeviceGrantSweepReport } from './device-grants.js';
import type { DeviceArtifactSweepReport, DeviceCaptureArtifactStore } from './device-capture-artifacts.js';

/** What one full pass removed, across both stores. */
export interface DeviceHousekeepingReport {
  readonly sweptAt: number;
  readonly trigger: 'recovery' | 'periodic' | 'manual';
  readonly grants: DeviceGrantSweepReport;
  readonly artifacts: DeviceArtifactSweepReport;
  /** One-line summary a surface can render without reading the itemised lists. */
  readonly summary: string;
}

interface HousekeepingLog extends Record<string, unknown> {
  readonly version: 1;
  readonly reports: readonly DeviceHousekeepingReport[];
}

/** Keep the disclosure log itself bounded, it is persisted state too. */
const MAX_DISCLOSURE_REPORTS = 20;

export interface DeviceHousekeepingOptions {
  readonly grants: DeviceGrantStore;
  readonly artifacts: DeviceCaptureArtifactStore;
  /** Where the disclosure log is written. */
  readonly disclosurePath: string;
  readonly now?: (() => number) | undefined;
}

function summarize(grants: DeviceGrantSweepReport, artifacts: DeviceArtifactSweepReport): string {
  if (grants.removed.length === 0 && artifacts.removed.length === 0) {
    return `Device housekeeping: nothing to reap (${grants.retained} grant(s), ${artifacts.retained} capture(s) retained).`;
  }
  const grantReasons = new Map<string, number>();
  for (const removal of grants.removed) grantReasons.set(removal.reason, (grantReasons.get(removal.reason) ?? 0) + 1);
  const artifactReasons = new Map<string, number>();
  for (const removal of artifacts.removed) artifactReasons.set(removal.reason, (artifactReasons.get(removal.reason) ?? 0) + 1);
  const parts: string[] = [];
  if (grants.removed.length > 0) {
    const detail = [...grantReasons].map(([reason, count]) => `${count} ${reason}`).join(', ');
    parts.push(`${grants.removed.length} grant(s) removed (${detail})`);
  }
  if (artifacts.removed.length > 0) {
    const detail = [...artifactReasons].map(([reason, count]) => `${count} ${reason}`).join(', ');
    parts.push(`${artifacts.removed.length} capture(s) removed (${detail}), ${artifacts.bytesReclaimed} bytes reclaimed`);
  }
  return `Device housekeeping: ${parts.join('; ')}. Retained ${grants.retained} grant(s), ${artifacts.retained} capture(s).`;
}

/**
 * Sweeps both device stores and records the disclosure. Construct once at
 * startup, call `runRecoverySweep()` before serving any capability request, and
 * `start()` to keep sweeping on a timer.
 */
export class DeviceHousekeeper {
  private readonly grants: DeviceGrantStore;
  private readonly artifacts: DeviceCaptureArtifactStore;
  private readonly disclosure: PersistentStore<HousekeepingLog>;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReport: DeviceHousekeepingReport | null = null;
  /** Set while a timer runs; re-read after each sweep to follow a live setting. */
  private resolveInterval: (() => number) | null = null;
  private armedIntervalMs = 0;

  constructor(options: DeviceHousekeepingOptions) {
    this.grants = options.grants;
    this.artifacts = options.artifacts;
    this.disclosure = new PersistentStore<HousekeepingLog>(options.disclosurePath);
    this.now = options.now ?? (() => Date.now());
  }

  /** The most recent report this process produced, or null before the first sweep. */
  getLastReport(): DeviceHousekeepingReport | null {
    return this.lastReport;
  }

  /** Disclosure history from disk, newest last. */
  async listDisclosures(): Promise<readonly DeviceHousekeepingReport[]> {
    const log = await this.disclosure.load();
    return Array.isArray(log?.reports) ? log.reports : [];
  }

  /** One full pass over both stores, with the result disclosed to disk. */
  async sweep(trigger: DeviceHousekeepingReport['trigger']): Promise<DeviceHousekeepingReport> {
    const grants = await this.grants.sweep();
    const artifacts = await this.artifacts.sweep();
    const report: DeviceHousekeepingReport = {
      sweptAt: this.now(),
      trigger,
      grants,
      artifacts,
      summary: summarize(grants, artifacts),
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
   * The recovery pass. Runs before any capability request is served, so a grant
   * belonging to a node that is gone, or a capture torn by a crash, is removed
   * rather than honoured on the first request after a restart.
   */
  async runRecoverySweep(): Promise<DeviceHousekeepingReport> {
    return this.sweep('recovery');
  }

  /**
   * Keep sweeping on an interval. A long-lived daemon that only swept at boot
   * would never sweep at all, so this is not optional wiring.
   *
   * Pass a resolver instead of a number to follow a live setting: the cadence is
   * re-read after every sweep and the timer re-armed when it changed, so an
   * owner who shortens `device.capture.sweepIntervalMinutes` does not have to
   * restart the daemon to get the faster sweep. A resolver that returns a
   * nonsensical cadence (zero, negative, not finite) leaves the current one in
   * place rather than stopping housekeeping altogether.
   */
  start(intervalMs: number | (() => number)): void {
    this.stop();
    this.resolveInterval = typeof intervalMs === 'function' ? intervalMs : (): number => intervalMs;
    this.arm(this.resolveInterval());
  }

  /** The cadence the live timer is running at, or null when stopped. */
  getArmedIntervalMs(): number | null {
    return this.timer ? this.armedIntervalMs : null;
  }

  private arm(intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    this.armedIntervalMs = intervalMs;
    this.timer = setInterval(() => {
      void this.sweep('periodic')
        .catch(() => undefined)
        .finally(() => { this.rearmIfCadenceChanged(); });
    }, intervalMs);
    this.timer.unref?.();
  }

  /** Follow a cadence change without waiting for a restart. */
  private rearmIfCadenceChanged(): void {
    const resolver = this.resolveInterval;
    if (!this.timer || !resolver) return;
    const next = resolver();
    if (!Number.isFinite(next) || next <= 0 || next === this.armedIntervalMs) return;
    clearInterval(this.timer);
    this.timer = null;
    this.arm(next);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.resolveInterval = null;
  }
}
