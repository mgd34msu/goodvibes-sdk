import { promises as fs, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/**
 * PersistentStore — generic JSON file persistence with atomic writes.
 *
 * Handles lazy loading, atomic writes via a temporary file, and ensures the
 * directory hierarchy exists. Errors are logged but not re‑thrown so that the
 * caller can decide how to recover.
 */
export class PersistentStore<T extends Record<string, unknown>> {
  private readonly filePath: string;
  private readonly dir: string;
  private readonly inMemory: boolean;
  private memoryData: T | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.dir = join(filePath, '..');
    this.inMemory = filePath === ':memory:';
  }

  /** Load JSON data from disk, or return null if the file does not exist or is invalid. */
  async load(): Promise<T | null> {
    if (this.inMemory) return this.memoryData;
    if (!existsSync(this.filePath)) {
      return null;
    }
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch (err) {
      logger.debug('PersistentStore: failed to load, starting fresh', { file: this.filePath, error: summarizeError(err) });
      return null;
    }
  }

  /** Atomically persist data to disk. */
  async persist(data: T): Promise<void> {
    if (this.inMemory) {
      this.memoryData = structuredClone(data);
      return;
    }
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      const content = JSON.stringify(data, null, 2) + '\n';
      await fs.writeFile(tmpPath, content, 'utf-8');
      // renameSync is atomic on POSIX
      await fs.rename(tmpPath, this.filePath);
    } catch (err) {
      logger.debug('PersistentStore: persist failed (non-fatal)', { file: this.filePath, error: summarizeError(err) });
    }
  }
}
