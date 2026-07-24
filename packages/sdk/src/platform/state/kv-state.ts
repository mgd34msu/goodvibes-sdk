import { existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { randomBytes } from 'crypto';
import { JsonFileStore } from './json-file-store.js';
import { summarizeError } from '../utils/error-display.js';

/**
 * Reserved keys that cannot be set by callers.
 */
const RESERVED_KEYS = new Set(['id', 'started_at', '__proto__', 'constructor', 'prototype']);

export interface KVStateOptions {
  readonly sessionId?: string | undefined;
  readonly stateDir: string;
  /**
   * A legacy, unscoped stateDir to fall back to for reads when the scoped
   * `stateDir` has no file yet for this session id (dual-read, one release
   * only — see the session-surface migration, runtime/session-migration.ts).
   * Consulted ONLY when the scoped file is absent; a hit is copied forward
   * into the scoped location on the next persist, so subsequent reads never
   * need the fallback again. The legacy file itself is left in place — this
   * class never deletes or moves it.
   *
   * A legacy file that cannot be read or parsed is treated as ABSENT (logged,
   * then ignored): the fallback may only ever recover data, never turn junk in
   * the old unscoped directory into a failure for a session that would
   * otherwise have started clean.
   */
  readonly legacyStateDir?: string | undefined;
}

/**
 * KVState — Session-scoped persistent key-value store.
 *
 * Storage: <stateDir>/session_{id}.json
 * Session ID: 8-char hex string, auto-generated if not provided.
 *
 * Features:
 * - Lazy load: defers disk read until first operation.
 * - Atomic persistence: write to temp file then rename.
 * - Debounced auto-persist: 5-second timer after each set().
 */
export class KVState {
  private sessionId: string;
  private stateDir: string;
  private filePath: string;
  private data: Record<string, unknown> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private loadPromise: Promise<void> | null = null;
  private readonly store: JsonFileStore<Record<string, unknown>>;
  /** Legacy unscoped store to fall back to for reads only; undefined when no legacyStateDir was given or it is identical to the scoped stateDir. */
  private readonly legacyStore: JsonFileStore<Record<string, unknown>> | undefined;

  constructor(options: KVStateOptions) {
    if (!options.stateDir || options.stateDir.trim().length === 0) {
      throw new Error('KVState requires a non-empty stateDir');
    }
    this.sessionId = options.sessionId ?? KVState.generateId();
    this.stateDir = options.stateDir;
    this.filePath = join(this.stateDir, `session_${this.sessionId}.json`);
    this.store = new JsonFileStore(this.filePath);
    this.legacyStore = (options.legacyStateDir && options.legacyStateDir !== this.stateDir)
      ? new JsonFileStore(join(options.legacyStateDir, `session_${this.sessionId}.json`))
      : undefined;
  }

  async get(keys: string[]): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(this.data!, key)) {
        result[key] = this.data![key];
      }
    }
    return result;
  }

  async set(values: Record<string, unknown>): Promise<void> {
    await this.ensureLoaded();
    for (const [key, value] of Object.entries(values)) {
      if (RESERVED_KEYS.has(key)) {
        logger.debug('KVState: ignoring reserved key', { key });
        continue;
      }
      this.data![key] = value;
    }
    this.schedulePersist();
  }

  async list(prefix?: string): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    if (!prefix) {
      return { ...this.data! };
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.data!)) {
      if (key.startsWith(prefix)) {
        result[key] = value;
      }
    }
    return result;
  }

  async clear(keys: string[]): Promise<void> {
    await this.ensureLoaded();
    let changed = false;
    for (const key of keys) {
      if (RESERVED_KEYS.has(key)) continue;
      if (Object.prototype.hasOwnProperty.call(this.data!, key)) {
        delete this.data![key];
        changed = true;
      }
    }
    if (changed) this.schedulePersist();
  }

  async load(): Promise<void> {
    const loaded = await this.store.load();
    if (loaded) {
      this.data = loaded;
      if (!this.data.id) this.data.id = this.sessionId;
      if (!this.data.started_at) this.data.started_at = new Date().toISOString();
      return;
    }

    if (this.legacyStore) {
      // A corrupt/unreadable legacy file is treated as ABSENT, not as an
      // error: before this dual-read existed, that file was never opened at
      // all and a new session simply started clean. Letting JsonFileStore's
      // throw escape here would turn "there is junk in the old unscoped state
      // dir" into a hard failure of an unrelated new session. Logged once (a
      // KVState instance loads at most once) so the junk is still visible.
      let legacyLoaded: Record<string, unknown> | null = null;
      try {
        legacyLoaded = await this.legacyStore.load();
      } catch (err) {
        logger.warn('KVState: legacy state file unreadable — ignoring it and starting clean', {
          sessionId: this.sessionId,
          error: summarizeError(err),
        });
        legacyLoaded = null;
      }
      if (legacyLoaded) {
        this.data = legacyLoaded;
        if (!this.data.id) this.data.id = this.sessionId;
        if (!this.data.started_at) this.data.started_at = new Date().toISOString();
        // Copy forward into the scoped location so a future load never needs
        // the legacy fallback again. The legacy file is left in place.
        this.schedulePersist();
        return;
      }
    }

    this.data = {
      id: this.sessionId,
      started_at: new Date().toISOString(),
    };
  }

  async persist(): Promise<void> {
    if (this.data === null) return;
    await this.store.save(this.data);
  }

  getSessionId(): string {
    return this.sessionId;
  }

  static listSessions(options: Pick<KVStateOptions, 'stateDir'>): string[] {
    const stateDir = readKVStateDir(options);
    if (!existsSync(stateDir)) return [];
    return readdirSync(stateDir)
      .filter(f => /^session_[0-9a-f]{8}\.json$/.test(f))
      .map(f => f.replace(/^session_/, '').replace(/\.json$/, ''))
      .sort();
  }

  static cleanupOldSessions(keepCount: number, options: Pick<KVStateOptions, 'stateDir'>): void {
    const stateDir = readKVStateDir(options);
    if (!existsSync(stateDir)) return;
    const files = readdirSync(stateDir)
      .filter(f => /^session_[0-9a-f]{8}\.json$/.test(f))
      .map(f => {
        const path = join(stateDir, f);
        return {
          name: f,
          path,
          mtime: statSync(path).mtimeMs,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);

    const toDelete = files.slice(keepCount);
    for (const f of toDelete) {
      unlinkSync(f.path);
      logger.debug('KVState: cleaned up expired session', { file: f.name });
    }
  }

  async dispose(): Promise<void> {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.data !== null) return;
    if (!this.loadPromise) {
      this.loadPromise = this.load().then(() => {
        this.loadPromise = null;
      });
    }
    return this.loadPromise;
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist().catch(err => {
        logger.warn('KVState: scheduled persist failed', { filePath: this.filePath, error: summarizeError(err) });
      });
    }, 5000);
    this.persistTimer.unref?.();
  }

  private static generateId(): string {
    const bytes = new Uint8Array(4);
    const rand = randomBytes(4);
    bytes.set(rand);

    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

function readKVStateDir(options: Pick<KVStateOptions, 'stateDir'>): string {
  if (!options.stateDir || options.stateDir.trim().length === 0) {
    throw new Error('KVState requires a non-empty stateDir');
  }
  return options.stateDir;
}
