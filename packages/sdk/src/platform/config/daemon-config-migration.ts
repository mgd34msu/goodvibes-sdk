/**
 * daemon-config-migration.ts, move daemon-owned keys out of the per-surface
 * silos and into the daemon's own store, once, idempotently, with disclosure.
 *
 * Values MOVE. Nothing is copied (a copy is drift waiting to happen) and
 * nothing is abandoned.
 *
 * WHICH VALUE WINS, when two stores disagree about the same daemon-owned key:
 *
 *   1. A value already in the daemon store wins. This is what makes a re-run
 *      safe: after a partial run the daemon store is authoritative and a second
 *      pass cannot undo it.
 *   2. Otherwise the PRIMARY surface wins, the surface whose settings file the
 *      daemon has actually been reading (`tui`, because the daemon binary is
 *      the TUI binary). Choosing it preserves the behavior the machine has
 *      right now: whatever the daemon was doing before the migration, it keeps
 *      doing after it.
 *   3. Otherwise the first remaining surface in alphabetical order wins, so the
 *      result does not depend on directory-listing order.
 *
 * Every value that does NOT win is disclosed in the marker with the store it
 * came from and the store that superseded it, redacted when the key names a
 * credential. Losing a value silently is the failure this whole change exists
 * to remove.
 *
 * CRASH SAFETY. The order is: write an `in-progress` marker carrying the full
 * plan, write the daemon store, strip the surfaces, then rewrite the marker as
 * `complete`. A marker is only believed when it PARSES and says `complete`, so
 * a torn or truncated marker re-runs the migration rather than stranding the
 * data. Every file write is temp-file + rename, so no reader sees a half file.
 */

import { existsSync } from 'node:fs';
import { readDotPath } from './shared-config-tier.js';
import { deleteRawDotPath } from './settings-io.js';
import { listDaemonOwnedConfigPaths } from './config-ownership.js';
import {
  DAEMON_CONFIG_MOVED_VERSION,
  daemonConfigMovedPath,
  discloseValue,
  discoverSurfaceSettingsFiles,
  readAnyDaemonConfigMovedMarker,
  readDaemonConfigMovedMarker,
  readSettingsFileStrict,
  writeJsonAtomic,
  type DaemonConfigMovedMarker,
  type DiscardedConfigKey,
  type MovedConfigKey,
} from './daemon-config-migration-io.js';
import { daemonConfigPath } from './daemon-config-tier.js';

/** The surface store the daemon has historically read; wins on conflict. */
export const DEFAULT_PRIMARY_DAEMON_SURFACE = 'tui';

export interface DaemonConfigMigrationOptions {
  /** User home directory whose `.goodvibes/` tree is migrated. */
  readonly homeDir: string;
  /** Override the daemon store path (honors GOODVIBES_DAEMON_HOME callers). */
  readonly daemonStorePath?: string | undefined;
  /** Surface whose value wins a conflict. Defaults to `tui`. */
  readonly primarySurface?: string | undefined;
  /** Explicit surface list (tests); defaults to on-disk discovery. */
  readonly surfaces?: readonly { surface: string; path: string }[] | undefined;
  /** Clock injection for deterministic markers. */
  readonly now?: (() => Date) | undefined;
}

export interface DaemonConfigMigrationResult {
  /** True when this call performed the move (false when already migrated). */
  readonly migrated: boolean;
  /** The disclosure marker as written (or the pre-existing complete one). */
  readonly marker: DaemonConfigMovedMarker;
  /** Absolute path of the marker file. */
  readonly markerPath: string;
}

interface Candidate {
  readonly key: string;
  readonly value: unknown;
  readonly from: string;
  readonly surface: string;
}

/** A surface settings file being migrated, and whether this run changed it. */
interface SurfaceFile {
  readonly surface: string;
  readonly path: string;
  readonly raw: Record<string, unknown>;
  stripped: boolean;
}

/**
 * Run the migration if it has not completed. Safe to call on every startup: the
 * fast path is one file read and one JSON parse.
 */
export function migrateDaemonOwnedConfig(
  options: DaemonConfigMigrationOptions,
): DaemonConfigMigrationResult {
  const storePath = options.daemonStorePath ?? daemonConfigPath(options.homeDir);
  const markerPath = daemonConfigMovedPath(storePath);

  const ownedKeys = listDaemonOwnedConfigPaths();
  const done = readDaemonConfigMovedMarker(markerPath);
  // "Complete" is only complete for the ownership set the marker covers. A key
  // promoted to daemon-owned after that run has never been migrated, and its
  // value is still sitting in a client store the daemon does not read, so a
  // grown owned set means there is work to do, not that the job is finished.
  if (done && ownedKeys.every((key) => done.coveredKeys.includes(key))) {
    return { migrated: false, marker: done, markerPath };
  }

  const primarySurface = options.primarySurface ?? DEFAULT_PRIMARY_DAEMON_SURFACE;
  const surfaces = options.surfaces ?? discoverSurfaceSettingsFiles(options.homeDir);
  const now = options.now ?? (() => new Date());

  const store = readSettingsFileStrict(storePath);
  const surfaceFiles: SurfaceFile[] = surfaces.map((entry) => ({
    surface: entry.surface,
    path: entry.path,
    raw: readSettingsFileStrict(entry.path),
    stripped: false,
  }));

  const plan = planMove({ store, storePath, surfaceFiles, primarySurface });

  // Carry an interrupted run's ledger forward so its disclosure is never lost.
  const previous = readAnyDaemonConfigMovedMarker(markerPath);
  const moved = mergeLedger(previous?.moved, plan.moved, (e) => `${e.key}|${e.from}`);
  const discarded = mergeLedger(previous?.discarded, plan.discarded, (e) => `${e.key}|${e.from}`);

  const marker: DaemonConfigMovedMarker = {
    version: DAEMON_CONFIG_MOVED_VERSION,
    status: 'complete',
    movedTo: storePath,
    primarySurface,
    date: now().toISOString(),
    sources: surfaceFiles.map((entry) => entry.path),
    moved,
    discarded,
    coveredKeys: [...ownedKeys],
  };

  // 1. Announce the plan before touching anything.
  writeJsonAtomic(markerPath, { ...marker, status: 'in-progress' });
  // 2. The daemon store becomes authoritative.
  if (plan.storeChanged || !existsSync(storePath)) writeJsonAtomic(storePath, plan.store);
  // 3. Only then do the surfaces give the keys up, one writer per key.
  for (const entry of surfaceFiles) {
    if (!entry.stripped) continue;
    writeJsonAtomic(entry.path, entry.raw);
  }
  // 4. The ledger is final.
  writeJsonAtomic(markerPath, marker);

  return { migrated: true, marker, markerPath };
}

interface PlanInput {
  readonly store: Record<string, unknown>;
  readonly storePath: string;
  readonly surfaceFiles: readonly SurfaceFile[];
  readonly primarySurface: string;
}

interface Plan {
  readonly store: Record<string, unknown>;
  readonly storeChanged: boolean;
  readonly moved: MovedConfigKey[];
  readonly discarded: DiscardedConfigKey[];
}

/**
 * Decide, per daemon-owned key, which store's value survives, and record every
 * value that does not. Mutates `surfaceFiles[].raw` to strip the moved keys and
 * flags which files actually changed.
 */
function planMove(input: PlanInput): Plan {
  const store = structuredClone(input.store);
  const moved: MovedConfigKey[] = [];
  const discarded: DiscardedConfigKey[] = [];
  let storeChanged = false;

  for (const key of listDaemonOwnedConfigPaths()) {
    const candidates = collectCandidates(input.surfaceFiles, key);
    const existing = readDotPath(store, key);

    // Strip the key from every surface regardless of who wins: after this run
    // the daemon store is the only place it lives.
    for (const entry of input.surfaceFiles) {
      if (deleteRawDotPath(entry.raw, key)) entry.stripped = true;
    }

    if (candidates.length === 0) continue;

    const winner = existing.present
      ? { key, value: existing.value, from: input.storePath, surface: '(daemon)' }
      : pickWinner(candidates, input.primarySurface);

    if (!existing.present) {
      writeInto(store, key, winner.value);
      storeChanged = true;
      moved.push({ key, from: winner.from });
    }

    for (const candidate of candidates) {
      if (candidate.from === winner.from) continue;
      const same = JSON.stringify(candidate.value) === JSON.stringify(winner.value);
      discarded.push({
        key,
        from: candidate.from,
        value: discloseValue(key, candidate.value),
        reason: same ? 'duplicate' : 'conflict',
        supersededBy: winner.from,
      });
    }
  }

  return { store, storeChanged, moved, discarded };
}

function collectCandidates(
  files: readonly { surface: string; path: string; raw: Record<string, unknown> }[],
  key: string,
): readonly Candidate[] {
  const out: Candidate[] = [];
  for (const entry of files) {
    const hit = readDotPath(entry.raw, key);
    if (hit.present) out.push({ key, value: hit.value, from: entry.path, surface: entry.surface });
  }
  return out;
}

function pickWinner(candidates: readonly Candidate[], primarySurface: string): Candidate {
  const primary = candidates.find((candidate) => candidate.surface === primarySurface);
  if (primary) return primary;
  // `candidates` already follows the alphabetical surface order the discovery
  // helper guarantees, so "first" is deterministic rather than listing order.
  return candidates[0]!;
}

function writeInto(root: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cursor[part];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

function mergeLedger<T>(
  previous: readonly T[] | undefined,
  current: readonly T[],
  identity: (entry: T) => string,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const entry of [...(Array.isArray(previous) ? previous : []), ...current]) {
    const id = identity(entry);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(entry);
  }
  return out;
}

/** Human-readable disclosure of a completed migration, for a startup notice. */
export function describeDaemonConfigMigration(marker: DaemonConfigMovedMarker): string {
  if (marker.moved.length === 0 && marker.discarded.length === 0) {
    return 'Daemon-owned settings already had a single home; nothing moved.';
  }
  const lines = [
    `Daemon-owned settings now live in ${marker.movedTo}.`,
    `Moved ${marker.moved.length} value(s); ${marker.discarded.length} duplicate/conflicting value(s) were discarded and are listed in the migration record.`,
  ];
  const conflicts = marker.discarded.filter((entry) => entry.reason === 'conflict');
  for (const conflict of conflicts) {
    lines.push(`  ${conflict.key}: kept the value from ${conflict.supersededBy}, discarded ${JSON.stringify(conflict.value)} from ${conflict.from}`);
  }
  return lines.join('\n');
}

export type { DaemonConfigMovedMarker, DiscardedConfigKey, MovedConfigKey };
