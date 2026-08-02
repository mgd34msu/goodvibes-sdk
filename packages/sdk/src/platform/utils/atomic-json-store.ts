/**
 * atomic-json-store — the two file mechanics every on-disk JSON store in this
 * platform shares, in one place.
 *
 * This module lives under `utils/` deliberately: `utils/` is the documented
 * leaf of the platform dependency graph (no intra-platform imports beyond
 * `./logger.js`, which is itself a leaf), so `config/`, `core/`, `daemon/`,
 * `mcp/`, `pairing/`, `plugins/`, `profiles/`, `providers/`, `runtime/`, and
 * `watchers/` can all import it without creating a layering edge between two
 * domains that must stay independent.
 *
 * The two mechanics:
 *
 *   1. {@link writeFileAtomic} / {@link writeJsonFileAtomic} — write to a
 *      sibling `.tmp-<pid>` file in the same directory as the target (so the
 *      later rename stays on one filesystem), fsync the descriptor before
 *      closing it, chmod it to the exact requested mode (so the result does
 *      not depend on the process umask), then `renameSync` it over the target.
 *      `rename(2)` is atomic on POSIX: a concurrent reader — and a process
 *      that dies mid-write — can only ever observe the previous complete file
 *      or the new complete one, never a torn write. Before writing, any stale
 *      `<name>.tmp-*` left by a previous crash is swept.
 *
 *   2. {@link readJsonFileOrQuarantine} — a file this reader cannot trust
 *      (unparseable JSON, a torn or zero-tailed write, the wrong shape) is
 *      moved aside to `<name>.corrupt-<ISO>-<8char>` with a sibling `.why`
 *      receipt, logged loudly at error level, and reported to the caller as
 *      the ordinary "absent" answer (`null`) so the caller rebuilds instead of
 *      crashing. The original file is never deleted and never overwritten —
 *      only renamed — so the evidence survives for inspection. Quarantine
 *      files are bounded at {@link CORRUPT_QUARANTINE_MAX_FILES} per store,
 *      oldest reaped first, and the reap is disclosed in the newest receipt.
 */
import {
  chmodSync,
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
import { logger } from './logger.js';

/**
 * Hard ceiling on `.corrupt-*` files kept per store directory, oldest reaped
 * first. A flapping writer that corrupts its file on every boot must not be
 * allowed to fill the disk with forensic copies — "a handful" is enough to
 * look at what went wrong without becoming a leak.
 */
export const CORRUPT_QUARANTINE_MAX_FILES = 5;

/** Default mode for a store file: owner read/write only. */
const DEFAULT_STORE_FILE_MODE = 0o600;

export interface AtomicWriteOptions {
  /**
   * Exact mode of the resulting file. Applied with an explicit `chmod` before
   * the rename, so the result does not vary with the process umask.
   * Defaults to `0o600`.
   */
  readonly mode?: number;
}

export interface AtomicJsonWriteOptions extends AtomicWriteOptions {
  /** `JSON.stringify` indent. `null` writes compact JSON. Defaults to `2`. */
  readonly indent?: number | null;
  /** Append a trailing newline to the serialized JSON. Defaults to `true`. */
  readonly trailingNewline?: boolean;
}

/**
 * Write `contents` to `filePath` atomically, creating parent directories as
 * needed. See the module docstring for the mechanics and why they matter.
 */
export function writeFileAtomic(filePath: string, contents: string, options: AtomicWriteOptions = {}): void {
  const mode = options.mode ?? DEFAULT_STORE_FILE_MODE;
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  cleanupStaleTempFiles(dir, filePath);

  const tmpPath = `${filePath}.tmp-${process.pid}`;

  try {
    const fd = openSync(tmpPath, 'w', mode);
    try {
      writeSync(fd, contents, null, 'utf-8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    // `open(2)` masks the requested mode with the process umask; an explicit
    // chmod makes the resulting mode exact, which is what a 0600 store file
    // needs to actually mean 0600 under any umask.
    chmodSync(tmpPath, mode);

    renameSync(tmpPath, filePath);
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

/** Serialize `value` as JSON and write it atomically via {@link writeFileAtomic}. */
export function writeJsonFileAtomic(filePath: string, value: unknown, options: AtomicJsonWriteOptions = {}): void {
  const indent = options.indent === undefined ? 2 : options.indent;
  const trailingNewline = options.trailingNewline ?? true;
  const serialized = indent === null ? JSON.stringify(value) : JSON.stringify(value, null, indent);
  writeFileAtomic(filePath, trailingNewline ? `${serialized}\n` : serialized, options);
}

export interface QuarantineLoadOptions<T> {
  /**
   * Short store name used in the log line and the `.why` receipt, e.g.
   * `'config/secrets'`. Rendered as `[<label>]` in logs.
   */
  readonly label: string;
  /**
   * Narrow the parsed JSON to the store's shape. Throw with a human-readable
   * reason when the content cannot be trusted — that reason is what lands in
   * the `.why` receipt and the error log.
   */
  readonly validate: (parsed: unknown) => T;
  /**
   * One sentence for the `.why` receipt describing what happens now that the
   * file is gone — i.e. how this store rebuilds. Written for a human reading
   * the receipt months later with no other context.
   */
  readonly recovery: string;
}

/**
 * Read and parse a JSON store file, never throwing on corrupt content.
 *
 * Returns `null` both when the file does not exist and when it existed but
 * could not be trusted — in the latter case the file is quarantined first (see
 * the module docstring). Callers treat `null` as "no store yet" and rebuild.
 *
 * A read failure (permissions, the file vanishing between the exists check and
 * the read) is deliberately NOT caught: there is no content to move aside, so
 * quarantine has nothing to do and the error propagates to the caller.
 */
export function readJsonFileOrQuarantine<T>(filePath: string, options: QuarantineLoadOptions<T>): T | null {
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, 'utf-8');

  try {
    return options.validate(JSON.parse(raw) as unknown);
  } catch (error) {
    quarantineCorruptFile(filePath, {
      label: options.label,
      reason: error instanceof Error ? error.message : String(error),
      recovery: options.recovery,
    });
    return null;
  }
}

export interface QuarantineOptions {
  /** Short store name, e.g. `'config/secrets'`. */
  readonly label: string;
  /** Why the file could not be trusted. */
  readonly reason: string;
  /** What happens now that the file is gone, for the `.why` receipt. */
  readonly recovery: string;
}

/**
 * Move a corrupt store file aside, write a `.why` receipt beside it, log the
 * event loudly, and reap old quarantine files past the bound.
 *
 * Exported for stores that parse in stages and decide for themselves which
 * stage counts as container corruption (`config/secrets.ts` quarantines an
 * unreadable JSON envelope but must never quarantine a decrypt failure, which
 * means the file is intact and the key is wrong).
 */
export function quarantineCorruptFile(filePath: string, options: QuarantineOptions): void {
  const { label, reason, recovery } = options;
  const dir = dirname(filePath);
  const base = basename(filePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantinePath = join(dir, `${base}.corrupt-${timestamp}-${randomUUID().slice(0, 8)}`);
  const whyPath = `${quarantinePath}.why`;

  let moved = false;
  try {
    renameSync(filePath, quarantinePath);
    moved = true;
  } catch (renameError) {
    logger.error(`[${label}] could not move a corrupt store file aside; leaving it in place`, {
      filePath,
      reason,
      renameError: renameError instanceof Error ? renameError.message : String(renameError),
    });
  }

  // The just-quarantined file is excluded from reaping by name: its .why is
  // written only after the reap, so on a filesystem with coarse mtimes an
  // all-tie sort could otherwise pick it as the "oldest" victim and leave the
  // receipt written below orphaned — the exact failure a matrix runner caught.
  const reapResult = moved
    ? reapCorruptQuarantineFiles(dir, base, basename(quarantinePath))
    : { scanned: 0, reaped: 0 };

  if (moved) {
    const whyLines = [
      `The ${label} store file at ${filePath} failed to load: ${reason}.`,
      `The corrupt file was moved to ${basename(quarantinePath)} for inspection and is never parsed again.`,
      recovery,
      reapResult.reaped > 0
        ? `${reapResult.reaped} older quarantined file(s) beyond the ${CORRUPT_QUARANTINE_MAX_FILES}-file bound were deleted (oldest first) to keep this quarantine from growing without limit.`
        : null,
    ].filter((line): line is string => line !== null);
    try {
      writeFileSync(whyPath, `${whyLines.join('\n')}\n`, 'utf-8');
    } catch (whyError) {
      logger.error(`[${label}] could not write the .why receipt beside a quarantined store file`, {
        whyPath,
        whyError: whyError instanceof Error ? whyError.message : String(whyError),
      });
    }
  }

  logger.error(`[${label}] store file was corrupt and has been quarantined; ${recovery} — ${reason}`, {
    filePath,
    quarantinePath: moved ? quarantinePath : undefined,
    reaped: reapResult.reaped,
  });
}

/**
 * Remove any `<basename>.tmp-*` file already sitting beside `filePath`.
 *
 * The temp file this module writes is named with the CURRENT process's pid, so
 * a file matching this pattern found here was necessarily left by an earlier
 * process that died between writing its temp file and renaming it into place —
 * it can never be live work in progress for this call.
 */
function cleanupStaleTempFiles(dir: string, filePath: string): void {
  const prefix = `${basename(filePath)}.tmp-`;
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
      logger.warn('[atomic-json-store] removed a stale temp file left by a previous crash', { filePath, stalePath });
    } catch {
      // Best-effort — a concurrent writer or a permissions issue must not
      // block this save.
    }
  }
}

/**
 * Delete `.corrupt-*` files (and their `.why` receipts) beyond
 * {@link CORRUPT_QUARANTINE_MAX_FILES}, oldest first. Runs after every new
 * quarantine so a repeatedly-corrupting writer cannot accumulate files without
 * bound.
 */
function reapCorruptQuarantineFiles(
  dir: string,
  base: string,
  /** The quarantine file created by the caller in this same pass — never a victim. */
  currentName?: string,
): { scanned: number; reaped: number } {
  const prefix = `${base}.corrupt-`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { scanned: 0, reaped: 0 };
  }

  const quarantineNames = new Set(names.filter((name) => name.startsWith(prefix) && !name.endsWith('.why')));

  // Self-heal: a .why with no surviving quarantine file discloses nothing and
  // keeps nothing — delete it, whatever past interruption produced it.
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.why')) continue;
    if (!quarantineNames.has(name.slice(0, -'.why'.length))) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // Best-effort.
      }
    }
  }

  const corruptFiles = [...quarantineNames]
    .filter((name) => name !== currentName)
    .map((name) => {
      const full = join(dir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      return { full, name, mtimeMs };
    });

  // The cap counts every quarantine file including the current one; only the
  // older ones are eligible victims.
  const cap = currentName !== undefined && quarantineNames.has(currentName)
    ? CORRUPT_QUARANTINE_MAX_FILES - 1
    : CORRUPT_QUARANTINE_MAX_FILES;

  let reaped = 0;
  if (corruptFiles.length > cap) {
    // Oldest first; mtime ties (coarse-mtime filesystems) break by the
    // millisecond timestamp baked into the quarantine name, so the order is
    // total and matches creation order.
    corruptFiles.sort((a, b) => (a.mtimeMs - b.mtimeMs) || a.name.localeCompare(b.name));
    const excess = corruptFiles.length - cap;
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

  return { scanned: quarantineNames.size, reaped };
}
