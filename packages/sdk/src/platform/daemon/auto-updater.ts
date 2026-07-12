/**
 * DaemonAutoUpdater — the daemon's hourly self-update loop.
 *
 * Owner-directed behavior: the daemon looks for updates hourly, updates when
 * found, and auto-restarts. It shares the platform's ONE update mechanism
 * (runtime/self-update.ts): download all artifacts, checksum-verify all of
 * them, then atomically swap each with the outgoing file kept at
 * `<path>.previous` for one-command rollback.
 *
 * Safety contract: a swap only ever happens at a no-active-work moment. The
 * activity probe (the daemon's real busy signal — sessions with pending
 * input / agents mid-turn) is consulted immediately before swapping; while
 * busy, the verified update is held in memory and re-attempted on a short
 * retry cadence until an idle moment arrives. A mid-turn daemon never swaps.
 *
 * Restart: when the daemon runs under the service manager, the swap is
 * followed by a non-blocking service restart. When it runs unsupervised, the
 * service manager first ADOPTS it — installs the unit and enqueues a service
 * start — and the old process exits so the supervised instance (already the
 * new binary on disk) takes over.
 *
 * Every applied update leaves a receipt ("updated from X to Y at HH:MM") in
 * the daemon log and in the receipt store surfaced on next surface connect.
 *
 * Time, network, filesystem, activity, service actions, and process exit are
 * all injectable; the whole loop is provable under test.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import {
  applyVerifiedUpdate,
  compareVersions,
  normalizeVersion,
  resolveArtifactNames,
  resolveLatestReleaseTag,
  resolveSqliteVecAsset,
  type UpdateFetchLike,
  type UpdateFileIo,
  type UpdateTarget,
} from '../runtime/self-update.js';
import { formatReceiptTime, type DaemonReceiptStore } from './receipts.js';

export interface AutoUpdateServiceActions {
  /** Whether the daemon currently runs under the platform service manager. */
  isSupervised(): boolean;
  /** Install + enable the service unit (adoption of an unsupervised daemon). */
  adoptIntoService(): void;
  /** Enqueue a non-blocking service restart. */
  restartService(): void;
}

export interface DaemonAutoUpdaterOptions {
  readonly currentVersion: string;
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** GitHub releases/latest URL used for tag resolution. */
  readonly releasesLatestUrl: string;
  /** `${releasesLatestUrl%/latest}/download/<tag>` builder override for tests. */
  readonly downloadBaseUrl?: ((tag: string) => string) | undefined;
  /** Hourly by default. */
  readonly checkIntervalMs?: number | undefined;
  /** How often to re-try a verified-but-deferred swap while the daemon is busy. */
  readonly busyRetryMs?: number | undefined;
  /** The daemon's real activity signal: true only when NO work is in flight. */
  readonly isIdle: () => boolean;
  readonly serviceActions: AutoUpdateServiceActions;
  readonly receipts: DaemonReceiptStore;
  readonly fetchImpl?: UpdateFetchLike | undefined;
  readonly io?: UpdateFileIo | undefined;
  /** Exits the current process after an unsupervised daemon is adopted. */
  readonly exitProcess?: ((code: number) => void) | undefined;
  readonly now?: (() => number) | undefined;
  readonly setTimer?: ((fn: () => void, ms: number) => ReturnType<typeof setTimeout>) | undefined;
  readonly clearTimer?: ((timer: ReturnType<typeof setTimeout>) => void) | undefined;
}

const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_BUSY_RETRY_MS = 60 * 1000;

interface PendingSwap {
  readonly tag: string;
  readonly targets: readonly UpdateTarget[];
}

export class DaemonAutoUpdater {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private checking = false;
  /** A downloaded-and-verified update waiting for an idle moment. */
  private pendingSwap: PendingSwap | null = null;

  constructor(private readonly options: DaemonAutoUpdaterOptions) {}

  private get checkIntervalMs(): number {
    return this.options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  }

  private get busyRetryMs(): number {
    return this.options.busyRetryMs ?? DEFAULT_BUSY_RETRY_MS;
  }

  /** Begin the hourly loop. The first check runs one full interval out. */
  start(): void {
    this.stopped = false;
    this.scheduleNext(this.checkIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      (this.options.clearTimer ?? clearTimeout)(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    const setTimer = this.options.setTimer ?? setTimeout;
    if (this.timer) (this.options.clearTimer ?? clearTimeout)(this.timer);
    this.timer = setTimer(() => {
      void this.tick();
    }, delayMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** One loop iteration; exposed for tests driving mocked time. */
  async tick(): Promise<void> {
    if (this.stopped || this.checking) return;
    this.checking = true;
    try {
      await this.checkAndApply();
    } catch (err) {
      logger.warn('DaemonAutoUpdater: update check failed; will retry on the next interval', {
        error: summarizeError(err),
      });
      this.pendingSwap = null;
    } finally {
      this.checking = false;
      // While a verified update waits for an idle moment, retry on the short
      // cadence; otherwise the next full interval.
      this.scheduleNext(this.pendingSwap ? this.busyRetryMs : this.checkIntervalMs);
    }
  }

  private async checkAndApply(): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? (fetch as unknown as UpdateFetchLike);

    if (!this.pendingSwap) {
      const latestTag = await resolveLatestReleaseTag(fetchImpl, this.options.releasesLatestUrl);
      if (compareVersions(this.options.currentVersion, latestTag) >= 0) {
        return; // already current
      }
      const artifacts = resolveArtifactNames(this.options.platform, this.options.arch);
      if (!artifacts) {
        logger.info('DaemonAutoUpdater: no prebuilt binaries for this platform; not self-updating', {
          platform: this.options.platform,
          arch: this.options.arch,
        });
        return;
      }
      this.pendingSwap = { tag: latestTag, targets: this.resolveTargets(artifacts.daemon, artifacts.app) };
      logger.info('DaemonAutoUpdater: update found', {
        from: normalizeVersion(this.options.currentVersion),
        to: this.pendingSwap.tag,
      });
    }

    // The no-active-work gate: consult the daemon's real activity signal
    // immediately before touching any file. A busy daemon defers the swap.
    if (!this.options.isIdle()) {
      logger.info('DaemonAutoUpdater: update ready but the daemon has active work; deferring the swap', {
        tag: this.pendingSwap.tag,
      });
      return;
    }

    const { tag, targets } = this.pendingSwap;
    const downloadBase = this.options.downloadBaseUrl
      ? this.options.downloadBaseUrl(tag)
      : defaultDownloadBaseUrl(this.options.releasesLatestUrl, tag);

    await applyVerifiedUpdate({
      fetchImpl,
      downloadBaseUrl: downloadBase,
      targets,
      ...(this.options.io ? { io: this.options.io } : {}),
      platform: this.options.platform,
    });
    this.pendingSwap = null;

    const now = this.options.now ?? Date.now;
    const from = normalizeVersion(this.options.currentVersion);
    const to = normalizeVersion(tag);
    this.options.receipts.record(`updated from ${from} to ${to} at ${formatReceiptTime(now())}`);

    this.restartIntoNewBinary();
  }

  private resolveTargets(daemonAsset: string, appAsset: string): UpdateTarget[] {
    const io = this.options.io;
    const exists = io ? io.exists.bind(io) : existsSync;
    const execDir = dirname(this.options.execPath);
    const targets: UpdateTarget[] = [
      { label: 'daemon binary', path: this.options.execPath, assetName: daemonAsset, executable: true },
    ];
    // The app binary and the sqlite-vec addon travel with the daemon: refresh
    // any that are present in the same verified pass, so an update never
    // leaves a mismatched pair installed.
    const appPath = join(execDir, 'goodvibes');
    if (exists(appPath)) {
      targets.push({ label: 'app binary', path: appPath, assetName: appAsset, executable: true });
    }
    const addon = resolveSqliteVecAsset(this.options.platform, this.options.arch);
    if (addon) {
      const addonPath = join(execDir, 'lib', addon.dirName, addon.fileName);
      if (exists(addonPath)) {
        targets.push({ label: 'vector addon', path: addonPath, assetName: addon.assetName, executable: false });
      }
    }
    return targets;
  }

  private restartIntoNewBinary(): void {
    const actions = this.options.serviceActions;
    if (actions.isSupervised()) {
      logger.info('DaemonAutoUpdater: restarting via the service manager');
      actions.restartService();
      return;
    }
    // Unsupervised: adopt into the service first, then step aside — the
    // supervised instance starts from the already-swapped new binary.
    logger.info('DaemonAutoUpdater: unsupervised daemon; adopting into the service manager and handing over');
    actions.adoptIntoService();
    (this.options.exitProcess ?? ((code: number) => process.exit(code)))(0);
  }
}

/** `https://github.com/o/r/releases/latest` -> `https://github.com/o/r/releases/download/<tag>`. */
export function defaultDownloadBaseUrl(releasesLatestUrl: string, tag: string): string {
  const base = releasesLatestUrl.replace(/\/latest\/?$/, '');
  return `${base}/download/${tag}`;
}
