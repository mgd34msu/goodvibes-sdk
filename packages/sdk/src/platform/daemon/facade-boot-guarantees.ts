/**
 * facade-boot-guarantees — the two things the daemon must not depend on its
 * host to have remembered.
 *
 * Both of these used to be the embedding entrypoint's job, and both were
 * silently skipped by a shipped host. They have the same shape: an omission
 * with no symptom at the point of omission, and an expensive symptom much
 * later somewhere else. Neither is detectable from inside the components that
 * suffer from it, so the daemon facade — the one construction every host goes
 * through — owns them.
 */
import { join } from 'node:path';
import { migrateDaemonOwnedConfig } from '../config/daemon-config-migration.js';
import type { ConfigManager } from '../config/manager.js';
import { ensureActivityLoggerConfigured, logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/**
 * Guarantee the shared activity logger has somewhere to write.
 *
 * The daemon is the process that runs the chat surfaces, so it is the one
 * process where "the bot token was rejected", "this surface is enabled but
 * cannot start", and "the reply had nowhere to go" are the only evidence an
 * operator will ever get. Those all go through `logger`, which discards every
 * entry until a host names a destination. One shipped daemon binary never
 * named one, and the result was a process that ran the entire channel stack
 * and said nothing about any of it for its whole lifetime — an enabled,
 * configured, inert surface and a healthy-looking daemon.
 *
 * A host that already configured a log keeps it; this never relocates one.
 */
export function ensureDaemonActivityLog(workingDirectory: string): void {
  const logDir = join(workingDirectory, '.goodvibes', 'logs');
  if (!ensureActivityLoggerConfigured(logDir)) return;
  logger.warn('DaemonServer: the host started the daemon without configuring the activity log', {
    detail: 'every platform log line before this point was discarded',
    action: 'call configureActivityLogger() in the host entrypoint; the daemon has now defaulted it',
    logDir,
  });
}

/**
 * Fold any daemon-owned key still sitting in a client store into the daemon
 * store, then re-read so the running process sees what it just moved.
 *
 * Idempotent and self-limiting: the migration records the ownership set its
 * marker covers, so a start whose owned set is unchanged does nothing. That
 * record is also what makes ownership GROWTH safe — a key promoted to
 * daemon-owned in a later release migrates on the next daemon start instead of
 * never, which is exactly how `conversationGate.*` stayed in a client file the
 * daemon does not read.
 *
 * A failure is reported and does not stop the daemon: a setting in the wrong
 * file is a bad day, a daemon that refuses to boot is a worse one.
 */
export function migrateDaemonOwnedConfigOnBoot(
  configManager: ConfigManager,
  homeDirectory: string,
): void {
  try {
    const result = migrateDaemonOwnedConfig({ homeDir: homeDirectory });
    if (!result.migrated) return;
    configManager.load();
    logger.info('DaemonServer: folded daemon-owned settings into the daemon store', {
      movedTo: result.marker.movedTo,
      moved: result.marker.moved.map((entry) => entry.key),
      discarded: result.marker.discarded.length,
      ledger: result.markerPath,
    });
  } catch (error) {
    logger.error('DaemonServer: the daemon-owned config migration failed', {
      error: summarizeError(error),
      detail: 'daemon-owned settings may still be sitting in a client store, where the daemon does not read them',
    });
  }
}
