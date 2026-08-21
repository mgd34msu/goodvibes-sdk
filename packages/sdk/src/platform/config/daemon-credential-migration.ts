/**
 * daemon-credential-migration.ts, lifting credentials already stranded in a
 * surface silo up into the daemon tier.
 *
 * Routing new writes correctly fixes nothing for the person who already ran
 * setup. The owner did: they ran `/google adopt` in the agent, it reported
 * success, and the credential landed where that build put it. Telling them to
 * run it again is not a fix, and neither is a daemon that starts up next to a
 * working credential it cannot see.
 *
 * So on start, every daemon-needed credential found in any surface, project or
 * user store on this machine is copied up.
 *
 * This used to say "daemon or surface, whichever comes first". Nothing on the
 * surface side ever called it, and the claim hid the consequence: the daemon
 * enumerated only its OWN surface root, so a credential a pre-fix agent left in
 * `~/.goodvibes/agent/` was invisible to the one thing that could lift it and
 * was never lifted by anything, ever. That was the owner's exact situation.
 *
 * Both halves are now true. `listDetailedForMigration` reaches every surface's
 * silo, so the daemon alone is sufficient; and `migrateOnSurfaceStart` gives a
 * surface the same entry point, so a machine whose daemon has not run yet still
 * converges.
 *
 * The order is the whole design, and it is the same order in every case:
 *
 *   1. Read the value from the surface store.
 *   2. Write it to the daemon store.
 *   3. Read it BACK from the daemon store and compare it to what was read in
 *      step 1.
 *   4. Only then remove the surface copy.
 *
 * Step 3 is not ceremony. A daemon store that cannot be written (a read-only
 * home, a full disk, a key mismatch) fails silently enough that steps 1, 2 and
 * 4 alone would delete the only working copy of a credential and leave the
 * operator with nothing. If the read-back does not match, the source is left
 * exactly where it was and the entry is reported as `verification-failed`,
 * the credential still works, from the tier it was already in, and the next
 * start tries again.
 *
 * Idempotent by construction:
 *   - A key already in the daemon store with the SAME value: the surface copy
 *     is redundant, so it is removed and the entry reports `already-migrated`.
 *   - A key already in the daemon store with a DIFFERENT value: the daemon's
 *     own copy WINS and is never overwritten. It is the one the daemon has been
 *     running with; a stale surface copy of a rotated credential must not
 *     silently roll it back. Reported as `daemon-copy-kept`, with the surface
 *     copy left alone rather than destroyed, so nothing is lost either way.
 *   - Nothing to do: the run reports zero moves and touches no file.
 *
 * Values never appear in a result, a log line or an error. Every field here is
 * a key name, a tier name or an outcome.
 */

import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { listDaemonNeededKeyPrefixes, listExactDaemonNeededKeys } from './credential-scope-registry.js';
import type { SecretRecord, SecretScope, SecretStorageMedium } from './secrets.js';

/** What happened to one credential. */
export type CredentialMigrationOutcome =
  /** Copied up, verified readable in the daemon tier, surface copy removed. */
  | 'migrated'
  /** The daemon tier already held the same value; the redundant copy was removed. */
  | 'already-migrated'
  /** The daemon tier held a DIFFERENT value. Its copy wins; nothing was changed. */
  | 'daemon-copy-kept'
  /** The daemon copy did not read back. The source was left in place, untouched. */
  | 'verification-failed'
  /** The daemon write itself threw. The source was left in place, untouched. */
  | 'write-failed';

/** One credential's migration result. Key names and tiers only, never a value. */
export interface CredentialMigrationEntry {
  readonly key: string;
  readonly fromScope: SecretScope;
  readonly outcome: CredentialMigrationOutcome;
  /** Populated for the two failure outcomes. Never contains a value. */
  readonly detail?: string | undefined;
}

export interface CredentialMigrationReport {
  readonly entries: readonly CredentialMigrationEntry[];
  readonly migrated: number;
  readonly failed: number;
  /** True when nothing needed doing, the common case after the first run. */
  readonly noop: boolean;
}

/**
 * The slice of SecretsManager this needs. Narrow on purpose: the migration is
 * exercised against a fake in tests, and a narrow port is also the honest
 * statement of what it is allowed to do, read, write, delete, list. It cannot
 * reach the encryption keys or the store paths.
 */
export interface MigratableSecretStore {
  /**
   * Every credential a migration could move, across EVERY surface's silo.
   *
   * Not `listDetailed`, which walks only the surface this manager is rooted at.
   * That is the right question for resolution and the wrong one here: the
   * owner's Telegram token sat in the agent's store while the daemon
   * enumerated only its own, so the credential was one directory away and
   * invisible to the only code that could lift it.
   */
  listDetailedForMigration(): Promise<readonly SecretRecord[]>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { scope?: SecretScope; medium?: SecretStorageMedium }): Promise<void>;
  /**
   * Read one tier, or one exact store FILE when `storePath` is given.
   *
   * The file form is required because two surfaces both report scope `user`:
   * `~/.goodvibes/agent/secrets.enc` and `~/.goodvibes/tui/secrets.enc` are the
   * same tier and different files, so a scope-addressed read cannot say which
   * copy it got, and the read-back verification would be comparing against an
   * arbitrary one.
   */
  getFromScope(key: string, scope: SecretScope, storePath?: string): Promise<string | null>;
  /**
   * Remove ONE tier's copy.
   *
   * Deliberately NOT `delete`. `delete` is the revoke verb: for a daemon-needed
   * key it discards the caller's scope and sweeps every tier, which is right
   * for a revoke and catastrophic here, every key this module touches is
   * daemon-needed by definition, so `delete(key, { scope: source })` destroyed
   * the daemon copy that had just been written and verified, while the report
   * said `migrated: 1, failed: 0`. The port names the narrow operation so the
   * wrong one cannot be reached from here at all.
   */
  deleteFromScope(key: string, scope: SecretScope, storePath?: string): Promise<void>;
}

function isDaemonNeededStoredKey(key: string): boolean {
  if (listExactDaemonNeededKeys().includes(key)) return true;
  return listDaemonNeededKeyPrefixes().some((prefix) => key.startsWith(prefix) && key.length > prefix.length);
}

/**
 * Which stored credentials are in the wrong tier.
 *
 * Environment-backed entries are skipped: the environment is not a store, and
 * "migrating" one would mean writing a value the operator deliberately keeps
 * outside any file. Daemon-tier entries are skipped because they are home.
 */
function findStrandedCredentials(records: readonly SecretRecord[]): readonly SecretRecord[] {
  const stranded: SecretRecord[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (record.source === 'env' || record.scope === 'env') continue;
    if (record.scope === 'daemon') continue;
    if (!isDaemonNeededStoredKey(record.key)) continue;
    // Deduplicated per FILE. Keying on tier alone collapsed two surfaces'
    // stores into one entry and processed only whichever came first.
    const dedupe = `${record.key}:${record.path ?? record.scope}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    stranded.push(record);
  }
  return stranded;
}

async function migrateOne(
  store: MigratableSecretStore,
  record: SecretRecord,
): Promise<CredentialMigrationEntry> {
  const fromScope = record.scope as SecretScope;
  const base = { key: record.key, fromScope } as const;
  // Addressed by FILE, not by tier: several surfaces share the `user` tier and
  // only the path says which copy this record came from.
  const sourcePath = record.path;

  const surfaceValue = await store.getFromScope(record.key, fromScope, sourcePath);
  if (surfaceValue === null || surfaceValue.length === 0) {
    // Nothing readable there after all, another process may have moved it
    // between the listing and now. Leave it alone.
    return { ...base, outcome: 'already-migrated' };
  }

  const daemonValue = await store.getFromScope(record.key, 'daemon');
  if (daemonValue !== null && daemonValue.length > 0) {
    if (daemonValue === surfaceValue) {
      // Same credential in both tiers. The surface copy is pure duplication and
      // the daemon copy is already verified readable by this very read, so the
      // ordering guarantee is satisfied and the duplicate can go.
      await store.deleteFromScope(record.key, fromScope, sourcePath);
      return { ...base, outcome: 'already-migrated' };
    }
    // Different. The daemon has been running with ITS copy; a stale surface
    // copy of a since-rotated credential must not roll it back. Neither side is
    // destroyed, because either could be the one someone wants.
    return { ...base, outcome: 'daemon-copy-kept' };
  }

  try {
    await store.set(record.key, surfaceValue, { scope: 'daemon' });
  } catch (error) {
    return { ...base, outcome: 'write-failed', detail: summarizeError(error) };
  }

  // The read-back. Until this matches, the surface copy is the only one that
  // is known to work, and it stays.
  const readBack = await store.getFromScope(record.key, 'daemon');
  if (readBack !== surfaceValue) {
    return {
      ...base,
      outcome: 'verification-failed',
      detail: 'the daemon store did not read back what was just written to it; the surface copy was left in place',
    };
  }

  await store.deleteFromScope(record.key, fromScope, sourcePath);
  return { ...base, outcome: 'migrated' };
}

/**
 * Lift every stranded daemon-needed credential into the daemon tier.
 *
 * Safe to call on every start of every product. The common case after the
 * first run is a single `listDetailed()` and no writes at all.
 */
export async function migrateDaemonNeededCredentials(
  store: MigratableSecretStore,
): Promise<CredentialMigrationReport> {
  let records: readonly SecretRecord[];
  try {
    records = await store.listDetailedForMigration();
  } catch (error) {
    // An unreadable store is not a reason to fail a start. Report nothing moved.
    logger.warn('Credential migration: could not read the secret stores', { error: summarizeError(error) });
    return { entries: [], migrated: 0, failed: 0, noop: true };
  }

  const stranded = findStrandedCredentials(records);
  if (stranded.length === 0) return { entries: [], migrated: 0, failed: 0, noop: true };

  const entries: CredentialMigrationEntry[] = [];
  for (const record of stranded) {
    try {
      entries.push(await migrateOne(store, record));
    } catch (error) {
      entries.push({
        key: record.key,
        fromScope: record.scope as SecretScope,
        outcome: 'write-failed',
        detail: summarizeError(error),
      });
    }
  }

  const migrated = entries.filter((entry) => entry.outcome === 'migrated').length;
  const failed = entries.filter(
    (entry) => entry.outcome === 'verification-failed' || entry.outcome === 'write-failed',
  ).length;

  if (migrated > 0 || failed > 0) {
    // Disclosed, per the rule that a relocation is never silent. Key names and
    // outcomes only.
    logger.info('Credential migration: credentials the daemon needs were moved to the daemon tier', {
      migrated,
      failed,
      keys: entries.map((entry) => `${entry.key}:${entry.outcome}`),
    });
  }

  return { entries, migrated, failed, noop: migrated === 0 && failed === 0 };
}

/**
 * A durable record of what this migration did, written beside the daemon's own
 * state.
 *
 * The owner authorized this migration to run against their live tree, and
 * part of that authorization is that they never have to guess whether it
 * ran. A log line scrolls; this does not. It answers "did it run, when, and
 * what moved" from disk, months later, and it carries key NAMES, tiers and
 * outcomes, never a value.
 *
 * Rewritten on every run that changed something, so it always describes the
 * latest move rather than accumulating a history nobody reaps. A run that
 * moved nothing leaves the previous receipt alone: overwriting it with "nothing
 * to do" would destroy the record of the run that mattered.
 */
export interface CredentialMigrationReceipt {
  readonly version: 1;
  readonly at: string;
  readonly migrated: number;
  readonly failed: number;
  readonly summary: string;
  readonly entries: readonly CredentialMigrationEntry[];
}

/** Build the receipt for a run. Returns null when there is nothing to record. */
export function buildCredentialMigrationReceipt(
  report: CredentialMigrationReport,
  now: Date = new Date(),
): CredentialMigrationReceipt | null {
  if (report.entries.length === 0) return null;
  return {
    version: 1,
    at: now.toISOString(),
    migrated: report.migrated,
    failed: report.failed,
    summary: describeCredentialMigration(report),
    entries: report.entries,
  };
}

/** A one-line, safe-to-display summary. Never contains a value. */
export function describeCredentialMigration(report: CredentialMigrationReport): string {
  if (report.noop && report.entries.length === 0) return 'No credentials needed moving.';
  const parts: string[] = [];
  if (report.migrated > 0) parts.push(`${report.migrated} moved to the daemon's own store`);
  const kept = report.entries.filter((entry) => entry.outcome === 'daemon-copy-kept').length;
  if (kept > 0) parts.push(`${kept} left alone because the daemon already has a different value`);
  const already = report.entries.filter((entry) => entry.outcome === 'already-migrated').length;
  if (already > 0) parts.push(`${already} duplicate copies removed`);
  if (report.failed > 0) {
    parts.push(`${report.failed} could not be verified in the daemon store and were left where they are`);
  }
  return parts.length > 0 ? `Credentials: ${parts.join('; ')}.` : 'No credentials needed moving.';
}

/**
 * The surface-side entry point.
 *
 * Identical work, named for where it is called from. A surface running this
 * lifts credentials into the daemon tier before the daemon has ever started,
 * which is the case a fresh install hits: setup happens in a client, and the
 * daemon reads the result later.
 *
 * Safe to call on every start of every product, after the first run it is one
 * enumeration and no writes.
 */
export async function migrateOnSurfaceStart(
  store: MigratableSecretStore,
): Promise<CredentialMigrationReport> {
  return await migrateDaemonNeededCredentials(store);
}
