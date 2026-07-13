/**
 * boot.ts
 *
 * A thin public factory that wraps the daemon construction graph in ONE call.
 *
 * `DaemonServer` already self-composes its full runtime graph
 * (ConfigManager → RuntimeEventBus → runtime store → createRuntimeServices →
 * gateway/brokers/router) from a `DaemonConfig`, and installs the network
 * transport + folds legacy session stores during `start()`. This factory just
 * threads the caller's overrides in, enables the daemon with the given token,
 * starts it, and hands back a stop handle — composition, not new behavior.
 *
 * It exists so embedders and tests do not have to hand-mirror cli.ts's graph to
 * stand up a real daemon (isolated home, ephemeral port, auth round-trip).
 */

import { ConfigManager } from '../config/manager.js';
import { logger } from '../utils/logger.js';
import {
  FeatureAnnouncementStore,
  collectStartupAnnouncements,
  featureAnnouncementsPath,
} from '../runtime/feature-announcements.js';
import type { ApprovalBroker } from '../control-plane/index.js';
import { DaemonServer } from './facade.js';

export interface BootDaemonOptions {
  /** Injected home directory — the daemon stays entirely inside it. */
  readonly homeDirectory: string;
  /** Working directory (project root) the daemon operates against. */
  readonly workingDir: string;
  /** TCP port to bind. Default 0 → an OS-assigned ephemeral port. */
  readonly port?: number | undefined;
  /** Host/interface to bind. Default resolved from config (127.0.0.1). */
  readonly host?: string | undefined;
  /** Bearer token required by every route. Omit for session-based auth. */
  readonly token?: string | undefined;
  /** Daemon home dir (identity state). Defaults to the runtime resolution. */
  readonly daemonHomeDir?: string | undefined;
  /** Optional preconfigured ConfigManager; otherwise one is built from the dirs. */
  readonly configManager?: import('../config/manager.js').ConfigManager | undefined;
  /** Optional custom serve factory (tests inject Bun.serve stand-ins). */
  readonly serveFactory?: typeof Bun.serve | undefined;
  /**
   * Identity of the RUNNING artifact for the auto-update loop. Absent — the
   * default for embedded/test boots — means the host manages updates and no
   * loop starts; the SDK package version is never assumed to be the artifact.
   */
  readonly updateArtifact?: import('./facade-lifecycle.js').DaemonUpdateArtifact | undefined;
}

export interface BootedDaemon {
  /** The running daemon server. */
  readonly server: DaemonServer;
  /**
   * The daemon's shared approval broker (same instance the HTTP approvals routes
   * resolve through). Lets a proof test seed a pending approval and then exercise
   * approve/deny — including per-hunk selection — over the live wire.
   */
  readonly approvals: ApprovalBroker;
  /**
   * The daemon's canonical memory registry — the same single-writer store the HTTP
   * memory routes serve. A proof test adds a record over the wire and reads it back
   * here to confirm the write reached the canonical store, not a detached copy.
   */
  readonly memory: DaemonServer['memory'];
  /** The bound host. */
  readonly host: string;
  /** The bound TCP port (resolves an ephemeral 0 to the real port). */
  readonly port: number;
  /** Base URL for the daemon's HTTP surface. */
  readonly url: string;
  /** Stop the daemon and release the port. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Boot a fully-composed daemon in one call and return a stop handle.
 *
 * @example
 *   const daemon = await bootDaemon({ homeDirectory, workingDir, port: 0, token });
 *   // ... hit `${daemon.url}/api/...` with `Authorization: Bearer ${token}`
 *   await daemon.stop();
 */
export async function bootDaemon(options: BootDaemonOptions): Promise<BootedDaemon> {
  // Build a ConfigManager rooted at the injected dirs when the caller did not
  // supply one — this is what makes the graph self-compose from just the dirs.
  const configManager = options.configManager ?? new ConfigManager({
    workingDir: options.workingDir,
    homeDir: options.homeDirectory,
    surfaceRoot: 'goodvibes',
  });

  const server = new DaemonServer({
    port: options.port ?? 0,
    ...(options.host !== undefined ? { host: options.host } : {}),
    workingDir: options.workingDir,
    homeDirectory: options.homeDirectory,
    ...(options.daemonHomeDir !== undefined ? { daemonHomeDir: options.daemonHomeDir } : {}),
    configManager,
    ...(options.serveFactory !== undefined ? { serveFactory: options.serveFactory } : {}),
    ...(options.updateArtifact !== undefined ? { updateArtifact: options.updateArtifact } : {}),
  });

  server.enable({ daemon: true }, options.token);
  await server.start();

  // Announce-once receipts due at daemon start (e.g. the web surface URL):
  // collected against the persisted store, so each line appears exactly once
  // per install, in the daemon-start log surfaces relay.
  for (const announcement of collectStartupAnnouncements({
    configManager,
    store: new FeatureAnnouncementStore(featureAnnouncementsPath(configManager)),
  })) {
    logger.info(announcement.text, { announcement: announcement.id });
  }

  const host = server.boundHost;
  const port = server.boundPort;
  return {
    server,
    approvals: server.approvals,
    memory: server.memory,
    host,
    port,
    url: `http://${host}:${port}`,
    // Best-effort teardown, mirroring cli.ts's `Promise.allSettled` stance: a
    // subsystem that refuses to stop (e.g. a feature-gated watcher) must not
    // leave the caller unable to shut the daemon down.
    stop: async (): Promise<void> => {
      await Promise.resolve(server.stop()).catch(() => {});
    },
  };
}
