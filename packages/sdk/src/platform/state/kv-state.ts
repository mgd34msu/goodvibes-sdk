import { existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { randomBytes } from 'crypto';
import { JsonFileStore } from './json-file-store.js';
import { StoreWriteQueue } from './store-write-queue.js';
import { summarizeError } from '../utils/error-display.js';

/**
 * Reserved keys that cannot be set by callers.
 */
const RESERVED_KEYS = new Set(['id', 'started_at', '__proto__', 'constructor', 'prototype']);

/**
 * The only filenames this module's housekeeping will ever touch.
 *
 * The state directory is SHARED with live, unrelated data, `retries.json`,
 * `agent-tracking.json`, `workflows/`, which is exactly why the append-only
 * retention registry deliberately excludes the whole directory. Nothing outside
 * this one shape is listed, stat-ed, or removed.
 */
const SESSION_FILE_PATTERN = /^session_[0-9a-f]{8}\.json$/;

/**
 * Count bound: at most this many session files survive a pass, newest-written
 * first. Bounds a burst of short-lived sessions that would otherwise outrun the
 * age bound entirely.
 */
const SESSION_KEEP_COUNT = 50;

/**
 * Age bound: a session file whose last write is older than this belongs to a
 * session nothing is going to resume. Fourteen days is deliberately generous,
 * the file is small, and the count bound is what actually holds the store flat
 * on an active machine.
 */
const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** How often the housekeeping pass repeats while a surface stays up. */
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/** The two bounds a single reap pass applies. `keepCount: null` means "age bound only". */
interface ReapBounds {
  readonly keepCount: number | null;
  readonly maxAgeMs: number;
}

/** What one reap pass actually reclaimed, the disclosure payload. */
interface ReapOutcome {
  readonly filesRemoved: number;
  readonly bytesReclaimed: number;
  /** Removed for being past {@link ReapBounds.maxAgeMs}. */
  readonly agedOut: number;
  /** Removed for falling outside {@link ReapBounds.keepCount}. */
  readonly overCap: number;
}

const NOTHING_REAPED: ReapOutcome = { filesRemoved: 0, bytesReclaimed: 0, agedOut: 0, overCap: 0 };

/** Read a Node errno `code` off an unknown thrown value without widening to `any`. */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Remove one stale session file. Returns true only when THIS call did the
 * removing.
 *
 * ENOENT is success, not failure: another process's pass got there first, which
 * is precisely the outcome wanted. It returns false so the bytes are not counted
 * twice across two concurrent reapers, each pass discloses what it actually
 * reclaimed. Any other error (a permission problem, a locked file) leaves the
 * file alone and is logged at debug; housekeeping never escalates into a failure
 * for the session that triggered it.
 */
function removeSessionFile(path: string, name: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    logger.debug('KVState: could not remove a stale session state file', { file: name, error: summarizeError(err) });
    return false;
  }
}

/**
 * Reap stale `session_<8hex>.json` files from one directory.
 *
 * Idempotent and safe to run concurrently from any number of processes: it
 * decides purely from a fresh directory listing plus each file's own mtime, and
 * every removal tolerates the file already being gone. A second pass over an
 * already-reaped directory finds no candidates and removes nothing.
 *
 * `protectedFileName` is never a candidate, the caller's own session file must
 * survive its own recovery even when it is months old (a long-dormant session
 * being resumed is the exact case the age bound would otherwise destroy).
 */
function reapSessionFiles(
  stateDir: string,
  protectedFileName: string,
  bounds: ReapBounds,
  now: number,
): ReapOutcome {
  let names: string[];
  try {
    names = readdirSync(stateDir);
  } catch {
    // Absent or unreadable directory: nothing to reclaim. Housekeeping is never
    // a reason to fail, or even warn at, the session that triggered it.
    return NOTHING_REAPED;
  }

  const candidates: { readonly path: string; readonly name: string; readonly mtimeMs: number; readonly size: number }[] = [];
  for (const name of names) {
    if (!SESSION_FILE_PATTERN.test(name)) continue;
    if (name === protectedFileName) continue;
    const path = join(stateDir, name);
    try {
      const stats = statSync(path);
      if (!stats.isFile()) continue;
      candidates.push({ path, name, mtimeMs: stats.mtimeMs, size: stats.size });
    } catch {
      // Vanished between readdir and stat, a concurrent pass won the race.
    }
  }

  // Newest first, so "beyond the count bound" means "least recently written".
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let filesRemoved = 0;
  let bytesReclaimed = 0;
  let agedOut = 0;
  let overCap = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const tooOld = now - candidate.mtimeMs > bounds.maxAgeMs;
    const beyondCap = bounds.keepCount !== null && index >= bounds.keepCount;
    if (!tooOld && !beyondCap) continue;
    if (!removeSessionFile(candidate.path, candidate.name)) continue;
    filesRemoved += 1;
    bytesReclaimed += candidate.size;
    if (tooOld) agedOut += 1;
    else overCap += 1;
  }

  return { filesRemoved, bytesReclaimed, agedOut, overCap };
}

/**
 * Say what was reclaimed. Silent deletion is indistinguishable from data loss,
 * so a pass that removed anything reports the counts and the byte total by
 * directory. A pass that removed nothing stays quiet, that is the common case
 * on every boot and every timer tick, and logging it would bury the lines that
 * matter. Counts, a directory path and a byte total only: never file contents.
 */
function discloseReap(stateDir: string, outcome: ReapOutcome): void {
  if (outcome.filesRemoved === 0) return;
  logger.info('KVState: reclaimed stale session state files', {
    stateDir,
    filesRemoved: outcome.filesRemoved,
    agedOut: outcome.agedOut,
    overCap: outcome.overCap,
    bytesReclaimed: outcome.bytesReclaimed,
  });
}

export interface KVStateOptions {
  readonly sessionId?: string | undefined;
  readonly stateDir: string;
  /**
   * A legacy, unscoped stateDir to fall back to for reads when the scoped
   * `stateDir` has no file yet for this session id (dual-read, one release
   * only, see the session-surface migration, runtime/session-migration.ts).
   * Consulted ONLY when the scoped file is absent; a hit is copied forward
   * into the scoped location on the next persist, so subsequent reads never
   * need the fallback again. Copy-forward never moves or deletes its source, so
   * this directory's `session_*.json` files would otherwise strand there
   * permanently, nothing else in the SDK reclaims them. The housekeeping sweep
   * therefore applies the AGE bound (and only the age bound) here as well; see
   * `KVState.sweep` for why a count bound would be unsafe in a directory that is
   * shared with other products.
   *
   * A legacy file that cannot be read or parsed, or that parses to something
   * other than a state object, is treated as ABSENT (logged, then ignored): the
   * fallback may only ever recover data, never turn junk in the old unscoped
   * directory into a failure for a session that would otherwise have started
   * clean.
   */
  readonly legacyStateDir?: string | undefined;
}

/**
 * KVState, Session-scoped persistent key-value store.
 *
 * Storage: <stateDir>/session_{id}.json
 * Session ID: 8-char hex string, auto-generated if not provided.
 *
 * Features:
 * - Lazy load: defers disk read until first operation.
 * - Atomic persistence: write to temp file then rename.
 * - Debounced auto-persist: 5-second timer after each set().
 * - Bounded store: every session file older than SESSION_MAX_AGE_MS, and every
 *   file past the SESSION_KEEP_COUNT most recent, is reclaimed at recovery and
 *   then on a SWEEP_INTERVAL_MS timer. The instance's own file is exempt.
 */
export class KVState {
  private sessionId: string;
  private stateDir: string;
  private filePath: string;
  /** Basename of this instance's own file, the one name housekeeping must never touch. */
  private readonly fileName: string;
  private data: Record<string, unknown> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private loadPromise: Promise<void> | null = null;
  private readonly store: JsonFileStore<Record<string, unknown>>;
  /** Legacy unscoped store to fall back to for reads only; undefined when no legacyStateDir was given or it is identical to the scoped stateDir. */
  private readonly legacyStore: JsonFileStore<Record<string, unknown>> | undefined;
  /** The legacy unscoped state DIRECTORY, kept for the age-bounded sweep; undefined whenever legacyStore is. */
  private readonly legacyStateDir: string | undefined;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private housekeepingStarted = false;
  /** Whole-file writes run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();

  constructor(options: KVStateOptions) {
    if (!options.stateDir || options.stateDir.trim().length === 0) {
      throw new Error('KVState requires a non-empty stateDir');
    }
    this.sessionId = options.sessionId ?? KVState.generateId();
    this.stateDir = options.stateDir;
    this.fileName = `session_${this.sessionId}.json`;
    this.filePath = join(this.stateDir, this.fileName);
    this.store = new JsonFileStore(this.filePath);
    const legacyDir = options.legacyStateDir && options.legacyStateDir !== this.stateDir
      ? options.legacyStateDir
      : undefined;
    this.legacyStore = legacyDir === undefined ? undefined : new JsonFileStore(join(legacyDir, this.fileName));
    this.legacyStateDir = legacyDir;
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
    // Recovery point. Loading, not construction, is when the process actually
    // re-attaches to the state directory, and it is also the first moment this
    // instance's own file is known and can be exempted. Construction only
    // records paths: tools/index.ts builds a KVState during tool registration
    // and agents/session.ts builds one per agent spawn, and neither of those
    // has recovered anything yet, so neither should be doing filesystem work on
    // the caller's synchronous construction path.
    this.startHousekeeping();

    const loaded = this.validateLoaded(await this.store.load(), this.filePath, 'throw');
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
        legacyLoaded = this.validateLoaded(await this.legacyStore.load(), 'legacy state file', 'absent');
      } catch (err) {
        logger.warn('KVState: legacy state file unreadable, ignoring it and starting clean', {
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

  /**
   * Write the session file, after every write already queued has finished.
   *
   * There are two writers and nothing ordered them: the 5-second debounce armed
   * by `set`/`clear`, and `dispose()`, which clears the timer and writes
   * directly. Clearing a timer that has ALREADY fired stops nothing, so an
   * agent that finishes just after a debounced write started has two writes in
   * flight, and `JsonFileStore.save` renames atomically without saying which
   * rename lands last. Unordered, the earlier write's older view can land second
   * and put back a key `clear` removed, which a resumed session then reads as
   * still set.
   *
   * `this.data` is passed by reference, as it always was: `save` serialises it
   * when the write RUNS, so each queued write emits a view at least as new as
   * the one before it. Only the order was missing.
   */
  async persist(): Promise<void> {
    const data = this.data;
    if (data === null) return;
    await this.writes.run(() => this.store.save(data));
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

  /**
   * Count-bounded reap of a state directory, on demand.
   *
   * This is NOT what keeps the store bounded, for a long time nothing called
   * it, and every session file the SDK had ever written accumulated forever.
   * The bounds are now enforced by each instance's own housekeeping (see
   * {@link KVState.load}), which runs both this count bound and an age bound at
   * recovery and then on a timer. This static form survives for callers that
   * want an explicit count-only pass, and now shares the same idempotent,
   * concurrency-tolerant, disclosed implementation instead of its own
   * unguarded `unlinkSync`.
   *
   * No file is exempt here: the caller names the directory and the keep count,
   * and nothing in a bare static call identifies a "current" session.
   */
  static cleanupOldSessions(keepCount: number, options: Pick<KVStateOptions, 'stateDir'>): void {
    const stateDir = readKVStateDir(options);
    discloseReap(
      stateDir,
      reapSessionFiles(stateDir, '', { keepCount, maxAgeMs: Number.POSITIVE_INFINITY }, Date.now()),
    );
  }

  async dispose(): Promise<void> {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    await this.persist();
  }

  /**
   * Validate a loaded session file by its parsed SHAPE, not by the file having
   * existed and parsed.
   *
   * JsonFileStore already rejects bytes that are not JSON at all, which covers a
   * zero-byte file, a truncated object and a page of NULs. It does not cover
   * bytes that parse to something that is not a state record: `null`, `[]`,
   * `123`, `"…"`. A crash can leave any of those, and every one of them would
   * otherwise be installed as `this.data` and served to callers as if it were
   * their session state, `list()` would spread an array, `get()` would read
   * properties off a number.
   *
   * `onInvalid: 'throw'` is used for the SCOPED file, matching this class's
   * existing contract that a corrupt current-session file is a hard failure
   * rather than a silently substituted blank session. `'absent'` is used for the
   * LEGACY fallback, matching its documented rule that the fallback may only
   * ever recover data, never turn junk in the old unscoped directory into a
   * failure for a session that would otherwise have started clean.
   */
  private validateLoaded(
    loaded: Record<string, unknown> | null,
    label: string,
    onInvalid: 'throw' | 'absent',
  ): Record<string, unknown> | null {
    if (loaded === null || loaded === undefined) return null;
    if (typeof loaded === 'object' && !Array.isArray(loaded)) return loaded;
    if (onInvalid === 'throw') {
      throw new Error(`KVState failed to load ${label}: parsed content is not a session state object`);
    }
    logger.warn('KVState: legacy state file is not a session state object, ignoring it and starting clean', {
      sessionId: this.sessionId,
    });
    return null;
  }

  /**
   * Start this instance's housekeeping: one pass now, then a pass every
   * {@link SWEEP_INTERVAL_MS}.
   *
   * The timer exists because startup-only housekeeping in a process that stays
   * up for days reclaims nothing after its first minute, a long-lived surface
   * spawning agents all week would cross both bounds without ever restarting.
   * It is unref'd, so it can never be the reason a process refuses to exit, and
   * `dispose()` clears it.
   *
   * Runs at most once per instance. Several KVState instances in one process may
   * point at the same directory (the surface's own, plus one per agent); every
   * pass is idempotent and race-tolerant, so the overlap costs a directory
   * listing and nothing else.
   */
  private startHousekeeping(): void {
    if (this.housekeepingStarted) return;
    this.housekeepingStarted = true;
    this.sweep();
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /**
   * One housekeeping pass over the scoped directory and, when configured, the
   * legacy unscoped one.
   *
   * The legacy directory gets the AGE bound only, never the count bound. That
   * directory is unscoped and therefore SHARED: a second product working in the
   * same working directory dual-reads its own `session_<id>.json` out of it and
   * has not necessarily copied it forward yet. A count bound orders files by
   * recency across all of those products at once, so it could delete a
   * two-day-old file belonging to a session another surface resumes tomorrow.
   * The age bound cannot: a file untouched for the full TTL belongs to a session
   * no surface has resumed in that whole window, and the dual-read only ever
   * fires for the exact session id being resumed. Leaving the legacy directory
   * entirely unswept was the other option and is not acceptable, copy-forward
   * never deletes the source, so those files strand there permanently and
   * nothing else in the SDK reclaims them.
   *
   * Never throws: a housekeeping problem must not become a failure of the
   * session that triggered it.
   */
  private sweep(): void {
    try {
      const now = Date.now();
      discloseReap(
        this.stateDir,
        reapSessionFiles(this.stateDir, this.fileName, { keepCount: SESSION_KEEP_COUNT, maxAgeMs: SESSION_MAX_AGE_MS }, now),
      );
      if (this.legacyStateDir !== undefined) {
        discloseReap(
          this.legacyStateDir,
          reapSessionFiles(this.legacyStateDir, this.fileName, { keepCount: null, maxAgeMs: SESSION_MAX_AGE_MS }, now),
        );
      }
    } catch (err) {
      logger.debug('KVState: session state housekeeping pass failed', { error: summarizeError(err) });
    }
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
