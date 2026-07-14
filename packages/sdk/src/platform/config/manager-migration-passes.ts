/**
 * manager-migration-passes.ts — the load-time settings-file migration passes
 * ConfigManager runs (extracted so manager.ts stays under the line cap; the
 * behavior lives here verbatim). Each pass is invisible: the file rewrites
 * once, a one-line receipt rides the announce-once queue, and an unwritable
 * file keeps the in-memory result (idempotent re-run next start).
 */
import { writeFileSync } from 'fs';
import { migrateDangerDaemonAlias, migrateFleetMaxSizeRename, migrateLegacyFeatureToggles } from './migrations.js';
import { isFrozenDefaultDump, stripFrozenDefaults } from './settings-io.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** Announce-once receipt sink (the manager binds FeatureAnnouncementStore.record). */
export type MigrationReceiptSink = (id: string, text: string) => void;

function persistMigratedFile(sourcePath: string, config: Record<string, unknown>, label: string): void {
  try {
    writeFileSync(sourcePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
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
    writeFileSync(sourcePath, JSON.stringify(stripped, null, 2) + '\n', 'utf-8');
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
