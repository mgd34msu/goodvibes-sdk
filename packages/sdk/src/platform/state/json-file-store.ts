import { randomUUID } from 'node:crypto';
import { promises as fs, existsSync, mkdirSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { summarizeError } from '../utils/error-display.js';

/**
 * JsonFileStore, generic JSON file persistence with atomic writes.
 *
 * Handles lazy loading, atomic writes via a temporary file, and ensures the
 * directory hierarchy exists. Invalid JSON and write failures are thrown so
 * callers do not mistake corrupted state for an empty store or persisted write.
 */
export class JsonFileStore<T> {
  constructor(private readonly filePath: string) {}

  /** Load JSON data from disk, or return null if the file does not exist. */
  async load(): Promise<T | null> {
    if (!existsSync(this.filePath)) {
      return null;
    }

    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new Error(`JsonFileStore failed to load ${this.filePath}: ${summarizeError(err)}`);
    }
  }

  /**
   * Atomically and durably persist data to disk.
   *
   * `rename(2)` alone only makes the swap atomic for concurrent readers; it
   * does not make it survive a power loss. Both fsyncs are what turn the
   * temp+rename into a crash-safe write: the first flushes the temp file's
   * bytes before it is ever named, the second flushes the directory entry so
   * the rename itself is durable. Without them a hard crash can leave the
   * renamed file with unwritten (zero-filled or truncated) contents, which the
   * next `load()` sees as unparseable JSON.
   */
  async save(data: T): Promise<void> {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${randomUUID()}`;
    const content = JSON.stringify(data, null, 2) + '\n';
    try {
      const handle = await fs.open(tmpPath, 'w');
      try {
        await handle.writeFile(content, 'utf-8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmpPath, this.filePath);
      await syncDirectory(dir);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/**
 * fsync a directory so a rename into it is durable.
 *
 * Opening a directory for reading is POSIX; Windows rejects it, and there is no
 * directory-fsync equivalent there, so a failure to open is not an error the
 * caller should see.
 */
async function syncDirectory(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    // Best effort: the file contents are already fsynced above.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
