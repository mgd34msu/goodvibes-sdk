import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { resolveSharedDirectory } from '../runtime/surface-root.js';
import { logger } from '../utils/logger.js';
import type { WatcherRecord } from '../runtime/store/domains/watchers.js';

export interface WatcherStoreSnapshot {
  readonly version: 1;
  readonly watchers: readonly WatcherRecord[];
}

/**
 * Hard ceiling on `.corrupt-*` snapshots kept per store directory, oldest
 * reaped first. A flapping writer that corrupts its snapshot on every boot
 * must not be allowed to fill the disk with forensic copies — "a handful" is
 * enough to look at what went wrong without becoming a leak.
 */
const CORRUPT_QUARANTINE_MAX_FILES = 5;

function sortWatchers(watchers: readonly WatcherRecord[]): WatcherRecord[] {
  return [...watchers].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

export function getWatcherStorePath(rootPath: string): string {
  return resolveSharedDirectory(rootPath, 'watchers.json');
}

export function resolveWatcherStorePath(storePath?: string): string {
  if (!storePath) {
    throw new Error('Watcher store requires an explicit storePath');
  }
  return storePath;
}

export function loadWatcherSnapshot(storePath: string): WatcherStoreSnapshot | null {
  return loadWatcherSnapshotFromPath(storePath);
}

/**
 * Load a watcher store snapshot, never throwing on a corrupt file.
 *
 * A file this reader cannot trust — unparseable JSON, a torn/zero-tailed
 * write, or the wrong shape — is moved aside to `<name>.corrupt-<timestamp>`
 * (never deleted, never overwritten) with a sibling `.why` receipt explaining
 * what happened, and this returns null exactly as it does for "no snapshot
 * yet". Callers (daemon boot, daemon tick, TUI, agent) all rebuild watcher
 * state from live registrations on a null return, so a corrupt snapshot
 * degrades to an empty one instead of crash-looping the process that reads it.
 */
export function loadWatcherSnapshotFromPath(storePath: string): WatcherStoreSnapshot | null {
  if (!existsSync(storePath)) return null;

  // A read failure here (permissions, the file vanishing between the exists
  // check and the read) is not content corruption this function can
  // quarantine — there is nothing to move aside — so it is left to propagate.
  const raw = readFileSync(storePath, 'utf-8');

  try {
    const parsed = JSON.parse(raw) as Partial<WatcherStoreSnapshot>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.watchers)) {
      throw new Error('snapshot is missing the expected version 1 shape or a watchers array');
    }
    const watchers = parsed.watchers.filter((record): record is WatcherRecord => Boolean(record && typeof record.id === 'string'));
    if (watchers.length !== parsed.watchers.length) {
      throw new Error('snapshot contains one or more malformed watcher records');
    }
    return {
      version: 1,
      watchers,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    quarantineCorruptSnapshot(storePath, reason);
    return null;
  }
}

export function saveWatcherSnapshot(watchers: readonly WatcherRecord[], storePath: string): void {
  saveWatcherSnapshotToPath(watchers, storePath);
}

/**
 * Save a watcher store snapshot atomically.
 *
 * Writes to a sibling temp file in the same directory as `storePath` (so the
 * later rename stays on one filesystem), fsyncs the temp file's descriptor
 * before closing it, then renames it over the target. `rename(2)` is atomic
 * on POSIX, so a reader — and a process that dies mid-write — can only ever
 * observe the previous complete snapshot or the new complete one, never a
 * torn write. Before writing, any stale `<name>.tmp-*` file left behind by a
 * previous crash (this process died between the write and the rename last
 * time) is swept, so it cannot be mistaken for live state or linger forever.
 */
export function saveWatcherSnapshotToPath(watchers: readonly WatcherRecord[], storePath: string): void {
  const dir = dirname(storePath);
  mkdirSync(dir, { recursive: true });

  cleanupStaleTempFiles(dir, storePath);

  const snapshot: WatcherStoreSnapshot = {
    version: 1,
    watchers: sortWatchers(watchers),
  };
  const data = `${JSON.stringify(snapshot, null, 2)}\n`;
  const tmpPath = `${storePath}.tmp-${process.pid}`;

  try {
    const fd = openSync(tmpPath, 'w', 0o600);
    try {
      writeSync(fd, data, null, 'utf-8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(tmpPath, storePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup — the original error takes priority, and the
      // stale-temp sweep above will catch this next time regardless.
    }
    throw error;
  }
}

/**
 * Remove any `<basename>.tmp-*` file already sitting beside `storePath`.
 *
 * The temp file this module writes is named with the CURRENT process's pid,
 * so a file matching this pattern found here was necessarily left by an
 * earlier process that died between writing its temp file and renaming it
 * into place — it can never be live work in progress for this call.
 */
function cleanupStaleTempFiles(dir: string, storePath: string): void {
  const prefix = `${basename(storePath)}.tmp-`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const stalePath = join(dir, name);
    try {
      unlinkSync(stalePath);
      logger.warn('[watchers/store] removed a stale temp file left by a previous crash', { storePath, stalePath });
    } catch {
      // Best-effort — a concurrent writer or a permissions issue must not
      // block this save.
    }
  }
}

/**
 * Move a corrupt watcher snapshot aside, write a `.why` receipt beside it,
 * log the event loudly, and reap old quarantine files past the bound.
 *
 * The original file is never deleted and never overwritten — only renamed —
 * so the evidence survives for inspection. Watcher state itself is not lost:
 * every caller of {@link loadWatcherSnapshotFromPath} treats a null return
 * exactly like "no snapshot yet" and rebuilds from live registrations.
 */
function quarantineCorruptSnapshot(storePath: string, reason: string): void {
  const dir = dirname(storePath);
  const base = basename(storePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantinePath = join(dir, `${base}.corrupt-${timestamp}-${randomUUID().slice(0, 8)}`);
  const whyPath = `${quarantinePath}.why`;

  let moved = false;
  try {
    renameSync(storePath, quarantinePath);
    moved = true;
  } catch (renameError) {
    logger.error('[watchers/store] could not move corrupt watcher snapshot aside; leaving it in place', {
      storePath,
      reason,
      renameError: renameError instanceof Error ? renameError.message : String(renameError),
    });
  }

  const reapResult = moved ? reapCorruptQuarantineFiles(dir, base) : { scanned: 0, reaped: 0 };

  if (moved) {
    const whyLines = [
      `Watcher store snapshot at ${storePath} failed to load: ${reason}.`,
      `The corrupt file was moved to ${basename(quarantinePath)} for inspection and is never parsed again.`,
      'Watcher state rebuilds from live registrations on the next load (daemon boot, daemon tick, or a client reconnect) — nothing further is required.',
      reapResult.reaped > 0
        ? `${reapResult.reaped} older quarantined snapshot(s) beyond the ${CORRUPT_QUARANTINE_MAX_FILES}-file bound were deleted (oldest first) to keep this quarantine from growing without limit.`
        : null,
    ].filter((line): line is string => line !== null);
    try {
      writeFileSync(whyPath, `${whyLines.join('\n')}\n`, 'utf-8');
    } catch (whyError) {
      logger.error('[watchers/store] could not write the .why receipt beside a quarantined watcher snapshot', {
        whyPath,
        whyError: whyError instanceof Error ? whyError.message : String(whyError),
      });
    }
  }

  logger.error(
    `[watchers/store] watcher store snapshot was corrupt and has been quarantined; watcher state rebuilds from live registrations: ${reason}`,
    {
      storePath,
      quarantinePath: moved ? quarantinePath : undefined,
      reaped: reapResult.reaped,
    },
  );
}

/**
 * Delete `.corrupt-*` watcher snapshots (and their `.why` receipts) beyond
 * {@link CORRUPT_QUARANTINE_MAX_FILES}, oldest first. Runs after every new
 * quarantine so a repeatedly-corrupting writer cannot accumulate files
 * without bound.
 */
function reapCorruptQuarantineFiles(dir: string, base: string): { scanned: number; reaped: number } {
  const prefix = `${base}.corrupt-`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { scanned: 0, reaped: 0 };
  }

  const corruptFiles = names
    .filter((name) => name.startsWith(prefix) && !name.endsWith('.why'))
    .map((name) => {
      const full = join(dir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      return { full, mtimeMs };
    });

  let reaped = 0;
  if (corruptFiles.length > CORRUPT_QUARANTINE_MAX_FILES) {
    corruptFiles.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    const excess = corruptFiles.length - CORRUPT_QUARANTINE_MAX_FILES;
    for (const victim of corruptFiles.slice(0, excess)) {
      try {
        unlinkSync(victim.full);
        reaped += 1;
      } catch {
        // Best-effort — a file another sweeper already removed counts as reclaimed.
      }
      try {
        unlinkSync(`${victim.full}.why`);
      } catch {
        // The receipt may not exist (an earlier write failure) — not an error.
      }
    }
  }

  return { scanned: corruptFiles.length, reaped };
}
