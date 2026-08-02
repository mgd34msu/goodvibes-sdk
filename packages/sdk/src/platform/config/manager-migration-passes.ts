/**
 * manager-migration-passes.ts — the load-time settings-file migration passes
 * ConfigManager runs (extracted so manager.ts stays under the line cap; the
 * behavior lives here verbatim). Each pass is invisible: the file rewrites
 * once, a one-line receipt rides the announce-once queue, and an unwritable
 * file keeps the in-memory result (idempotent re-run next start).
 */
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import {
  migrateControlPlaneBaseUrlRemoval,
  migrateDaemonEmbedInProcessRemoval,
  migrateDangerDaemonAlias,
  migrateFleetMaxSizeRename,
  migrateLegacyFeatureToggles,
  migratePaymentsBudgetAmounts,
} from './migrations.js';
import { isFrozenDefaultDump, stripFrozenDefaults } from './settings-io.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** Announce-once receipt sink (the manager binds FeatureAnnouncementStore.record). */
export type MigrationReceiptSink = (id: string, text: string) => void;

function persistMigratedFile(sourcePath: string, config: Record<string, unknown>, label: string): void {
  try {
    // Atomic: a migration rewrites the whole settings file, and a torn one
    // would leave the reader a file that parses as neither shape.
    writeJsonFileAtomic(sourcePath, config);
  } catch (err) {
    logger.warn(`${label} could not be persisted to ${sourcePath}: ${summarizeError(err)}`);
  }
}

/** danger.daemon=false → daemon.enabled=false (the removed alias's off-switch is honored). */
export function applyDangerDaemonMigrationPass(parsed: Record<string, unknown>, sourcePath: string): Record<string, unknown> {
  const result = migrateDangerDaemonAlias(parsed);
  if (result.rewroteDaemonEnabledFalse) {
    logger.info(
      `Migrated deprecated 'danger.daemon: false' to 'daemon.enabled: false' (${sourcePath}). ` +
      `The legacy off-switch is preserved; 'danger.daemon' is no longer read.`,
    );
  }
  return result.config;
}

/** Legacy featureFlags entries dissolve onto their domain settings keys, with a receipt. */
export function applyLegacySettingsMigrationPass(
  parsed: Record<string, unknown>,
  sourcePath: string,
  receipt: MigrationReceiptSink,
): Record<string, unknown> {
  const result = migrateLegacyFeatureToggles(parsed);
  if (!result.migrated) return parsed;
  persistMigratedFile(sourcePath, result.config, 'Settings migration');
  const keyList = result.changedKeys.length > 0 ? result.changedKeys.join(', ') : 'no value changes';
  const receiptText = `Settings migrated: legacy featureFlags entries now live on their domain settings keys (${keyList}) in ${sourcePath}.`;
  logger.info(receiptText);
  try {
    receipt(`settings-migration-feature-toggles:${sourcePath}`, receiptText);
  } catch (err) {
    logger.warn(`Settings-migration receipt could not be queued: ${summarizeError(err)}`);
  }
  if (result.unknownIds.length > 0) {
    logger.warn(`Settings migration dropped unknown legacy entries: ${result.unknownIds.join(', ')} (${sourcePath}).`);
  }
  return result.config;
}

/** orchestration.maxActiveAgents → fleet.maxSize ("Maximum fleet size"), with a receipt. */
export function applyFleetMaxSizeMigrationPass(
  parsed: Record<string, unknown>,
  sourcePath: string,
  receipt: MigrationReceiptSink,
): Record<string, unknown> {
  const result = migrateFleetMaxSizeRename(parsed);
  if (!result.migrated) return parsed;
  persistMigratedFile(sourcePath, result.config, 'fleet.maxSize migration');
  const receiptText = `Setting renamed: orchestration.maxActiveAgents is now fleet.maxSize ("Maximum fleet size"); your value (${result.movedValue}) moved with it (${sourcePath}).`;
  logger.info(receiptText);
  try {
    receipt(`settings-migration-fleet-max-size:${sourcePath}`, receiptText);
  } catch (err) {
    logger.warn(`fleet.maxSize migration receipt could not be queued: ${summarizeError(err)}`);
  }
  return result.config;
}

/** controlPlane.baseUrl (a stored mirror of a derivable URL) is dropped, with a receipt. */
export function applyControlPlaneBaseUrlMigrationPass(
  parsed: Record<string, unknown>,
  sourcePath: string,
  receipt: MigrationReceiptSink,
): Record<string, unknown> {
  const result = migrateControlPlaneBaseUrlRemoval(parsed);
  if (!result.migrated) return parsed;
  persistMigratedFile(sourcePath, result.config, 'controlPlane.baseUrl removal');
  const quoted = result.removedValue ? ` (it was ${result.removedValue})` : '';
  const receiptText =
    `Setting removed: controlPlane.baseUrl${quoted} is gone from ${sourcePath}. `
    + 'The control-plane URL is now derived from hostMode/host/port/tls.mode, so it always matches '
    + 'the real bind. If you meant a tunnel or reverse-proxy address, declare it in '
    + 'controlPlane.publicBaseUrl.';
  logger.info(receiptText);
  try {
    receipt(`settings-migration-control-plane-base-url:${sourcePath}`, receiptText);
  } catch (err) {
    logger.warn(`controlPlane.baseUrl removal receipt could not be queued: ${summarizeError(err)}`);
  }
  return result.config;
}

/** Strip previously-frozen defaults from a whole-config dump (sparse files untouched), with a receipt. */
export function applyDefaultStripMigrationPass(
  parsed: Record<string, unknown>,
  sourcePath: string,
  receipt: MigrationReceiptSink,
): Record<string, unknown> {
  if (!isFrozenDefaultDump(parsed)) return parsed;
  const { config: stripped, changed } = stripFrozenDefaults(parsed);
  if (!changed) return parsed;
  try {
    writeJsonFileAtomic(sourcePath, stripped);
  } catch (err) {
    logger.warn(`Settings default-strip could not be persisted to ${sourcePath}: ${summarizeError(err)}`);
    return stripped;
  }
  const receiptText = `Settings tidied: previously-frozen default values were removed from ${sourcePath}; only your explicit settings remain on disk.`;
  logger.info(receiptText);
  try {
    receipt(`settings-defaults-stripped:${sourcePath}`, receiptText);
  } catch (err) {
    logger.warn(`Settings default-strip receipt could not be queued: ${summarizeError(err)}`);
  }
  return stripped;
}

/** daemon.embedInProcess (a choice no surface could act on) is dropped, with a receipt. */
export function applyDaemonEmbedInProcessMigrationPass(
  parsed: Record<string, unknown>,
  sourcePath: string,
  receipt: MigrationReceiptSink,
): Record<string, unknown> {
  const result = migrateDaemonEmbedInProcessRemoval(parsed);
  if (!result.migrated) return parsed;
  persistMigratedFile(sourcePath, result.config, 'daemon.embedInProcess removal');
  const quoted = result.removedValue === undefined ? '' : ` (it was ${String(result.removedValue)})`;
  const receiptText =
    `Setting removed: daemon.embedInProcess${quoted} is gone from ${sourcePath}. `
    + 'It offered a choice no surface could act on — every product adopts a running daemon, and that '
    + 'is decided before any embed preference is read, so the value never changed what happened. '
    + 'Hosting a daemon inside another process remains available to an embedder composing one '
    + 'directly; it is not a setting. Nothing about how your daemon runs changes.';
  logger.info(receiptText);
  try {
    receipt(`settings-migration-daemon-embed-in-process:${sourcePath}`, receiptText);
  } catch (err) {
    logger.warn(`daemon.embedInProcess removal receipt could not be queued: ${summarizeError(err)}`);
  }
  return result.config;
}

/**
 * The payments budget amounts move onto their new names, with their numbers
 * converted, and a receipt naming every key and both values.
 *
 * These four settings used to be named for — and stored as — the count of the
 * currency's smallest division, so a hundred was written `10000` and a limit
 * was one missing zero away from being a hundred times what its owner meant.
 * They now hold the amount itself. The receipt quotes what each key was and
 * what it is, because a spending limit silently changing shape is the one thing
 * this migration must never do quietly.
 */
export function applyPaymentsBudgetMigrationPass(
  parsed: Record<string, unknown>,
  sourcePath: string,
  receipt: MigrationReceiptSink,
): Record<string, unknown> {
  const result = migratePaymentsBudgetAmounts(parsed);
  if (!result.migrated) return parsed;
  persistMigratedFile(sourcePath, result.config, 'payments budget migration');
  const moved = result.moves
    .map((move) => `${move.from} ${move.oldValue} is now ${move.to} ${move.newValue}`)
    .join('; ');
  const receiptText =
    `Settings renamed: your payment limits now hold the amount you would say out loud, `
    + `so you enter 100 for a hundred and 19.99 for nineteen ninety-nine. `
    + `${moved} (${sourcePath}). Your limits are unchanged — only how they are written.`;
  logger.info(receiptText);
  try {
    receipt(`settings-migration-payments-budget-amounts:${sourcePath}`, receiptText);
  } catch (err) {
    logger.warn(`payments budget migration receipt could not be queued: ${summarizeError(err)}`);
  }
  return result.config;
}

/**
 * Every load-time pass, in order, over one parsed settings file.
 *
 * The order lives here rather than at the call site because it is a property of
 * the passes: each runs on the output of the one before it, and the default-strip
 * pass has to come last so it sees the shape the others leave behind.
 */
export function runLoadMigrationPasses(
  parsed: Record<string, unknown>,
  sourcePath: string,
  receipt: MigrationReceiptSink,
): Record<string, unknown> {
  let config = applyDangerDaemonMigrationPass(parsed, sourcePath);
  config = applyLegacySettingsMigrationPass(config, sourcePath, receipt);
  config = applyFleetMaxSizeMigrationPass(config, sourcePath, receipt);
  config = applyControlPlaneBaseUrlMigrationPass(config, sourcePath, receipt);
  config = applyDaemonEmbedInProcessMigrationPass(config, sourcePath, receipt);
  config = applyPaymentsBudgetMigrationPass(config, sourcePath, receipt);
  return applyDefaultStripMigrationPass(config, sourcePath, receipt);
}
