/**
 * facade-boot-guarantees — the things the daemon must not depend on its host to
 * have remembered.
 *
 * Both of these used to be the embedding entrypoint's job, and both were
 * silently skipped by a shipped host. They have the same shape: an omission
 * with no symptom at the point of omission, and an expensive symptom much
 * later somewhere else. Neither is detectable from inside the components that
 * suffer from it, so the daemon facade — the one construction every host goes
 * through — owns them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { migrateDaemonOwnedConfig } from '../config/daemon-config-migration.js';
import type { SweepableSecrets } from '../config/plaintext-credential-sweep.js';
import {
  buildCredentialMigrationReceipt,
  describeCredentialMigration,
  migrateDaemonNeededCredentials,
  type MigratableSecretStore,
} from '../config/daemon-credential-migration.js';
import { DAEMON_CONFIG_ROOT } from '../config/daemon-config-tier.js';
import { ensureConnectorConfigSections } from '../config/connector-config-sections.js';
import { describePlaintextSweep, sweepPlaintextCredentials } from '../config/plaintext-credential-sweep.js';
import { repairHalfLandedGoogleConnection } from '../google/connection-repair.js';
import { nodeGoogleFilePort } from '../google/node.js';
import { resolveSharedDirectory } from '../runtime/surface-root.js';
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

/**
 * Lift any credential the daemon needs out of the surface silo it was captured
 * in, into the daemon's own store.
 *
 * The config sibling above moves SETTINGS. This moves the credentials those
 * settings point at, and it exists because routing new writes correctly does
 * nothing for the person who already ran setup. The owner did: `/google adopt`
 * reported success in the agent, and the daemon answering Telegram — with the
 * agent closed — said no email integration was available.
 *
 * Ordering is the safety property, and it is enforced in the migration itself:
 * the surface copy is removed only after the daemon copy has been read BACK and
 * compared. A daemon store that cannot be written leaves the credential exactly
 * where it is and working, and the next start tries again.
 *
 * A failure is reported and does not stop the daemon, for the same reason the
 * config migration does not: a credential in the wrong tier is a bad day, a
 * daemon that refuses to boot is a worse one.
 */
export async function migrateDaemonNeededCredentialsOnBoot(
  secrets: MigratableSecretStore,
  homeDirectory?: string,
): Promise<void> {
  try {
    const report = await migrateDaemonNeededCredentials(secrets);
    if (report.noop && report.entries.length === 0) return;
    logger.info('DaemonServer: moved credentials the daemon needs into the daemon store', {
      summary: describeCredentialMigration(report),
      // Key names and outcomes only; a value never appears in a log line.
      entries: report.entries.map((entry) => `${entry.key}:${entry.fromScope}->${entry.outcome}`),
    });
    // A log line scrolls. The receipt does not: it answers "did it run, when,
    // and what moved" from disk months later. Key names and outcomes only.
    if (homeDirectory !== undefined) writeCredentialMigrationReceipt(report, homeDirectory);
  } catch (error) {
    logger.error('DaemonServer: the daemon credential migration failed', {
      error: summarizeError(error),
      detail: 'a credential the daemon needs may still be sitting in a surface store, where the daemon does not read it',
    });
  }
}

/** Where the receipt lives: beside the daemon's own state, not in a surface silo. */
export function credentialMigrationReceiptPath(homeDirectory: string): string {
  return resolveSharedDirectory(homeDirectory, DAEMON_CONFIG_ROOT, 'credentials-moved.json');
}

/**
 * Write the receipt, best-effort.
 *
 * A receipt that cannot be written must not undo a migration that already
 * succeeded, so this reports and returns rather than throwing. The credential
 * is where it needs to be either way; what is lost is the paperwork.
 */
function writeCredentialMigrationReceipt(
  report: Parameters<typeof buildCredentialMigrationReceipt>[0],
  homeDirectory: string,
): void {
  const receipt = buildCredentialMigrationReceipt(report);
  if (receipt === null) return;
  const path = credentialMigrationReceiptPath(homeDirectory);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, 'utf-8');
  } catch (error) {
    logger.warn('DaemonServer: could not record what the credential migration moved', {
      path,
      error: summarizeError(error),
      detail: 'the credentials were still moved; only the on-disk record of it failed',
    });
  }
}

/**
 * Every boot guarantee, in the order they depend on each other.
 *
 * One call rather than three at the call site, because the ORDER matters and a
 * host reading three separate lines cannot see that: the log has to exist
 * before anything can report, the settings have to move before the credentials
 * they point at, and both have to finish before anything resolves a credential.
 */
export async function runDaemonBootGuarantees(
  configManager: ConfigManager,
  services: DaemonBootServices,
): Promise<void> {
  ensureDaemonActivityLog(services.shellPaths.workingDirectory);
  migrateDaemonOwnedConfigOnBoot(configManager, services.shellPaths.homeDirectory);
  await migrateDaemonNeededCredentialsOnBoot(services.secretsManager, services.shellPaths.homeDirectory);
  await repairGoogleConnectionOnBoot(configManager, services);
  await sweepPlaintextCredentialsOnBoot(configManager, services);
}

/**
 * Move any credential still sitting literally in a config file into the store.
 *
 * The write paths that produced these are closed, which does nothing for the
 * values already written. See config/plaintext-credential-sweep.ts for the
 * ordering that makes this safe: a literal is replaced by a reference only
 * after the store has been read back and matched.
 */
async function sweepPlaintextCredentialsOnBoot(
  configManager: ConfigManager,
  services: DaemonBootServices,
): Promise<void> {
  try {
    ensureConnectorConfigSections(configManager);
    const manager = configManager as unknown as { get(key: string): unknown; setDynamic(key: string, value: unknown): void };
    const report = await sweepPlaintextCredentials(
      { get: (key) => manager.get(key), set: (key, value) => { manager.setDynamic(key, value); } },
      services.secretsManager,
    );
    if (report.noop) return;
    logger.info('DaemonServer: credentials stored in the clear were moved into the secret store', {
      summary: describePlaintextSweep(report),
      entries: report.entries.map((entry) => `${entry.configKey}:${entry.outcome}`),
    });
  } catch (error) {
    logger.warn('DaemonServer: the plaintext credential sweep failed', {
      error: summarizeError(error),
      detail: 'a credential may still be stored in the clear in a settings file',
    });
  }
}

/**
 * Finish a Google setup that only half landed.
 *
 * The migration above moves credentials between tiers. It cannot help a
 * connection whose config half never reached ANY tier, which is the state
 * `/google adopt` left on the owner's machine: the secret stored, the client id
 * that goes with it nowhere, and a daemon reporting no account connected while
 * being told the setup had succeeded.
 *
 * Runs only where a Google credential is already stored — finishing what a
 * person started, never starting one for them. See google/connection-repair.ts.
 */
async function repairGoogleConnectionOnBoot(
  configManager: ConfigManager,
  services: DaemonBootServices,
): Promise<void> {
  try {
    ensureConnectorConfigSections(configManager);
    const manager = configManager as unknown as { get(key: string): unknown; setDynamic(key: string, value: unknown): void };
    const result = await repairHalfLandedGoogleConnection({
      files: nodeGoogleFilePort,
      config: { get: (key) => manager.get(key), set: (key, value) => { manager.setDynamic(key, value); } },
      secrets: {
        get: (key) => services.secretsManager.get(key),
        set: (key, value) => services.secretsManager.set(key, value),
      },
      homeDirectory: services.shellPaths.homeDirectory,
    });
    if (result.outcome === 'already-connected' || result.outcome === 'nothing-to-repair') return;
    logger.info('DaemonServer: completed a Google setup that had only half landed', {
      outcome: result.outcome,
      detail: result.detail,
    });
  } catch (error) {
    logger.warn('DaemonServer: could not complete a half-landed Google setup', {
      error: summarizeError(error),
      detail: 'the daemon may still report no Google account connected while a credential for one is stored',
    });
  }
}

/**
 * What the guarantees need from the runtime, structurally.
 *
 * Structural rather than a `RuntimeServices` import so this module keeps the
 * narrow surface it has: it takes a secret store it can list, read, write and
 * delete through, and two directory paths. Nothing else.
 */
export interface DaemonBootServices {
  readonly secretsManager: MigratableSecretStore & SweepableSecrets;
  readonly shellPaths: { readonly workingDirectory: string; readonly homeDirectory: string };
}
