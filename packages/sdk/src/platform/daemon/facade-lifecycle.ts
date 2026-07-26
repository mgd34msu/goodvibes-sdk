/**
 * DaemonLifecycleRuntime — the daemon facade's lifecycle sidecar: the
 * clean-shutdown marker (crash detection), the persisted receipt store
 * ("updated from X to Y at HH:MM", "restarted after a crash at HH:MM"),
 * and the hourly auto-updater (owner-directed default-on; update.auto
 * turns it off).
 *
 * Kept beside facade.ts so the facade only carries thin lifecycle hooks:
 * onStarted() after the server is accepting, onStopping() during an
 * orderly stop, and collectReceipts() for the /status payload.
 */
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { ConfigManager } from '../config/manager.js';
import type { PlatformServiceManager } from './service-manager.js';
import { DaemonAutoUpdater, resolveDaemonInstalledFiles, type AutoUpdateServiceActions } from './auto-updater.js';
import { DaemonReceiptStore, formatReceiptTime } from './receipts.js';
import { FeatureAnnouncementStore, collectStartupAnnouncements, featureAnnouncementsPath } from '../runtime/feature-announcements.js';
import {
  recordDaemonAutoRollback,
  recordDaemonCleanShutdown,
  recordDaemonStart,
  recordDaemonStartAttempt,
  type LifecycleMarkerIo,
} from './lifecycle-marker.js';
import { crashLoopRollbackReceipt, decideCrashLoopRollback } from './boot-rollback.js';
import { rollbackKeptPrevious, realUpdateFileIo, type UpdateFileIo } from '../runtime/self-update.js';
import { currentProcessSignals, isCompiledBinaryInvocation } from './daemon-exec-invocation.js';
import { discoverLegacySessionSources, importLegacySessionStores } from '../control-plane/index.js';

/**
 * Boot precondition: fold legacy session stores into the home store before
 * the broker serves (idempotent; failures are logged, never fatal).
 */
export async function importLegacyDaemonSessionStores(shellPaths: {
  workingDirectory: string;
  resolveUserPath(...segments: string[]): string;
}): Promise<void> {
  await importLegacySessionStores({
    homeStorePath: shellPaths.resolveUserPath('control-plane', 'sessions.json'),
    sources: discoverLegacySessionSources({
      projectRoot: shellPaths.workingDirectory,
      companionSessionsDir: shellPaths.resolveUserPath('companion-chat', 'sessions'), // injected home
    }),
  }).catch((error: unknown) => logger.warn('DaemonServer: legacy session import failed', { error: summarizeError(error) }));
}

/**
 * The daemon heartbeat watcher: a polling watcher that stamps an ISO
 * timestamp on the configured heartbeat interval. Registered from start()
 * only when watchers are enabled; the facade stops it on shutdown.
 */
export function registerDaemonHeartbeatWatcher(
  watcherRegistry: {
    registerPollingWatcher(input: {
      id: string;
      label: string;
      source: { id: string; kind: 'watcher'; label: string; enabled: boolean; createdAt: number; updatedAt: number; metadata: Record<string, never> };
      intervalMs: number;
      run: () => string;
    }): void;
    startWatcher(id: string): void;
  },
  configManager: ConfigManager,
  onBeat?: () => void,
): void {
  watcherRegistry.registerPollingWatcher({
    id: 'daemon-heartbeat',
    label: 'Daemon heartbeat',
    source: {
      id: 'source:daemon-heartbeat',
      kind: 'watcher',
      label: 'Daemon heartbeat',
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {},
    },
    intervalMs: Number(configManager.get('watchers.heartbeatIntervalMs') ?? 30_000),
    run: () => {
      // The reachability heartbeat is also when schedule drift is reconciled:
      // a host that slept while the daemon kept running catches its missed
      // occurrences here, not only at boot. Never let a beat throw.
      if (onBeat) {
        try {
          onBeat();
        } catch (error) {
          logger.warn('Daemon heartbeat reconcile hook failed', { error: summarizeError(error) });
        }
      }
      return new Date().toISOString();
    },
  });
  watcherRegistry.startWatcher('daemon-heartbeat');
}

/**
 * Identity of the RUNNING artifact for the auto-update loop. The daemon
 * facade must never assume the SDK package is the shipped artifact: an
 * embedding host names its own version (what release tags are compared
 * against) and, optionally, the executable the swap replaces. Absent — the
 * embedded default — means the HOST manages updates: the loop stays off,
 * because comparing the SDK's package version against a host's release tags
 * is meaningless and the swap would target the wrong binary.
 */
export interface DaemonUpdateArtifact {
  /** The running artifact's own version — compared against release tags. */
  readonly version: string;
  /** The executable the verified swap replaces. Defaults to process.execPath. */
  readonly execPath?: string | undefined;
}

export interface DaemonLifecycleRuntimeOptions {
  readonly configManager: ConfigManager;
  readonly platformServiceManager: PlatformServiceManager;
  /** The daemon's real activity signal: true only when NO work is in flight. */
  readonly isIdle: () => boolean;
  /** Absent = host-managed updates (the safe embedded default): no auto-update loop AND no boot promotion. */
  readonly updateArtifact?: DaemonUpdateArtifact | undefined;
  /** Injectable process exit (boot promotion hands over by exiting); tests observe instead of dying. */
  readonly exitProcess?: ((code: number) => void) | undefined;
  /**
   * The daemon's own orderly stop, run before an update or crash-loop-rollback
   * restart hands over — so shutdown hooks fire on those restarts instead of
   * being skipped by a bare exit. Absent = nothing to wind down.
   */
  readonly stopGracefully?: (() => Promise<void> | void) | undefined;
  /** Injectable marker filesystem; tests drive the crash-loop counter in memory. */
  readonly markerIo?: LifecycleMarkerIo | undefined;
  /** Injectable swap/rename filesystem for the crash-loop rollback. */
  readonly rollbackIo?: UpdateFileIo | undefined;
  /** Injectable clock for receipts and marker stamps. */
  readonly now?: (() => number) | undefined;
  /** Injectable stderr; the crash-loop rollback says what it did before the process hands over. */
  readonly stderr?: { write(chunk: string): unknown } | undefined;
  /** Boot-promotion idle recheck cadence. Default 60s; floored at 1s. */
  readonly promotionRetryMs?: number | undefined;
  /**
   * Whether this process is a compiled single-file binary. Only a compiled
   * binary self-promotes to a supervised service — a source/dev run would write
   * a unit whose ExecStart is a dev command line that fails on the next boot.
   * Injectable for tests; defaults to the real process-signal check.
   */
  readonly isCompiledBinary?: (() => boolean) | undefined;
}

export class DaemonLifecycleRuntime {
  private autoUpdater: DaemonAutoUpdater | null = null;
  private store: DaemonReceiptStore | null = null;
  private promotionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: DaemonLifecycleRuntimeOptions) {}

  /** Lazily-created persisted store for update/crash receipts. */
  receiptStore(): DaemonReceiptStore {
    if (!this.store) {
      this.store = new DaemonReceiptStore(
        join(this.options.configManager.getControlPlaneConfigDir(), 'control-plane', 'daemon-receipts.json'),
      );
    }
    return this.store;
  }

  private markerPath(): string {
    return join(this.options.configManager.getControlPlaneConfigDir(), 'control-plane', 'daemon-lifecycle.json');
  }

  /**
   * Undelivered receipts for a consuming /status read (`?receipts=consume`);
   * marked delivered once served. The route only calls this when the reader
   * passed the explicit flag — plain status reads are receipt-neutral.
   *
   * Fired announce-once feature lines (web surface URL, first contained run)
   * ride the same exactly-once feed: they are drained from the announcement
   * store's pending queue here, so a surface reading receipts at attach
   * renders them instead of them dead-ending in the daemon log.
   */
  collectReceipts(): readonly { id: string; text: string; at: number }[] {
    const receipts = this.receiptStore().consumeUndelivered().map(({ id, text, at }) => ({ id, text, at }));
    const announcements = this.announcementStore().drainPending().map(({ id, text, at }) => ({
      id: `announcement-${id}`,
      text,
      at,
    }));
    return [...receipts, ...announcements];
  }

  /** The shared announce-once store (same file the runtime's announcers write). */
  private announcementStore(): FeatureAnnouncementStore {
    return new FeatureAnnouncementStore(featureAnnouncementsPath(this.options.configManager));
  }

  /**
   * Says it on stderr as well as in the log.
   *
   * The activity log buffers and flushes asynchronously, and every branch that
   * uses this exits the process moments later — so the log line that explains
   * why is exactly the line that gets discarded. stderr is synchronous and
   * lands wherever the daemon's output goes (the service journal, a terminal),
   * which is where an operator looks when a daemon keeps restarting. The same
   * reasoning already governs the fatal-error path in daemon/cli.ts.
   */
  private announceOnStderr(line: string): void {
    try {
      (this.options.stderr ?? process.stderr).write(`${line}\n`);
    } catch {
      // A closed/unwritable stderr must never turn a rollback into a crash.
    }
  }

  /** Marker call options honoring the injected filesystem/clock seams. */
  private markerOptions(): { io?: LifecycleMarkerIo; now?: () => number } {
    return {
      ...(this.options.markerIo ? { io: this.options.markerIo } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
    };
  }

  /**
   * The FIRST thing daemon start() does, before anything that can fail: record
   * this boot as an unconfirmed start attempt, and — when the boots before it
   * kept failing to reach a fully-started daemon — restore the kept previous
   * binary instead of repeating the same failure again.
   *
   * Returns true when the caller must ABANDON this boot: a rollback restart is
   * in flight and the process is handing over to the restored binary.
   *
   * A daemon with no update-artifact identity (host-managed updates, embedded
   * daemons, dev runs) does not own the binary on disk: it neither counts its
   * boots nor restores anything, and always returns false.
   */
  onStarting(): boolean {
    const artifact = this.options.updateArtifact;
    if (!artifact) return false;
    const threshold = Number(this.options.configManager.get('update.rollbackAfterFailedStarts') ?? 3);
    let attempt: ReturnType<typeof recordDaemonStartAttempt>;
    try {
      attempt = recordDaemonStartAttempt(this.markerPath(), this.markerOptions());
    } catch (error) {
      logger.warn('DaemonServer: could not record the start attempt — crash-loop rollback is not armed this boot', {
        error: summarizeError(error),
      });
      return false;
    }
    if (attempt.failedStarts === 0) return false;
    if (!Number.isFinite(threshold) || threshold < 1) {
      logger.warn('DaemonServer: previous boots did not reach a fully-started daemon; automatic rollback is off (update.rollbackAfterFailedStarts)', {
        failedStarts: attempt.failedStarts,
      });
      return false;
    }
    const verdict = decideCrashLoopRollback({
      failedStarts: attempt.failedStarts,
      autoRollbackAt: attempt.autoRollbackAt,
      threshold,
    });
    if (!verdict.rollback) {
      logger.warn('DaemonServer: the previous boot(s) never reached a fully-started daemon', {
        failedStarts: attempt.failedStarts,
        rollbackAfterFailedStarts: threshold,
        reason: verdict.reason,
      });
      return false;
    }
    return this.rollBackToKeptPrevious(artifact.execPath ?? process.execPath, verdict.failedStarts);
  }

  /**
   * Restore each installed file from its kept `<path>.previous` copy, leave a
   * receipt, and hand over to the restored binary. Returns false — this boot
   * continues on the current build — when there is nothing on disk to restore:
   * a rollback that did not happen must never be reported as one.
   */
  private rollBackToKeptPrevious(execPath: string, failedStarts: number): boolean {
    const targets = resolveDaemonInstalledFiles({
      execPath,
      platform: process.platform,
      arch: process.arch,
      ...(this.options.rollbackIo ? { io: this.options.rollbackIo } : {}),
    }).map(({ label, path }) => ({ label, path }));

    let result: ReturnType<typeof rollbackKeptPrevious>;
    try {
      result = rollbackKeptPrevious(targets, this.options.rollbackIo ?? realUpdateFileIo);
    } catch (error) {
      logger.error('DaemonServer: automatic rollback failed; continuing the boot on the current build', {
        failedStarts,
        error: summarizeError(error),
      });
      return false;
    }
    if (result.restored.length === 0) {
      logger.error('DaemonServer: repeated failed starts, but no kept previous version is on disk to roll back to; continuing the boot on the current build', {
        failedStarts,
        checked: targets.map((target) => target.path),
      });
      this.announceOnStderr(
        `goodvibes daemon: ${failedStarts} starts in a row did not finish, and no kept previous version is on disk to roll back to — starting this build again`,
      );
      return false;
    }

    const at = (this.options.now ?? Date.now)();
    this.receiptStore().record(crashLoopRollbackReceipt({ failedStarts, restored: result.restored, at }));
    try {
      recordDaemonAutoRollback(this.markerPath(), this.markerOptions());
    } catch (error) {
      logger.warn('DaemonServer: could not stamp the automatic rollback in the lifecycle marker', {
        error: summarizeError(error),
      });
    }
    logger.error('DaemonServer: rolled back to the kept previous version after repeated failed starts; handing over to it', {
      failedStarts,
      restored: result.restored.map((target) => target.path),
      skipped: result.skipped.map((target) => target.path),
    });
    this.announceOnStderr(
      `goodvibes daemon: ${failedStarts} starts in a row did not finish — rolled back to the kept previous version`
      + ` (${result.restored.map((target) => target.path).join(', ')}) and handing over to it`,
    );
    void this.handOverAfterRollback();
    return true;
  }

  /** The same handover the update swap uses: orderly stop first, then restart onto the restored binary. */
  private async handOverAfterRollback(): Promise<void> {
    try {
      await this.options.stopGracefully?.();
    } catch (error) {
      logger.warn('DaemonServer: orderly stop before the rollback restart failed; handing over anyway', {
        error: summarizeError(error),
      });
    }
    const actions = this.buildServiceActions();
    if (actions.isSupervised()) {
      actions.restartService();
      return;
    }
    actions.adoptIntoService();
    (this.options.exitProcess ?? ((code: number) => process.exit(code)))(0);
  }

  /**
   * After the server is accepting: stamp the lifecycle marker (a previous
   * marker still saying "running" means the last daemon died without an
   * orderly stop — one honest crash receipt; reaching here also clears the
   * failed-start streak and re-arms the automatic rollback), then start the
   * update loop.
   */
  onStarted(): void {
    try {
      const startResult = recordDaemonStart(this.markerPath(), this.markerOptions());
      if (startResult.crashed) {
        this.receiptStore().record(`restarted after a crash at ${formatReceiptTime((this.options.now ?? Date.now)())}`);
      }
    } catch (error) {
      logger.warn('DaemonServer: could not record the lifecycle marker', { error: summarizeError(error) });
    }
    // Announce-once lines due at daemon start (e.g. the web surface URL):
    // recorded here for EVERY daemon construction path (CLI, boot factory,
    // embedded). Each fired line is logged AND queued for surface delivery
    // through the consuming /status receipts read.
    try {
      for (const announcement of collectStartupAnnouncements({
        configManager: this.options.configManager,
        store: this.announcementStore(),
      })) {
        logger.info(announcement.text, { announcement: announcement.id });
      }
    } catch (error) {
      logger.warn('DaemonServer: startup announcements could not be collected', { error: summarizeError(error) });
    }
    this.startAutoUpdater();
    this.promoteToServiceAtBoot();
  }

  /**
   * During stop(): halt the update loop; on a real shutdown (not a
   * config-driven in-process restart cycle) stamp the clean-shutdown marker
   * so the next start does not record a crash receipt.
   */
  onStopping(restarting: boolean): void {
    this.autoUpdater?.stop();
    this.autoUpdater = null;
    if (this.promotionTimer) {
      clearInterval(this.promotionTimer);
      this.promotionTimer = null;
    }
    if (restarting) return;
    try {
      recordDaemonCleanShutdown(this.markerPath(), this.markerOptions());
    } catch (error) {
      logger.warn('DaemonServer: could not record the clean-shutdown marker', { error: summarizeError(error) });
    }
  }

  /**
   * The self-update loop: a first check shortly after boot, then the
   * configured cadence. The swap only happens at a no-active-work moment: the
   * busy probe is the session broker's real pending-input count.
   *
   * EVERY gate that leaves the loop off logs why. A daemon that quietly never
   * updates is indistinguishable from one that has nothing to update to, and
   * the log is the only place an owner can tell those apart.
   */
  private startAutoUpdater(): void {
    if (this.autoUpdater) return;
    const { configManager } = this.options;
    const auto = configManager.get('update.auto');
    if (auto !== true) {
      logger.info('DaemonServer: auto-update loop off — update.auto is not true; this daemon will not update itself', {
        'update.auto': auto,
      });
      return;
    }
    const artifact = this.options.updateArtifact;
    if (!artifact) {
      // No artifact identity was provided (the embedded default): the host
      // manages its own updates. Never fall back to the SDK package version —
      // comparing it against the host's release tags would be meaningless and
      // the swap would replace the wrong executable. Logged so an operator
      // who set update.auto sees why no loop is running.
      logger.info('DaemonServer: auto-update loop off — no update artifact identity provided (host-managed updates)');
      return;
    }
    const releasesUrl = String(configManager.get('update.releasesUrl') ?? '').trim();
    if (!releasesUrl) {
      logger.info('DaemonServer: auto-update loop off — update.releasesUrl is empty, so there is nowhere to resolve release tags from');
      return;
    }
    const intervalMinutes = Number(configManager.get('update.intervalMinutes') ?? 60);
    const firstCheckSeconds = Number(configManager.get('update.firstCheckSeconds') ?? 30);
    const updater = new DaemonAutoUpdater({
      currentVersion: artifact.version,
      execPath: artifact.execPath ?? process.execPath,
      platform: process.platform,
      arch: process.arch,
      releasesLatestUrl: releasesUrl,
      checkIntervalMs: Math.max(5, intervalMinutes) * 60 * 1000,
      firstCheckDelayMs: Math.max(0, Number.isFinite(firstCheckSeconds) ? firstCheckSeconds : 30) * 1000,
      isIdle: this.options.isIdle,
      receipts: this.receiptStore(),
      serviceActions: this.buildServiceActions(),
      ...(this.options.stopGracefully ? { stopGracefully: this.options.stopGracefully } : {}),
    });
    this.autoUpdater = updater;
    updater.start();
    // The positive case is logged too: "no update happened" should be
    // readable as either "the loop never ran" or "the loop ran and found
    // nothing", never a guess between them.
    logger.info('DaemonServer: auto-update loop armed', {
      currentVersion: artifact.version,
      releasesUrl,
      firstCheckInMs: updater.firstCheckDelayMs,
      thenEveryMs: updater.checkIntervalMs,
    });
  }

  /** The service-manager actions shared by the update swap and boot promotion. */
  private buildServiceActions(): AutoUpdateServiceActions {
    const serviceName = String(this.options.configManager.get('service.serviceName') ?? 'goodvibes').trim() || 'goodvibes';
    const spawnDetached = (argv: readonly string[]): void => {
      try {
        const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore' });
        child.unref();
      } catch (error) {
        logger.warn('DaemonServer: service-manager command failed to spawn', { argv, error: summarizeError(error) });
      }
    };
    return {
      isSupervised: () => {
        try {
          const status = this.options.platformServiceManager.status();
          return status.installed && status.running;
        } catch {
          return false;
        }
      },
      adoptIntoService: () => {
        // Adoption: write the unit (with the survival contract) and enqueue
        // a start. The old process exits right after; if the first start
        // races the dying listener, Restart=on-failure retries until the
        // port is free.
        try {
          const installed = this.options.platformServiceManager.install();
          if (installed.lingerNote) logger.info(`DaemonServer: ${installed.lingerNote}`);
        } catch (error) {
          logger.warn('DaemonServer: service unit install failed during adoption', { error: summarizeError(error) });
          return;
        }
        if (process.platform === 'linux') {
          spawnDetached(['systemctl', '--user', 'daemon-reload']);
          spawnDetached(['systemctl', '--user', '--no-block', 'enable', '--now', `${serviceName}.service`]);
        }
      },
      restartService: () => {
        if (process.platform === 'linux') {
          // Non-blocking: the restart job outlives this process, which
          // systemd stops as part of the restart.
          spawnDetached(['systemctl', '--user', '--no-block', 'restart', `${serviceName}.service`]);
          return;
        }
        // launchd (KeepAlive=true) and manual supervision both respawn the
        // (already-swapped) binary when this process exits cleanly.
        process.exit(0);
      },
    };
  }

  /**
   * Boot-edge service promotion, independent of updates: a STANDALONE
   * unsupervised daemon (spawned detached by a surface) installs its service
   * unit and hands over to the supervised instance at its first idle moment
   * — a freshly-spawned daemon at the latest version no longer stays
   * unref()'d forever waiting for an update swap to promote it. Embedded
   * daemons (no updateArtifact identity) never self-promote: exiting would
   * kill the host process. service.enabled=false opts out; a platform
   * without a service manager is left alone.
   */
  private promoteToServiceAtBoot(): void {
    if (!this.options.updateArtifact) return;
    if (this.options.configManager.get('service.enabled') === false) return;
    // Only a compiled binary may self-promote: a source/dev run would install a
    // unit whose ExecStart reconstructs a dev command line for a binary and fail
    // on the next boot. A dev checkout stays session-only.
    const isCompiled = this.options.isCompiledBinary ?? (() => isCompiledBinaryInvocation(currentProcessSignals()));
    if (!isCompiled()) {
      logger.info('DaemonServer: source/dev run — skipping boot promotion (only a compiled binary self-promotes)');
      return;
    }
    let status: { installed: boolean; running: boolean };
    try {
      status = this.options.platformServiceManager.status();
    } catch {
      return; // no service manager on this platform — nothing to promote into
    }
    if (status.installed && status.running) return; // already supervised
    const actions = this.buildServiceActions();
    const exitProcess = this.options.exitProcess ?? ((code: number) => process.exit(code));
    const attempt = (): boolean => {
      if (!this.options.isIdle()) return false;
      logger.info('DaemonServer: unsupervised daemon — installing the service unit and handing over (boot promotion)');
      actions.adoptIntoService();
      exitProcess(0);
      return true;
    };
    if (attempt()) return;
    // Busy at boot (e.g. sessions reconnected immediately): keep checking for
    // the same idle moment the update swap waits for. The timer never keeps
    // the process alive and stops with the lifecycle.
    const retryMs = Math.max(1_000, this.options.promotionRetryMs ?? 60_000);
    this.promotionTimer = setInterval(() => {
      if (attempt() && this.promotionTimer) {
        clearInterval(this.promotionTimer);
        this.promotionTimer = null;
      }
    }, retryMs);
    (this.promotionTimer as { unref?: () => void }).unref?.();
  }
}
