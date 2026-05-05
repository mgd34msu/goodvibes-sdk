import { randomUUID } from 'node:crypto';
import { promises as fs, existsSync } from 'fs';
import { dirname } from 'path';
import { summarizeError } from '../utils/error-display.js';

/**
 * PersistentStore — generic JSON file persistence with atomic writes.
 *
 * Handles lazy loading, atomic writes via a temporary file, and ensures the
 * directory hierarchy exists. Invalid JSON and write failures are thrown so
 * callers do not mistake corrupted state for an empty store or persisted write.
 */
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

  /** Atomically persist data to disk. */
  async persist(data: T): Promise<void> {
    if (this.inMemory) {
      this.memoryData = structuredClone(data);
      return;
    }
    await fs.mkdir(this.dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${randomUUID()}`;
    const content = JSON.stringify(data, null, 2) + '\n';
    try {
      await fs.writeFile(tmpPath, content, 'utf-8');
      await fs.rename(tmpPath, this.filePath);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
