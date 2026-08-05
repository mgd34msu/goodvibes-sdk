/**
 * pre-split-control-plane-sweep.ts — the boot-time pass that ends the
 * two-control-plane-stores condition on a machine that ran a pre-split daemon.
 *
 * ── What was actually on disk ─────────────────────────────────────────────
 *
 * Every piece of the daemon's own state is supposed to live under
 * `.goodvibes/<surface root>/` (see the daemon's config/surface.ts).
 * `shellPaths.resolveUserPath(...)` adds no surface segment — the segment is
 * always the caller's to pass — and a set of control-plane stores forgot to
 * pass it. So `~/.goodvibes/control-plane/` accumulated state that belonged in
 * `~/.goodvibes/tui/control-plane/`, and on the owner's machine it held:
 *
 *   sessions.json               274 KB, rewritten every boot by a legacy fold
 *                               whose target was this unscoped path, read by
 *                               nothing, and holding sessions the live store
 *                               did not have.
 *   occasions-state.json        live — written the day before this was found.
 *   workspace-registrations.json live.
 *
 * The writers are repointed (control-plane-store-paths.ts). This is the other
 * half: what to do about the state already sitting at the old address.
 *
 * ── The four cases, and why each is what it is ────────────────────────────
 *
 * One pass over the legacy directory, one decision per file:
 *
 *  1. THE SESSION STORE is folded, never adopted. It is the one store whose
 *     scoped home is decided by the broker rather than by this directory's
 *     layout (the broker's file is project-scoped), and the one with real
 *     merge semantics of its own: an id-keyed union where the newer updatedAt
 *     wins (session-store-importer.ts). Fold first, then retire.
 *
 *  2. NO SCOPED COUNTERPART → ADOPT: the file is MOVED to the scoped
 *     directory. This is the migration. A move carries the state whole, parses
 *     no shape and invents no merge, which is why a store this file has never
 *     heard of migrates exactly as correctly as one it has.
 *
 *  3. A SCOPED COUNTERPART WITH IDENTICAL BYTES → RETIRE: the legacy copy is
 *     redundant, so it moves to a quarantine directory named in the receipt.
 *
 *  4. A SCOPED COUNTERPART WITH DIFFERENT BYTES → REFUSE, LOUDLY. There are no
 *     merge semantics here for an arbitrary store's shape, and inventing one
 *     would be a guess applied to the owner's data. Both files stay exactly
 *     where they are, the receipt names the conflict, says which copy readers
 *     are using, and says where the other one is. A sweep that quietly picked
 *     a winner would be the same class of defect as the one it is fixing.
 *
 * When nothing is left, the legacy directory is removed — so a machine that
 * migrated cleanly is left with one store and no empty decoy. Running it again
 * finds nothing to do.
 *
 * ORDERING: this runs before any of those stores is read. They all load lazily
 * on first use (see e.g. occasions/state-store.ts's `state()`), and the daemon
 * facade runs this before it starts the services that reach them. Adopting a
 * file after its store had already read an empty one would leave the store
 * about to overwrite what was just migrated in.
 *
 * Quarantine directories are bounded the way every other preserved-aside
 * artifact here is (worktree/registry.ts): an age TTL plus a count cap, newest
 * kept, ENOENT treated as success so two processes sweeping at once is safe.
 *
 * Nothing here throws. Anything that cannot be read, moved or removed is
 * recorded in the report, left alone, and the daemon boots.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { importLegacySessionStores } from './session-store-importer.js';
import { foldLegacyWorkspaceRegister } from '../workspace/registration/fold-legacy-register.js';

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

/** The one store whose scoped home the broker decides, and which merges by id. */
const SESSION_STORE_FILE = 'sessions.json';

/**
 * The register three products share, folded into the SHARED tier rather than
 * under any surface root.
 *
 * It is read and written directly by the SDK's gateway, goodvibes-agent, and
 * the daemon's checkpoint-eligibility reader, so surface-scoping it would give
 * each product its own copy. `~/.goodvibes/shared/` is the platform's home for
 * exactly this (the shared settings tier and canonical memory store live
 * there), and it takes no surface root — one path, identical from everywhere.
 * See workspace/registration/shared-register-path.ts.
 */
const WORKSPACE_REGISTER_FILE = 'workspace-registrations.json';

export interface PreSplitControlPlaneSweepReport {
  /**
   * `absent`     — no legacy store directory (the ordinary case on a clean install).
   * `clean`      — a legacy directory existed and there was nothing left to do.
   * `swept`      — state was adopted, folded and/or retired this pass.
   * `conflicted` — nothing moved, and at least one file disagrees with its
   *                scoped counterpart; the sweep refused rather than guess.
   */
  readonly status: 'absent' | 'clean' | 'swept' | 'conflicted';
  readonly legacyDirectory: string;
  readonly scopedDirectory: string;
  /** Sessions the fold added to the broker's store that were not already in it. */
  readonly foldedSessions: number;
  /** Workspace-register rows the fold added to or refreshed in the shared tier. */
  readonly foldedWorkspaceRows: number;
  /** Files MOVED to the scoped directory because nothing was there — the migration. */
  readonly adoptedFiles: readonly string[];
  /** Files retired into quarantine because the scoped copy already says the same thing. */
  readonly movedFiles: readonly string[];
  /** Where they were retired to, or null when nothing was retired. */
  readonly quarantineDirectory: string | null;
  /**
   * Files that exist in BOTH places with DIFFERENT content. Left alone, both of
   * them: this sweep knows no merge semantics for an arbitrary store's shape,
   * and the honest move is to say so rather than pick a winner over the owner's
   * data. Named in the receipt.
   */
  readonly conflictedFiles: readonly string[];
  /**
   * Files this pass could not place, and did not guess at. Only the session
   * store, and only for a composition whose broker was handed a store object
   * rather than a path: there is then no scoped home to name for it.
   */
  readonly skippedFiles: readonly string[];
  /**
   * Files left at the unscoped path ON PURPOSE, because more than one product
   * reads them there. Not a failure and not a conflict — a deliberate
   * exclusion, named so the directory that survives is explained.
   */
  readonly sharedFiles: readonly string[];
  /** True when the legacy directory itself was removed because nothing was left in it. */
  readonly legacyDirectoryRemoved: boolean;
  /** Anything that could not be read, moved or removed. Never fatal. */
  readonly failures: readonly string[];
  /** One owner-facing line naming what moved and why, or null when nothing did. */
  readonly receipt: string | null;
}

function emptyReport(
  status: 'absent' | 'clean',
  legacyDirectory: string,
  scopedDirectory: string,
  extra: Partial<PreSplitControlPlaneSweepReport> = {},
): PreSplitControlPlaneSweepReport {
  return {
    status,
    legacyDirectory,
    scopedDirectory,
    foldedSessions: 0,
    foldedWorkspaceRows: 0,
    adoptedFiles: [],
    movedFiles: [],
    quarantineDirectory: null,
    conflictedFiles: [],
    skippedFiles: [],
    sharedFiles: [],
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
  /** The surface-scoped directory those stores belong in, e.g. `~/.goodvibes/tui/control-plane`. */
  readonly scopedDirectory: string;
  /**
   * The session store the BROKER serves, which is project-scoped and therefore
   * need not sit in `scopedDirectory` at all. `null` for a broker with no file:
   * sessions.json is then treated like any other store.
   */
  readonly sessionStorePath?: string | null | undefined;
  /**
   * Where the shared workspace register lives — the shared tier, which takes no
   * surface root. `null` leaves the legacy file alone and discloses it.
   */
  readonly workspaceRegisterPath?: string | null | undefined;
  readonly now?: number | undefined;
  readonly pid?: number | undefined;
}): Promise<PreSplitControlPlaneSweepReport> {
  const { legacyDirectory, scopedDirectory } = input;
  const sessionStorePath = input.sessionStorePath ?? null;
  const workspaceRegisterPath = input.workspaceRegisterPath ?? null;
  const now = input.now ?? Date.now();
  const pid = input.pid ?? process.pid;

  // Never sweep the scoped store into itself. A composition that resolves both
  // to the same place (a surface root of '', a test home) has one store, not
  // two, and there is nothing here to do.
  if (legacyDirectory === scopedDirectory) return emptyReport('absent', legacyDirectory, scopedDirectory);
  if (!existsSync(legacyDirectory)) return emptyReport('absent', legacyDirectory, scopedDirectory);

  const legacyFiles = listFiles(legacyDirectory);
  if (legacyFiles.length === 0) {
    return emptyReport('clean', legacyDirectory, scopedDirectory, {
      legacyDirectoryRemoved: removeDirectoryIfEmpty(legacyDirectory),
    });
  }

  const failures: string[] = [];
  const movedFiles: string[] = [];
  const adoptedFiles: string[] = [];
  const conflictedFiles: string[] = [];
  const skippedFiles: string[] = [];
  const sharedFiles: string[] = [];
  let foldedSessions = 0;
  let foldedWorkspaceRows = 0;
  let quarantineDirectory: string | null = null;

  /** Opened lazily, so a run that retires nothing mints no empty directory. */
  const quarantine = (): string | null => {
    if (quarantineDirectory !== null) return quarantineDirectory;
    const path = join(dirname(legacyDirectory), `${PRE_SPLIT_QUARANTINE_PREFIX}${now}-${pid}`);
    try {
      mkdirSync(path, { recursive: true });
      quarantineDirectory = path;
      return path;
    } catch (error) {
      failures.push(`the quarantine directory could not be created (${summarizeError(error)})`);
      return null;
    }
  };

  const retire = (name: string): void => {
    const directory = quarantine();
    if (directory === null) return;
    try {
      renameSync(join(legacyDirectory, name), join(directory, name));
      movedFiles.push(name);
    } catch (error) {
      // Another process swept it between the listing and the move: the end
      // state this sweep wanted is the end state on disk.
      if ((error as { code?: string }).code === 'ENOENT') return;
      failures.push(`${name} could not be moved aside (${summarizeError(error)})`);
    }
  };

  for (const name of legacyFiles) {
    const legacyPath = join(legacyDirectory, name);

    // ── The shared workspace register: folded into the SHARED tier ────────
    // Not adopted into the scoped directory like the stores around it — three
    // products read this one, so it goes somewhere none of them has to know
    // another's surface root. Merged by the store's own identity (root path,
    // later timestamp wins) rather than moved, because an updated product may
    // already have written the shared copy before this ran.
    if (name === WORKSPACE_REGISTER_FILE) {
      if (workspaceRegisterPath === null) {
        sharedFiles.push(name);
        continue;
      }
      try {
        const merged = await foldLegacyWorkspaceRegister({ legacyPath, sharedPath: workspaceRegisterPath });
        foldedWorkspaceRows += merged.added + merged.updated;
      } catch (error) {
        failures.push(`${name} could not be folded into the shared tier (${summarizeError(error)})`);
        continue;
      }
      retire(name);
      continue;
    }

    // ── The session store: folded, never adopted ─────────────────────────
    // It is the one store here whose scoped home is decided by the broker
    // rather than by this directory's layout (the broker's file is
    // project-scoped), and the one with real merge semantics of its own — an
    // id-keyed union where the newer updatedAt wins. Fold first, always: the
    // fold is what guarantees nothing is lost before the file is retired.
    if (name === SESSION_STORE_FILE) {
      // No broker file to fold into: this composition was handed a store
      // object, so nothing here can name where these sessions belong. Adopting
      // it into the scoped directory would move it somewhere no broker reads —
      // a tidier-looking directory and the same orphan. Left alone and said.
      if (sessionStorePath === null) {
        skippedFiles.push(name);
        continue;
      }
      try {
        const result = await importLegacySessionStores({
          homeStorePath: sessionStorePath,
          // No `project` on the source: these records already carry the project
          // they were created under, and restamping them would be a second lie
          // on top of the one this sweep exists to clear.
          sources: [{ kind: 'broker-store', path: legacyPath }],
        });
        foldedSessions += result.imported;
      } catch (error) {
        // A store whose fold failed stays where it is: retiring it would put
        // the only readable copy out of reach of the next attempt.
        failures.push(`${name} could not be folded forward (${summarizeError(error)})`);
        continue;
      }
      retire(name);
      continue;
    }

    const scopedPath = join(scopedDirectory, name);

    // ── No counterpart: this file IS the state, at the wrong address ─────
    // Adopting it is a move, so the state arrives whole — no shape is parsed,
    // no merge is invented, and a store this sweep has never heard of migrates
    // exactly as correctly as one it has.
    if (!existsSync(scopedPath)) {
      try {
        mkdirSync(scopedDirectory, { recursive: true });
        renameSync(legacyPath, scopedPath);
        adoptedFiles.push(name);
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') continue;
        failures.push(`${name} could not be moved to ${scopedDirectory} (${summarizeError(error)})`);
      }
      continue;
    }

    // ── A counterpart exists ─────────────────────────────────────────────
    // Identical: the legacy copy is redundant and retiring it loses nothing.
    // Divergent: this sweep has no merge semantics for an arbitrary store's
    // shape, and inventing one would be a guess applied to the owner's data.
    // It REFUSES — both files stay, the conflict is named in the receipt, and
    // the scoped file (the one every reader now uses) is left untouched.
    try {
      if (readFileSync(legacyPath).equals(readFileSync(scopedPath))) {
        retire(name);
      } else {
        conflictedFiles.push(name);
      }
    } catch (error) {
      failures.push(`${name} could not be compared with its scoped counterpart (${summarizeError(error)})`);
    }
  }

  const legacyDirectoryRemoved = listFiles(legacyDirectory).length === 0
    ? removeDirectoryIfEmpty(legacyDirectory)
    : false;

  reapQuarantineDirectories(dirname(legacyDirectory), now);

  const changed = movedFiles.length > 0 || adoptedFiles.length > 0 || foldedSessions > 0 || foldedWorkspaceRows > 0;
  const report: PreSplitControlPlaneSweepReport = {
    status: changed ? 'swept' : (conflictedFiles.length > 0 ? 'conflicted' : 'clean'),
    legacyDirectory,
    scopedDirectory,
    foldedSessions,
    movedFiles,
    adoptedFiles,
    quarantineDirectory,
    conflictedFiles,
    skippedFiles,
    sharedFiles,
    foldedWorkspaceRows,
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
  const parts: string[] = [];
  if (report.adoptedFiles.length > 0) {
    parts.push(
      `${report.adoptedFiles.join(', ')} moved from ${report.legacyDirectory} to ${report.scopedDirectory}, where this daemon keeps its own state`,
    );
  }
  if (report.foldedSessions > 0) {
    parts.push(
      `${report.foldedSessions} session${report.foldedSessions === 1 ? '' : 's'} the pre-split store held and the live one did not were folded forward`,
    );
  }
  if (report.foldedWorkspaceRows > 0) {
    parts.push(
      `${report.foldedWorkspaceRows} workspace-register row${report.foldedWorkspaceRows === 1 ? '' : 's'} were folded into the shared tier, where every product reads one register`,
    );
  }
  if (report.movedFiles.length > 0 && report.quarantineDirectory !== null) {
    parts.push(
      `${report.movedFiles.join(', ')} said the same as the copy already in use, so ${report.movedFiles.length === 1 ? 'it was' : 'they were'} retired to ${report.quarantineDirectory}`,
    );
  }
  if (report.conflictedFiles.length > 0) {
    parts.push(
      `${report.conflictedFiles.join(', ')} exist${report.conflictedFiles.length === 1 ? 's' : ''} in both places with different content and ${report.conflictedFiles.length === 1 ? 'was' : 'were'} left alone — nothing here knows how to merge ${report.conflictedFiles.length === 1 ? 'that store' : 'those stores'}, the copy under ${report.scopedDirectory} is the one in use, and the old one is still at ${report.legacyDirectory} to be compared by hand`,
    );
  }
  if (report.skippedFiles.length > 0) {
    parts.push(
      `${report.skippedFiles.join(', ')} was left where it is — this daemon's session broker was built on an injected store, so nothing here can say where those sessions belong`,
    );
  }
  if (report.sharedFiles.length > 0) {
    parts.push(
      `${report.sharedFiles.join(', ')} stayed at ${report.legacyDirectory} on purpose — more than one product reads ${report.sharedFiles.length === 1 ? 'it' : 'them'} there, so moving ${report.sharedFiles.length === 1 ? 'it' : 'them'} under one product's directory would hide ${report.sharedFiles.length === 1 ? 'it' : 'them'} from the others`,
    );
  }
  if (report.legacyDirectoryRemoved) parts.push('the pre-split directory is gone');
  if (report.failures.length > 0) parts.push(`could not finish: ${report.failures.join('; ')}`);
  if (parts.length === 0) return null;
  return `pre-split control-plane store: ${parts.join('; ')}`;
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
