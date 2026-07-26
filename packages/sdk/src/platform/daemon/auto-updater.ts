/**
 * DaemonAutoUpdater — the daemon's self-update loop.
 *
 * Owner-directed behavior: the daemon looks for updates shortly after it
 * starts and hourly after that, updates when one is found, and auto-restarts.
 * It shares the platform's ONE update mechanism: runtime/self-update.ts for
 * the download/verify/swap and runtime/update-schedule.ts for the cadence
 * (boot-settle first check, hourly steady state, short retry while busy).
 *
 * Safety contract: a swap only ever happens at a no-active-work moment. The
 * activity probe (the daemon's real busy signal — sessions with pending
 * input / agents mid-turn) is consulted immediately before swapping; while
 * busy, the verified update is held in memory and re-attempted on a short
 * retry cadence until an idle moment arrives. A mid-turn daemon never swaps.
 *
 * Restart: the swap is followed by the daemon's OWN orderly stop — the same
 * stop path a SIGTERM takes, so every shutdown hook fires on an update restart
 * instead of being skipped by a bare exit. Only then does the process hand
 * over: when the daemon runs under the service manager, a non-blocking service
 * restart; when it runs unsupervised, the service manager first ADOPTS it —
 * installs the unit and enqueues a service start — and the old process exits
 * so the supervised instance (already the new binary on disk) takes over.
 *
 * Every applied update leaves a receipt ("updated from X to Y at HH:MM") in
 * the daemon log and in the receipt store surfaced on next surface connect.
 *
 * Time, network, filesystem, activity, service actions, and process exit are
 * all injectable; the whole loop is provable under test.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { flushActivityLogSync, logger } from '../utils/logger.js';
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
import { PeriodicUpdateLoop, type PeriodicCheckOutcome } from '../runtime/update-schedule.js';
import { formatReceiptTime, type DaemonReceiptStore } from './receipts.js';
import { CLIENT_COMPATIBILITY_FLOOR } from '../control-plane/client-compatibility.js';

export interface AutoUpdateServiceActions {
  /** Whether the daemon currently runs under the platform service manager. */
  isSupervised(): boolean;
  /** Install + enable the service unit (adoption of an unsupervised daemon). */
  adoptIntoService(): void;
  /** Enqueue a non-blocking service restart. */
  restartService(): void;
}

export interface DaemonUpdateInstallLocation {
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly io?: UpdateFileIo | undefined;
}

/**
 * One installed file an update replaces (and a rollback restores).
 * `assetName` is null when this platform/arch publishes no release asset for
 * it — such a file can still be rolled back, it just cannot be downloaded.
 */
export interface DaemonInstalledFile {
  readonly label: string;
  readonly path: string;
  readonly executable: boolean;
  readonly assetName: string | null;
}

/**
 * The set of files a daemon update owns: the daemon binary, plus the app
 * binary and the sqlite-vec addon when they are installed beside it — they
 * travel with the daemon, so an update refreshes any that are present in the
 * same verified pass and never leaves a mismatched pair installed.
 *
 * One source of truth, shared by the update swap and the crash-loop rollback,
 * so the files a bad update replaced are exactly the files a rollback
 * restores.
 */
export function resolveDaemonInstalledFiles(location: DaemonUpdateInstallLocation): DaemonInstalledFile[] {
  const io = location.io;
  const exists = io ? io.exists.bind(io) : existsSync;
  const execDir = dirname(location.execPath);
  const artifacts = resolveArtifactNames(location.platform, location.arch);
  const files: DaemonInstalledFile[] = [
    { label: 'daemon binary', path: location.execPath, assetName: artifacts?.daemon ?? null, executable: true },
  ];
  const appPath = join(execDir, 'goodvibes');
  if (exists(appPath)) {
    files.push({ label: 'app binary', path: appPath, assetName: artifacts?.app ?? null, executable: true });
  }
  const addon = resolveSqliteVecAsset(location.platform, location.arch);
  if (addon) {
    const addonPath = join(execDir, 'lib', addon.dirName, addon.fileName);
    if (exists(addonPath)) {
      files.push({ label: 'vector addon', path: addonPath, assetName: addon.assetName, executable: false });
    }
  }
  return files;
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
  /** Delay before the FIRST check after start. Default 30s (boot settle). */
  readonly firstCheckDelayMs?: number | undefined;
  /** How often to re-try a verified-but-deferred swap while the daemon is busy. */
  readonly busyRetryMs?: number | undefined;
  /** The daemon's real activity signal: true only when NO work is in flight. */
  readonly isIdle: () => boolean;
  readonly serviceActions: AutoUpdateServiceActions;
  readonly receipts: DaemonReceiptStore;
  readonly fetchImpl?: UpdateFetchLike | undefined;
  readonly io?: UpdateFileIo | undefined;
  /**
   * The daemon's own orderly stop, run BEFORE the process hands over to the
   * restarted instance, so shutdown hooks fire on an update restart instead of
   * being skipped by a bare exit. Absent = nothing to wind down.
   */
  readonly stopGracefully?: (() => Promise<void> | void) | undefined;
  /** Exits the current process after an unsupervised daemon is adopted. */
  readonly exitProcess?: ((code: number) => void) | undefined;
  readonly now?: (() => number) | undefined;
  readonly setTimer?: ((fn: () => void, ms: number) => ReturnType<typeof setTimeout>) | undefined;
  readonly clearTimer?: ((timer: ReturnType<typeof setTimeout>) => void) | undefined;
}

interface PendingSwap {
  readonly tag: string;
  readonly targets: readonly UpdateTarget[];
}

export class DaemonAutoUpdater {
  private readonly loop: PeriodicUpdateLoop;
  /** A downloaded-and-verified update waiting for an idle moment. */
  private pendingSwap: PendingSwap | null = null;

  constructor(private readonly options: DaemonAutoUpdaterOptions) {
    this.loop = new PeriodicUpdateLoop({
      checkIntervalMs: options.checkIntervalMs,
      firstCheckDelayMs: options.firstCheckDelayMs,
      busyRetryMs: options.busyRetryMs,
      runCheck: async (): Promise<PeriodicCheckOutcome> => {
        await this.checkAndApply();
        return this.pendingSwap ? 'deferred' : 'settled';
      },
      onError: (error) => {
        logger.warn('DaemonAutoUpdater: update check failed; will retry on the next interval', {
          error: summarizeError(error),
        });
        this.pendingSwap = null;
      },
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
    });
  }

  /** The delay before the first check, so callers can log the schedule they got. */
  get firstCheckDelayMs(): number {
    return this.loop.firstCheckDelayMs;
  }

  /** The steady-state cadence, so callers can log the schedule they got. */
  get checkIntervalMs(): number {
    return this.loop.checkIntervalMs;
  }

  /** Begin the loop. The first check runs after a short boot-settle delay. */
  start(): void {
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  /** One loop iteration; exposed for tests driving mocked time. */
  async tick(): Promise<void> {
    await this.loop.tick();
  }

  private async checkAndApply(): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? (fetch as unknown as UpdateFetchLike);

    if (!this.pendingSwap) {
      const latestTag = await resolveLatestReleaseTag(fetchImpl, this.options.releasesLatestUrl);
      if (compareVersions(this.options.currentVersion, latestTag) >= 0) {
        return; // already current
      }
      const targets = this.resolveTargets();
      if (!targets) {
        logger.info('DaemonAutoUpdater: no prebuilt binaries for this platform; not self-updating', {
          platform: this.options.platform,
          arch: this.options.arch,
        });
        return;
      }
      this.pendingSwap = { tag: latestTag, targets };
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
    // One update, one receipt. The second sentence is here because a swap
    // replaces the DAEMON binary and nothing else: every terminal UI and agent
    // process already attached keeps running the build it started with, so the
    // owner would otherwise have to infer the restart from behavior that did
    // not change. Clients below CLIENT_COMPATIBILITY_FLOOR additionally stop
    // taking shared-session work (control-plane/client-compatibility.ts)
    // rather than only being asked to restart.
    this.options.receipts.record(
      `updated from ${from} to ${to} at ${formatReceiptTime(now())}`
      + ` — already-running goodvibes clients keep their old build until restarted;`
      + ` anything older than ${CLIENT_COMPATIBILITY_FLOOR} has stopped taking shared-session work`,
    );

    await this.restartIntoNewBinary();
  }

  /** The update targets, or null when this platform/arch publishes no assets. */
  private resolveTargets(): UpdateTarget[] | null {
    const files = resolveDaemonInstalledFiles({
      execPath: this.options.execPath,
      platform: this.options.platform,
      arch: this.options.arch,
      io: this.options.io,
    });
    const targets = files.flatMap((file) =>
      file.assetName === null
        ? []
        : [{ label: file.label, path: file.path, assetName: file.assetName, executable: file.executable }],
    );
    // The daemon binary itself must be downloadable; without it there is no
    // update to apply on this platform.
    return targets.some((target) => target.path === this.options.execPath) ? targets : null;
  }

  private async restartIntoNewBinary(): Promise<void> {
    await this.stopGracefully();
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
    // The handover record has to be on disk before this process stops being
    // one. Without it an update that goes wrong reads, in the log, as a daemon
    // that simply vanished mid-sentence.
    flushActivityLogSync();
    (this.options.exitProcess ?? ((code: number) => process.exit(code)))(0);
  }

  /**
   * The daemon's own orderly stop before handing over. A hook that throws must
   * never strand the process on the old binary, so a failure is logged and the
   * handover continues.
   */
  private async stopGracefully(): Promise<void> {
    const stop = this.options.stopGracefully;
    if (!stop) return;
    try {
      await stop();
    } catch (error) {
      logger.warn('DaemonAutoUpdater: orderly stop before the update restart failed; handing over anyway', {
        error: summarizeError(error),
      });
    }
  }
}

/** `https://github.com/o/r/releases/latest` -> `https://github.com/o/r/releases/download/<tag>`. */
export function defaultDownloadBaseUrl(releasesLatestUrl: string, tag: string): string {
  const base = releasesLatestUrl.replace(/\/latest\/?$/, '');
  return `${base}/download/${tag}`;
}
