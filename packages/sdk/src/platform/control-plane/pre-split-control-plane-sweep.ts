/**
 * pre-split-control-plane-sweep.ts — the boot-time sweep that ends the
 * two-control-plane-stores condition on a machine that ran a pre-split daemon.
 *
 * ── What was actually on disk ─────────────────────────────────────────────
 *
 * Every piece of the daemon's own state is supposed to live under
 * `.goodvibes/<surface root>/` (see the daemon's config/surface.ts). Its
 * session broker does: it is constructed on
 * `resolveProjectPath(surfaceRoot, 'control-plane', 'sessions.json')`, which on
 * an owner install is `~/.goodvibes/tui/control-plane/sessions.json`.
 *
 * The boot-time legacy fold did not. `importLegacyDaemonSessionStores` folded
 * every pre-existing session store into `resolveUserPath('control-plane',
 * 'sessions.json')` — no surface segment, because `resolveUserPath` never adds
 * one; the segment is always the caller's to pass. So the fold's TARGET was
 * `~/.goodvibes/control-plane/sessions.json`, a path the broker has never read
 * from. It is written unconditionally on every boot (the importer persists even
 * when it merged nothing), which is why the stale store's mtime is the second
 * the current daemon started, and why it looks alive to anyone who checks.
 *
 * The result on the owner's machine: two session stores, both plausible, both
 * recently written, disagreeing. The pre-split one held 274 KB of sessions the
 * live 55 KB store did not have, and nothing read it.
 *
 * ── What this sweep does, and what it deliberately does not ───────────────
 *
 * Two things live at the legacy path, and they need opposite treatment:
 *
 *  - A file that ALSO exists in the live store is a DUPLICATE, and a duplicate
 *    that disagrees is the whole defect. Its contents are folded forward into
 *    the live store where a folder exists for its kind (today: sessions.json,
 *    via the id-keyed merge in session-store-importer.ts, so a re-run is a
 *    no-op), and the file is then moved aside into a quarantine directory with
 *    a receipt naming it. After that there is one store, not two.
 *
 *  - A file that exists ONLY at the legacy path is not a second store — it is
 *    the only copy of live state, written by a composition root that still
 *    resolves that path (occasions-state.json and workspace-registrations.json
 *    are the two on the owner's machine, and the latter was written the day
 *    before this was found). Moving those aside would not fix a disagreement;
 *    it would delete working state. They are LEFT WHERE THEY ARE and named in
 *    the receipt, so the remaining condition is disclosed rather than half
 *    fixed in silence.
 *
 * When the fold empties the legacy directory, the directory itself is removed —
 * so on a machine where everything was a duplicate, the stale store is gone
 * rather than left as an empty decoy.
 *
 * Quarantine directories are bounded the same way every other preserved-aside
 * artifact on this platform is (worktree/registry.ts's preserveUnreadableStore):
 * an age TTL plus a count cap, newest kept, ENOENT treated as success so two
 * processes sweeping at once is safe.
 *
 * Nothing here throws. A sweep that cannot read, move or remove something
 * records the failure in its report, leaves the file alone, and lets the daemon
 * boot.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { importLegacySessionStores } from './session-store-importer.js';

/** Directory-name prefix marking a quarantined pre-split control-plane store. */
export const PRE_SPLIT_QUARANTINE_PREFIX = 'control-plane.pre-split-';

/**
 * Age TTL for a quarantined pre-split store. 30 days, matching the worktree
 * registry's preserved-aside files: this is forensic material, and the person
 * who wants to know what was moved may not look for weeks.
 */
const QUARANTINE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Count cap on quarantine directories. The age TTL alone is not a bound. Newest kept. */
const MAX_QUARANTINE_DIRECTORIES = 5;

/**
 * Legacy store file names that have a real folder-forward path into the live
 * store, by file name. Anything else that duplicates a live file is quarantined
 * without folding — moving a duplicate aside is safe, inventing a merge for a
 * store shape nothing here understands is not.
 */
const FOLDABLE_STORES: ReadonlySet<string> = new Set(['sessions.json']);

export interface PreSplitControlPlaneSweepReport {
  /**
   * `absent`  — no legacy store directory (the ordinary case on a clean install).
   * `clean`   — a legacy directory exists but nothing in it duplicates the live store.
   * `swept`   — at least one duplicate was folded and/or moved aside.
   */
  readonly status: 'absent' | 'clean' | 'swept';
  readonly legacyDirectory: string;
  readonly liveDirectory: string;
  /** Sessions the fold added to the live store that were not already in it. */
  readonly foldedSessions: number;
  /** Legacy file names moved into the quarantine directory. */
  readonly movedFiles: readonly string[];
  /** Where they were moved, or null when nothing was moved. */
  readonly quarantineDirectory: string | null;
  /** Legacy file names that exist ONLY at the legacy path — live state, left alone. */
  readonly leftInPlace: readonly string[];
  /** True when the legacy directory itself was removed because nothing was left in it. */
  readonly legacyDirectoryRemoved: boolean;
  /** Anything that could not be read, moved or removed. Never fatal. */
  readonly failures: readonly string[];
  /** One owner-facing line naming what moved and why, or null when nothing moved. */
  readonly receipt: string | null;
}

function emptyReport(
  status: 'absent' | 'clean',
  legacyDirectory: string,
  liveDirectory: string,
  extra: Partial<PreSplitControlPlaneSweepReport> = {},
): PreSplitControlPlaneSweepReport {
  return {
    status,
    legacyDirectory,
    liveDirectory,
    foldedSessions: 0,
    movedFiles: [],
    quarantineDirectory: null,
    leftInPlace: [],
    legacyDirectoryRemoved: false,
    failures: [],
    receipt: null,
    ...extra,
  };
}

function listFiles(directory: string): readonly string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Fold, quarantine and disclose a pre-split control-plane store.
 *
 * Idempotent: a second run finds no duplicates (the first moved them) and
 * reports `clean` or `absent`. Safe to call on every boot.
 */
export async function sweepPreSplitControlPlaneStore(input: {
  /** The unscoped, pre-split store directory, e.g. `~/.goodvibes/control-plane`. */
  readonly legacyDirectory: string;
  /** The surface-scoped store the daemon actually serves, e.g. `~/.goodvibes/tui/control-plane`. */
  readonly liveDirectory: string;
  readonly now?: number | undefined;
  readonly pid?: number | undefined;
}): Promise<PreSplitControlPlaneSweepReport> {
  const { legacyDirectory, liveDirectory } = input;
  const now = input.now ?? Date.now();
  const pid = input.pid ?? process.pid;

  // Never sweep the live store. A composition that resolves both to the same
  // place (an embedded daemon whose surface root is empty, a test home) has one
  // store, not two, and there is nothing here to do.
  if (legacyDirectory === liveDirectory) return emptyReport('absent', legacyDirectory, liveDirectory);
  if (!existsSync(legacyDirectory)) return emptyReport('absent', legacyDirectory, liveDirectory);

  const legacyFiles = listFiles(legacyDirectory);
  if (legacyFiles.length === 0) {
    const removed = removeDirectoryIfEmpty(legacyDirectory);
    return emptyReport('clean', legacyDirectory, liveDirectory, { legacyDirectoryRemoved: removed });
  }

  const liveFiles = new Set(listFiles(liveDirectory));
  const duplicated = legacyFiles.filter((name) => liveFiles.has(name));
  const leftInPlace = legacyFiles.filter((name) => !liveFiles.has(name));

  if (duplicated.length === 0) {
    return emptyReport('clean', legacyDirectory, liveDirectory, { leftInPlace });
  }

  const failures: string[] = [];
  /**
   * Files whose fold did not finish. They stay where they are: moving a store
   * aside because its fold failed would put the only readable copy out of
   * reach of the next attempt.
   */
  const unfolded = new Set<string>();

  // ── Fold forward, before anything moves ─────────────────────────────────
  // The fold has to succeed before the quarantine, or a failed move would be
  // the only thing standing between the owner and a lost session history.
  let foldedSessions = 0;
  for (const name of duplicated) {
    if (!FOLDABLE_STORES.has(name)) continue;
    try {
      const result = await importLegacySessionStores({
        homeStorePath: join(liveDirectory, name),
        // No `project` on the source: these records already carry the project
        // they were created under, and restamping them would be a second lie
        // on top of the one this sweep exists to clear.
        sources: [{ kind: 'broker-store', path: join(legacyDirectory, name) }],
      });
      foldedSessions += result.imported;
    } catch (error) {
      unfolded.add(name);
      failures.push(`${name} could not be folded forward (${summarizeError(error)})`);
    }
  }

  const movable = duplicated.filter((name) => !unfolded.has(name));

  const movedFiles: string[] = [];
  let quarantineDirectory: string | null = null;
  if (movable.length > 0) {
    quarantineDirectory = join(dirname(legacyDirectory), `${PRE_SPLIT_QUARANTINE_PREFIX}${now}-${pid}`);
    try {
      mkdirSync(quarantineDirectory, { recursive: true });
    } catch (error) {
      failures.push(`the quarantine directory could not be created (${summarizeError(error)})`);
      quarantineDirectory = null;
    }
  }
  if (quarantineDirectory !== null) {
    for (const name of movable) {
      try {
        renameSync(join(legacyDirectory, name), join(quarantineDirectory, name));
        movedFiles.push(name);
      } catch (error) {
        const code = (error as { code?: string }).code;
        // Another process swept it between the listing and the move: the end
        // state this sweep wanted is the end state on disk.
        if (code === 'ENOENT') continue;
        failures.push(`${name} could not be moved aside (${summarizeError(error)})`);
      }
    }
    if (movedFiles.length === 0) {
      removeDirectoryIfEmpty(quarantineDirectory);
      quarantineDirectory = null;
    }
  }

  const legacyDirectoryRemoved = listFiles(legacyDirectory).length === 0
    ? removeDirectoryIfEmpty(legacyDirectory)
    : false;

  reapQuarantineDirectories(dirname(legacyDirectory), now);

  const report: PreSplitControlPlaneSweepReport = {
    status: movedFiles.length > 0 || foldedSessions > 0 ? 'swept' : 'clean',
    legacyDirectory,
    liveDirectory,
    foldedSessions,
    movedFiles,
    quarantineDirectory,
    leftInPlace,
    legacyDirectoryRemoved,
    failures,
    receipt: null,
  };
  return { ...report, receipt: preSplitSweepReceipt(report) };
}

/**
 * The owner-facing line. Names what moved, what it held, where it went, and —
 * when anything is still at the legacy path — says so rather than implying the
 * split is fully closed.
 */
export function preSplitSweepReceipt(report: PreSplitControlPlaneSweepReport): string | null {
  if (report.movedFiles.length === 0 && report.foldedSessions === 0) return null;
  const parts: string[] = [];
  parts.push(
    `a pre-split control-plane store at ${report.legacyDirectory} was disagreeing with the one this daemon serves at ${report.liveDirectory}`,
  );
  parts.push(
    report.foldedSessions > 0
      ? `${report.foldedSessions} session${report.foldedSessions === 1 ? '' : 's'} it held and the live store did not were folded forward`
      : 'it held nothing the live store did not already have',
  );
  if (report.movedFiles.length > 0 && report.quarantineDirectory !== null) {
    parts.push(`${report.movedFiles.join(', ')} moved to ${report.quarantineDirectory}`);
  }
  if (report.legacyDirectoryRemoved) {
    parts.push('the old directory is gone');
  } else if (report.leftInPlace.length > 0) {
    parts.push(
      `${report.leftInPlace.join(', ')} stayed there because nothing in the live store duplicates them — they are the only copy, still written at the old path`,
    );
  }
  if (report.failures.length > 0) {
    parts.push(`could not finish: ${report.failures.join('; ')}`);
  }
  return parts.join('; ');
}

function removeDirectoryIfEmpty(directory: string): boolean {
  try {
    rmdirSync(directory);
    return true;
  } catch {
    // Not empty, not present, or not removable — all three mean "leave it".
    return false;
  }
}

/**
 * Bound the quarantine directories: an age TTL plus a count cap, newest kept.
 * Exported so a test can drive it without waiting thirty days.
 */
export function reapQuarantineDirectories(
  parentDirectory: string,
  now: number = Date.now(),
): { readonly expired: number; readonly overCap: number } {
  let entries: string[];
  try {
    entries = readdirSync(parentDirectory);
  } catch {
    return { expired: 0, overCap: 0 };
  }
  const quarantined: Array<{ path: string; at: number }> = [];
  for (const entry of entries) {
    if (!entry.startsWith(PRE_SPLIT_QUARANTINE_PREFIX)) continue;
    const path = join(parentDirectory, entry);
    try {
      const stats = statSync(path);
      if (!stats.isDirectory()) continue;
      quarantined.push({ path, at: stats.mtimeMs });
    } catch {
      // Vanished between readdir and stat: another process already reaped it.
    }
  }

  let expired = 0;
  const withinTtl: Array<{ path: string; at: number }> = [];
  for (const directory of quarantined) {
    if (now - directory.at > QUARANTINE_MAX_AGE_MS) {
      if (removeQuarantineDirectory(directory.path)) expired += 1;
      continue;
    }
    withinTtl.push(directory);
  }

  let overCap = 0;
  if (withinTtl.length > MAX_QUARANTINE_DIRECTORIES) {
    const oldestFirst = [...withinTtl].sort((a, b) => a.at - b.at);
    for (const directory of oldestFirst.slice(0, withinTtl.length - MAX_QUARANTINE_DIRECTORIES)) {
      if (removeQuarantineDirectory(directory.path)) overCap += 1;
    }
  }
  return { expired, overCap };
}

function removeQuarantineDirectory(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch (error) {
    logger.warn('pre-split control-plane sweep: failed to reap a quarantine directory', {
      path,
      error: summarizeError(error),
    });
    return false;
  }
}

/** The legacy (unscoped) control-plane directory for a home, by convention. */
export function preSplitControlPlaneDirectory(userGoodVibesRoot: string): string {
  return join(userGoodVibesRoot, 'control-plane');
}

/** Named for symmetry with the above; `basename` keeps the pair honest in tests. */
export function isPreSplitQuarantineDirectory(path: string): boolean {
  return basename(path).startsWith(PRE_SPLIT_QUARANTINE_PREFIX);
}
