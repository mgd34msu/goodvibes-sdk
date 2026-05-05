import { promises as fs, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { summarizeError } from '../utils/error-display.js';

/**
 * JsonFileStore — generic JSON file persistence with atomic writes.
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

  /** Atomically persist data to disk. */
  async save(data: T): Promise<void> {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    const content = JSON.stringify(data, null, 2) + '\n';
    await fs.writeFile(tmpPath, content, 'utf-8');
    renameSync(tmpPath, this.filePath);
  }
}
