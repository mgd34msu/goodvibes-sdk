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
