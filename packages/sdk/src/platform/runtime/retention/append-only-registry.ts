/**
 * append-only-registry.ts — the single owner of every append-only store the
 * platform writes.
 *
 * An append-only file that no one prunes grows without bound (the observed
 * 22.8 MB activity.md, unbounded agent journals). The fix is a registry: every
 * append-only store the platform writes registers here with an owner and a
 * retention policy, and a start-time janitor (runAppendOnlyRetentionSweep) owns
 * every registered path in one pass. A registry-membership check
 * (assertAppendOnlyStoreRegistered) fails LOUDLY on an unregistered id — the
 * same fail-closed discipline as the feature-gate-id and model-source checks —
 * so a new append-only store cannot ship unowned and grow forever in silence.
 *
 * The retention engine reused here is enforceFileRetention /
 * enforceJournalDirectoryRetention (age + total-size caps over append-only
 * files), the honest fit for line-appended logs — distinct from the
 * checkpoint-record RetentionPolicy engine that owns the snapshot subsystems.
 */
import {
  DEFAULT_AT_REST_POLICY,
  enforceFileRetention,
  enforceJournalDirectoryRetention,
  resolveAtRestPolicy,
  type AtRestPolicy,
} from '../at-rest-persistence.js';
import { resolveScopedDirectory } from '../surface-root.js';
import { logger } from '../../utils/logger.js';
import { join } from 'node:path';

/** Every append-only store the platform writes. Extend this when adding one. */
export type AppendOnlyStoreId =
  | 'session-journals'
  | 'activity-log'
  | 'telemetry-local-ledger'
  | 'session-recovery-snapshots';

/**
 * The roots a sweep resolves store paths from. A store whose required root is
 * absent is skipped this sweep (but stays registered, so the membership check
 * still enforces its ownership).
 */
export interface AppendOnlyRetentionRoots {
  readonly workingDirectory?: string | undefined;
  readonly surfaceRoot?: string | undefined;
  /** The user home root (holds the scoped recovery/ crash-snapshot directory). */
  readonly homeDirectory?: string | undefined;
  /** Directory holding the shared activity.md log, when the caller configured one. */
  readonly logDir?: string | undefined;
  /** Directory holding local telemetry ledger jsonl files, when configured. */
  readonly telemetryDir?: string | undefined;
}

/** The concrete on-disk targets a store resolves to for a given set of roots. */
export interface AppendOnlyStoreTargets {
  /** Directories swept for every *.jsonl file within. */
  readonly journalDirs: readonly string[];
  /** Individual files swept directly. */
  readonly files: readonly string[];
}

/** One registered append-only store: its owner, retention policy, and path resolver. */
export interface AppendOnlyStoreDescriptor {
  readonly id: AppendOnlyStoreId;
  /** The subsystem that writes this store (for diagnostics/attribution). */
  readonly owner: string;
  readonly description: string;
  /** The retention policy enforced over this store's files. */
  readonly policy: AtRestPolicy;
  /** Resolve the store's concrete targets from the roots (empty when a root is absent). */
  resolve(roots: AppendOnlyRetentionRoots): AppendOnlyStoreTargets;
}

const EMPTY_TARGETS: AppendOnlyStoreTargets = { journalDirs: [], files: [] };

/** The canonical registry. Adding an append-only writer means adding an entry here. */
export const APPEND_ONLY_STORES: readonly AppendOnlyStoreDescriptor[] = [
  {
    id: 'session-journals',
    owner: 'session/agent journal (agents/session.ts, agents/wrfc-workmap.ts)',
    description: 'per-agent transcript journals and WRFC workmaps under the scoped sessions/ directory',
    policy: DEFAULT_AT_REST_POLICY,
    resolve(roots) {
      if (!roots.workingDirectory) return EMPTY_TARGETS;
      return {
        journalDirs: [resolveScopedDirectory(roots.workingDirectory, roots.surfaceRoot, 'sessions')],
        files: [],
      };
    },
  },
  {
    id: 'activity-log',
    owner: 'shared activity logger (utils/logger.ts)',
    description: 'the shared activity.md debug log and its rotated backup',
    policy: DEFAULT_AT_REST_POLICY,
    resolve(roots) {
      if (!roots.logDir) return EMPTY_TARGETS;
      return { journalDirs: [], files: [join(roots.logDir, 'activity.md'), join(roots.logDir, 'activity.md.1')] };
    },
  },
  {
    id: 'telemetry-local-ledger',
    owner: 'local execution ledger (runtime/telemetry/exporters/local-ledger.ts)',
    description: 'local telemetry span + ledger jsonl files',
    policy: DEFAULT_AT_REST_POLICY,
    resolve(roots) {
      if (!roots.telemetryDir) return EMPTY_TARGETS;
      return { journalDirs: [roots.telemetryDir], files: [] };
    },
  },
  {
    id: 'session-recovery-snapshots',
    owner: 'per-session crash-recovery snapshots (runtime/session-persistence.ts)',
    description: 'per-session crash-recovery jsonl snapshots under the scoped recovery/ directory; a snapshot that was never restored goes stale and needs retention like any other append-only artifact',
    policy: DEFAULT_AT_REST_POLICY,
    resolve(roots) {
      if (!roots.homeDirectory) return EMPTY_TARGETS;
      return {
        journalDirs: [resolveScopedDirectory(roots.homeDirectory, roots.surfaceRoot, 'recovery')],
        files: [],
      };
    },
  },
];

const REGISTERED_IDS: ReadonlySet<string> = new Set(APPEND_ONLY_STORES.map((store) => store.id));

/** True when `id` is a registered append-only store. */
export function isAppendOnlyStoreRegistered(id: string): boolean {
  return REGISTERED_IDS.has(id);
}

/**
 * Fail-closed membership check: throw when `id` is not a registered append-only
 * store. Mirrors assertFeatureGateIdRegistered — an unregistered append-only
 * path is a defect (it would grow unowned), so it fails loudly.
 */
export function assertAppendOnlyStoreRegistered(id: string, context: string): void {
  if (REGISTERED_IDS.has(id)) return;
  throw new Error(
    `unknown append-only store id "${id}" (${context}); every append-only store the platform writes must be `
    + 'registered in APPEND_ONLY_STORES with an owner and a retention policy.',
  );
}

/** The outcome of one start-time retention sweep. */
export interface AppendOnlySweepOutcome {
  readonly sweptStores: readonly AppendOnlyStoreId[];
  readonly skippedStores: readonly AppendOnlyStoreId[];
  readonly deletedFiles: number;
  readonly reclaimedBytes: number;
}

/**
 * The start-time janitor: enforce every registered store's retention policy in
 * one pass over the paths its resolver yields for the given roots. A store
 * whose roots are absent is skipped (reported), not an error. Best-effort —
 * a failure on one store never aborts the others.
 */
export function runAppendOnlyRetentionSweep(
  roots: AppendOnlyRetentionRoots,
  options: { readonly policyOverride?: AtRestPolicy | undefined } = {},
): AppendOnlySweepOutcome {
  const swept: AppendOnlyStoreId[] = [];
  const skipped: AppendOnlyStoreId[] = [];
  let deletedFiles = 0;
  let reclaimedBytes = 0;
  for (const store of APPEND_ONLY_STORES) {
    let targets: AppendOnlyStoreTargets;
    try {
      targets = store.resolve(roots);
    } catch (error) {
      logger.warn('[retention] append-only store path resolution failed', { store: store.id, error: String(error) });
      skipped.push(store.id);
      continue;
    }
    if (targets.journalDirs.length === 0 && targets.files.length === 0) {
      skipped.push(store.id);
      continue;
    }
    const policy = options.policyOverride ?? store.policy;
    try {
      for (const dir of targets.journalDirs) {
        const outcome = enforceJournalDirectoryRetention(dir, policy);
        deletedFiles += outcome.deletedFiles.length;
        reclaimedBytes += outcome.reclaimedBytes;
      }
      if (targets.files.length > 0) {
        const outcome = enforceFileRetention(targets.files, policy);
        deletedFiles += outcome.deletedFiles.length;
        reclaimedBytes += outcome.reclaimedBytes;
      }
      swept.push(store.id);
    } catch (error) {
      logger.warn('[retention] append-only store sweep failed', { store: store.id, error: String(error) });
      skipped.push(store.id);
    }
  }
  if (deletedFiles > 0) {
    logger.info('[retention] append-only retention sweep reclaimed files', {
      deletedFiles,
      reclaimedBytes,
      sweptStores: swept,
    });
  }
  return { sweptStores: swept, skippedStores: skipped, deletedFiles, reclaimedBytes };
}

/**
 * Convenience start-time entry point wired at runtime construction: resolve the
 * at-rest policy from a config getter and run the sweep, swallowing any failure
 * so a retention problem never takes runtime startup down.
 *
 * Takes the FULL roots object: a caller that omits logDir/telemetryDir/
 * homeDirectory silently skips the activity-log, telemetry-ledger, and
 * recovery-snapshot stores every sweep — registered entries that never run.
 * The composition root passes every root it knows.
 */
export function runStartupAppendOnlySweep(
  roots: AppendOnlyRetentionRoots,
  configGet?: (key: string) => unknown,
): AppendOnlySweepOutcome | null {
  try {
    return runAppendOnlyRetentionSweep(
      roots,
      { policyOverride: configGet ? resolveAtRestPolicy(configGet) : undefined },
    );
  } catch (error) {
    logger.warn('[retention] startup append-only sweep failed', { error: String(error) });
    return null;
  }
}
