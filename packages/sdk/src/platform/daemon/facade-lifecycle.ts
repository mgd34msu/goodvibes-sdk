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
import { DaemonAutoUpdater } from './auto-updater.js';
import { DaemonReceiptStore, formatReceiptTime } from './receipts.js';
import { recordDaemonCleanShutdown, recordDaemonStart } from './lifecycle-marker.js';
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
    run: () => new Date().toISOString(),
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
  /** Absent = host-managed updates (the safe embedded default): no auto-update loop. */
  readonly updateArtifact?: DaemonUpdateArtifact | undefined;
}

export class DaemonLifecycleRuntime {
  private autoUpdater: DaemonAutoUpdater | null = null;
  private store: DaemonReceiptStore | null = null;

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
   */
  collectReceipts(): readonly { id: string; text: string; at: number }[] {
    return this.receiptStore().consumeUndelivered().map(({ id, text, at }) => ({ id, text, at }));
  }

  /**
   * After the server is accepting: stamp the lifecycle marker (a previous
   * marker still saying "running" means the last daemon died without an
   * orderly stop — one honest crash receipt), then start the update loop.
   */
  onStarted(): void {
    try {
      const startResult = recordDaemonStart(this.markerPath());
      if (startResult.crashed) {
        this.receiptStore().record(`restarted after a crash at ${formatReceiptTime(Date.now())}`);
      }
    } catch (error) {
      logger.warn('DaemonServer: could not record the lifecycle marker', { error: summarizeError(error) });
    }
    this.startAutoUpdater();
  }

  /**
   * During stop(): halt the update loop; on a real shutdown (not a
   * config-driven in-process restart cycle) stamp the clean-shutdown marker
   * so the next start does not record a crash receipt.
   */
  onStopping(restarting: boolean): void {
    this.autoUpdater?.stop();
    this.autoUpdater = null;
    if (restarting) return;
    try {
      recordDaemonCleanShutdown(this.markerPath());
    } catch (error) {
      logger.warn('DaemonServer: could not record the clean-shutdown marker', { error: summarizeError(error) });
    }
  }

  /**
   * The hourly self-update loop. The swap only happens at a no-active-work
   * moment: the busy probe is the session broker's real pending-input count.
   */
  private startAutoUpdater(): void {
    if (this.autoUpdater) return;
    const { configManager } = this.options;
    if (configManager.get('update.auto') !== true) return;
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
    if (!releasesUrl) return;
    const intervalMinutes = Number(configManager.get('update.intervalMinutes') ?? 60);
    const serviceName = String(configManager.get('service.serviceName') ?? 'goodvibes').trim() || 'goodvibes';
    const spawnDetached = (argv: readonly string[]): void => {
      try {
        const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore' });
        child.unref();
      } catch (error) {
        logger.warn('DaemonServer: service-manager command failed to spawn', { argv, error: summarizeError(error) });
      }
    };
    this.autoUpdater = new DaemonAutoUpdater({
      currentVersion: artifact.version,
      execPath: artifact.execPath ?? process.execPath,
      platform: process.platform,
      arch: process.arch,
      releasesLatestUrl: releasesUrl,
      checkIntervalMs: Math.max(5, intervalMinutes) * 60 * 1000,
      isIdle: this.options.isIdle,
      receipts: this.receiptStore(),
      serviceActions: {
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
            logger.warn('DaemonServer: service unit install failed during update adoption', { error: summarizeError(error) });
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
      },
    });
    this.autoUpdater.start();
  }
}
