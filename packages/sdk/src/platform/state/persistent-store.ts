import { randomUUID } from 'node:crypto';
import { promises as fs, existsSync } from 'fs';
import { basename, dirname, join } from 'path';
import { summarizeError } from '../utils/error-display.js';

/**
 * PersistentStore — generic JSON file persistence with atomic writes.
 *
 * Handles lazy loading, atomic writes via a temporary file, and ensures the
 * directory hierarchy exists. Invalid JSON and write failures are thrown so
 * callers do not mistake corrupted state for an empty store or persisted write.
 *
 * THREE PROPERTIES OF THE WRITE, none of which the original had:
 *
 *  1. THE FILE IS THE OWNER'S ONLY. `writeFile` with no `mode` produced 0644
 *     under a 0755 `~/.goodvibes/daemon`, so every credential-adjacent thing
 *     these stores hold — inbound mail bodies, push key material, session
 *     records — was world-readable on a multi-user machine. Both the temp file
 *     and the directory are created 0600 / 0700. The mode is set at CREATE
 *     time on the temp file, and `rename` preserves it, so an existing 0644
 *     file becomes 0600 on its next write without a separate chmod pass.
 *
 *  2. THE BYTES ARE ON THE DISK BEFORE THE RENAME NAMES THEM. `rename` is
 *     atomic with respect to other processes but says nothing about power
 *     loss: on a crash the metadata operation can land while the data blocks
 *     have not, leaving a ZERO-LENGTH file at the store path — which
 *     `loadOrDiscard` then has to treat as corrupt, discarding a store that
 *     was written perfectly well. The file is fsync'd before the rename and
 *     the DIRECTORY is fsync'd after it, because the rename itself is
 *     directory metadata and is equally free to be lost.
 *
 *  3. A CRASH MID-WRITE LEAVES NO LITTER. `<file>.tmp.<pid>.<uuid>` is removed
 *     on the failure path, but a process killed between the open and the
 *     rename never runs that path, and nothing else ever looked at those
 *     names — persisted state with no GC, which is the exact rule
 *     docs/inbound-email.md §9 exists for. Writes now sweep their own
 *     directory for temp files old enough that nobody could still be writing
 *     them.
 *
 * NOT here: cross-process mutual exclusion. `persist()` is one atomic
 * replacement, so two writers cannot tear a file — but a read-modify-write
 * spanning `load()` and `persist()` can still lose the other writer's record,
 * and that window belongs to the caller that owns the read. Stores that need
 * it take the advisory lock at `<file>.lock` around the WHOLE cycle; see
 * `lockPath` below and `push/subscription-store.ts` for the shape.
 *
 * `loadOrDiscard()` is the second reading, for state whose OWNER has a rule for
 * a torn record: discard it, record the fact, disclose it. A store that only
 * throws forces every caller of every method that reads it to fail forever over
 * one unreadable byte — including the disclosure verb that exists to explain
 * exactly that state, and including sweeps of OTHER files that are perfectly
 * fine. The throwing `load()` stays the default, because "empty" and "corrupt"
 * must not be the same answer by accident; asking for the discard is explicit.
 */

/** What was unreadable, for a caller that discards rather than fails. */
export interface PersistentStoreCorruption {
  readonly filePath: string;
  /** Why it could not be read. Never the file's contents. */
  readonly detail: string;
  readonly detectedAt: number;
}

/** The result of a read that discards rather than throws. */
export interface PersistentStoreRead<T> {
  /** The parsed data, or null when the file was absent OR unreadable. */
  readonly data: T | null;
  /** Non-null only when the file existed and could not be read. */
  readonly corruption: PersistentStoreCorruption | null;
}

/** Owner-only, on both the state files and the directory that holds them. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * How old a `<file>.tmp.<pid>.<uuid>` has to be before a write reclaims it.
 *
 * A live write holds its temp file for the length of one `writeFile` plus one
 * `fsync` — milliseconds. Ten minutes is four orders of magnitude beyond that,
 * so this can never delete a temp file another process is about to rename, and
 * it is still short enough that a crashed daemon's litter is gone by the next
 * write rather than by the next reinstall.
 */
const ORPHANED_TEMP_AFTER_MS = 10 * 60_000;

/** Sweep at most this often per store path, so an append-heavy store does not pay a readdir per write. */
const TEMP_SWEEP_INTERVAL_MS = 60_000;

/**
 * Last temp-sweep time per store path. Bounded by the number of distinct store
 * files a process writes, which is a fixed, small set.
 */
const lastTempSweepAt = new Map<string, number>();

/** Reset the temp-sweep throttle. Test seam only — a fresh process starts empty. */
export function resetPersistentStoreTempSweepThrottle(): void {
  lastTempSweepAt.clear();
}

/**
 * fsync a directory so a completed `rename` survives power loss.
 *
 * Best-effort by design: a directory cannot be opened for reading on Windows,
 * and some filesystems refuse `fsync` on a directory fd. Failing the write over
 * that would trade a durability improvement for an availability regression, so
 * the sync is attempted and its absence is tolerated.
 */
async function syncDirectory(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(dir, 'r');
  } catch {
    return;
  }
  try {
    await handle.sync();
  } catch {
    // Directory fsync unsupported here. The rename already happened.
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export class PersistentStore<T extends Record<string, unknown>> {
  private readonly filePath: string;
  private readonly dir: string;
  private readonly inMemory: boolean;
  private memoryData: T | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.dir = dirname(filePath);
    this.inMemory = filePath === ':memory:';
  }

  /**
   * The advisory-lock path for this store, or null when there is no file to
   * contend on.
   *
   * Exposed so a store that does read-modify-write can serialize the WHOLE
   * cycle across processes without having to be told its own path a second
   * time — the inbound-mail stores accept either a path or an injected
   * `PersistentStore`, and a lock derived from a constructor argument they may
   * not have been given is a lock that silently is not taken.
   */
  get lockPath(): string | null {
    return this.inMemory ? null : `${this.filePath}.lock`;
  }

  /** Load JSON data from disk, or return null if the file does not exist. */
  async load(): Promise<T | null> {
    if (this.inMemory) return this.memoryData;
    if (!existsSync(this.filePath)) {
      return null;
    }
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new Error(`PersistentStore failed to load ${this.filePath}: ${summarizeError(err)}`);
    }
  }

  /**
   * Load, treating an unreadable file as ABSENT rather than as an error.
   *
   * For state whose owner already rules that a torn record is discarded and
   * disclosed (docs/inbound-email.md §9): the same rule applied to the whole
   * file. The bytes are left on disk untouched — the next `persist()` replaces
   * them — so this never destroys evidence, it only stops one unreadable byte
   * from being a permanent hard failure across every reader of every store.
   *
   * A file that parses to something that is not an object is corrupt too: it
   * would otherwise read as an empty store, which is the exact "corrupted state
   * mistaken for empty" this class was written to prevent.
   */
  async loadOrDiscard(): Promise<PersistentStoreRead<T>> {
    if (this.inMemory) return { data: this.memoryData, corruption: null };
    if (!existsSync(this.filePath)) return { data: null, corruption: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf-8'));
    } catch (err) {
      return { data: null, corruption: this.corruption(summarizeError(err)) };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        data: null,
        corruption: this.corruption('the file did not contain a JSON object'),
      };
    }
    return { data: parsed as T, corruption: null };
  }

  private corruption(detail: string): PersistentStoreCorruption {
    return { filePath: this.filePath, detail, detectedAt: Date.now() };
  }

  /**
   * Atomically persist data to disk, owner-only and durably.
   *
   * The order is load-bearing and is the whole of property 2 in the header:
   * write → fsync the file → rename → fsync the directory. Renaming a file
   * whose bytes are still only in the page cache means a power loss can leave
   * the store path pointing at a zero-length file, and a zero-length file is
   * indistinguishable from a corrupt one — so an unlucky moment turns a
   * perfectly good write into a discarded store.
   */
  async persist(data: T): Promise<void> {
    if (this.inMemory) {
      this.memoryData = structuredClone(data);
      return;
    }
    await fs.mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    await this.reapOrphanedTempFiles();
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${randomUUID()}`;
    const content = JSON.stringify(data, null, 2) + '\n';
    try {
      // `wx` + an explicit mode: the file is owner-only from the instant it
      // exists, never 0644-then-chmod, which is a window a reader can hit.
      const handle = await fs.open(tmpPath, 'wx', FILE_MODE);
      try {
        await handle.writeFile(content, 'utf-8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmpPath, this.filePath);
      await syncDirectory(this.dir);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Remove `<file>.tmp.<pid>.<uuid>` files left by a process that died between
   * the open and the rename.
   *
   * Only this store's own temp names, and only ones older than
   * `ORPHANED_TEMP_AFTER_MS`, so a concurrent writer's in-flight temp file is
   * never at risk. Entirely best-effort: this is litter collection, and a write
   * must not fail because a directory listing did.
   */
  private async reapOrphanedTempFiles(): Promise<void> {
    const now = Date.now();
    const last = lastTempSweepAt.get(this.filePath);
    if (last !== undefined && now - last < TEMP_SWEEP_INTERVAL_MS) return;
    lastTempSweepAt.set(this.filePath, now);

    const prefix = `${basename(this.filePath)}.tmp.`;
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const path = join(this.dir, name);
      try {
        const stat = await fs.stat(path);
        if (now - stat.mtimeMs <= ORPHANED_TEMP_AFTER_MS) continue;
      } catch {
        continue; // vanished between the listing and the stat
      }
      await fs.rm(path, { force: true }).catch(() => undefined);
    }
  }
}
