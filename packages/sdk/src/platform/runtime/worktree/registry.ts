import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { GitService } from '../../git/service.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { resolveScopedDirectory } from '../surface-root.js';
import type { WorktreeSetupResult } from './setup.js';

/** Current schema version of the persisted worktree store. */
const STORE_VERSION = 1;

/**
 * Age TTL for a `kept` TOMBSTONE — a record for a worktree that is no longer
 * on disk but that the user deliberately asked to preserve.
 *
 * 90 days. A tombstone is not immortal: it is a note-to-self about work that
 * was set aside, and the register it lives in is read on every worktree
 * listing. A quarter is far longer than any "I'll come back to this" horizon
 * anyone actually honours, and the underlying git BRANCH is never touched by
 * this expiry — only the registry note about it goes away, so nothing the user
 * asked to keep is destroyed by the TTL.
 *
 * A `kept` record whose worktree is STILL PRESENT is a live worktree, never a
 * tombstone, and is never aged out at any age.
 */
const TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Count cap on `kept` tombstones. Sized well above any plausible number of
 * deliberately-preserved worktrees (a person tracks a handful, not hundreds)
 * so it only trims a register that has been leaking. Least-recently-updated
 * tombstones are dropped first.
 */
const MAX_TOMBSTONES = 200;

/**
 * Age TTL for a registry file preserved aside because it could not be read.
 * 30 days: these are forensic, and the person who has to explain a corrupt
 * register may not look for weeks.
 */
const PRESERVED_STORE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Count cap on preserved-aside registry files — a repeating fault can mint one per read, so the age TTL alone is not a bound. Newest are kept. */
const MAX_PRESERVED_STORES = 10;

/** Suffix marking a registry file preserved aside for forensics. */
const PRESERVED_SUFFIX = '.unreadable';

const WORKTREE_STATES: ReadonlySet<string> = new Set<ManagedWorktreeState>([
  'active',
  'paused',
  'kept',
  'discard',
  'pending-cleanup',
]);

const WORKTREE_KINDS: ReadonlySet<string> = new Set<ManagedWorktreeKind>(['agent', 'orchestrator', 'manual']);

export type ManagedWorktreeState = 'active' | 'paused' | 'kept' | 'discard' | 'pending-cleanup';
export type ManagedWorktreeKind = 'agent' | 'orchestrator' | 'manual';

export interface ManagedWorktreeMeta {
  readonly path: string;
  readonly kind: ManagedWorktreeKind;
  readonly state: ManagedWorktreeState;
  readonly ownerId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly updatedAt: number;
  /**
   * Cold-start setup outcome for this worktree, when setup ran (on creation or
   * a re-run). Persisted so a failed setup is a VISIBLE worktree/fleet-node
   * state, never silent — surfaces read it straight off the worktree record
   * (worktrees.snapshot). Absent when no setup has ever run for this worktree.
   */
  readonly setup?: WorktreeSetupResult | undefined;
}

interface WorktreeStore {
  readonly version: 1;
  readonly records: Record<string, ManagedWorktreeMeta>;
}

export interface WorktreeStatusRecord extends ManagedWorktreeMeta {
  readonly branch: string;
  readonly head: string;
}

export interface WorktreeOwnershipSummary {
  readonly total: number;
  readonly active: number;
  readonly paused: number;
  readonly kept: number;
  readonly discard: number;
  readonly pendingCleanup: number;
  readonly sessionAttached: number;
  readonly taskAttached: number;
  readonly agentOwned: number;
  readonly orchestratorOwned: number;
  readonly manualOwned: number;
}

export interface WorktreeAttachmentReview {
  readonly targetKind: 'session' | 'task';
  readonly targetId: string;
  readonly total: number;
  readonly active: number;
  readonly paused: number;
  readonly kept: number;
  readonly discard: number;
  readonly pendingCleanup: number;
  readonly records: readonly ManagedWorktreeMeta[];
}

export interface WorktreeRegistryPaths {
  readonly workingDirectory: string;
  readonly surfaceRoot?: string | undefined;
}

function getStorePath(workingDirectory: string, surfaceRoot?: string): string {
  return resolveScopedDirectory(workingDirectory, surfaceRoot, 'worktrees.json');
}

function defaultStore(): WorktreeStore {
  return { version: 1, records: {} };
}

function normalizePath(path: string, workingDirectory: string): string {
  return resolve(workingDirectory, path);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate one persisted record by CONTENT. Returns null when the record cannot be trusted. */
function validateRecord(value: unknown): ManagedWorktreeMeta | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const path = candidate['path'];
  const kind = candidate['kind'];
  const state = candidate['state'];
  const updatedAt = candidate['updatedAt'];
  if (typeof path !== 'string' || path.length === 0) return null;
  if (typeof kind !== 'string' || !WORKTREE_KINDS.has(kind)) return null;
  if (typeof state !== 'string' || !WORKTREE_STATES.has(state)) return null;
  if (!isFiniteNumber(updatedAt)) return null;
  const ownerId = candidate['ownerId'];
  const sessionId = candidate['sessionId'];
  const taskId = candidate['taskId'];
  const setup = candidate['setup'];
  return {
    path,
    // Both narrowed above against their closed literal sets, so these are
    // validated narrowings rather than blind assertions.
    kind: kind as ManagedWorktreeKind,
    state: state as ManagedWorktreeState,
    ...(typeof ownerId === 'string' ? { ownerId } : {}),
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    ...(typeof taskId === 'string' ? { taskId } : {}),
    // The setup receipt is an opaque payload owned by setup.ts; it is carried
    // through when it is an object and dropped when it is not, so a malformed
    // receipt cannot make an otherwise-good record unreadable.
    ...(setup !== null && typeof setup === 'object' ? { setup: setup as WorktreeSetupResult } : {}),
    updatedAt,
  };
}

/** The verdict of reading the persisted registry file. */
type StoreVerdict =
  | { readonly kind: 'ok'; readonly store: WorktreeStore; readonly droppedRecords: number }
  | { readonly kind: 'unreadable'; readonly detail: string; readonly bytes: number };

/**
 * Parse and content-validate the registry file.
 *
 * A zero-byte, truncated or otherwise torn file (a crash mid-write) is
 * REJECTED, never served as if it were an empty register.
 *
 * Version policy: a file at or below the current version is read, because
 * every field is validated record by record right here. A file written by a
 * NEWER runtime is not interpreted — its records may carry meanings this code
 * would get wrong — and is preserved aside rather than overwritten.
 */
function parseStore(text: string): StoreVerdict {
  if (text.trim().length === 0) {
    return { kind: 'unreadable', detail: 'empty or whitespace-only file', bytes: Buffer.byteLength(text, 'utf-8') };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      kind: 'unreadable',
      detail: 'unparseable JSON (truncated or torn write)',
      bytes: Buffer.byteLength(text, 'utf-8'),
    };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'unreadable', detail: 'top-level value is not an object', bytes: Buffer.byteLength(text, 'utf-8') };
  }
  const candidate = raw as Record<string, unknown>;
  const version = candidate['version'];
  if (!isFiniteNumber(version)) {
    return { kind: 'unreadable', detail: 'missing or non-numeric version', bytes: Buffer.byteLength(text, 'utf-8') };
  }
  if (version > STORE_VERSION) {
    return {
      kind: 'unreadable',
      detail: `written by a newer runtime (version ${version})`,
      bytes: Buffer.byteLength(text, 'utf-8'),
    };
  }
  const rawRecords = candidate['records'];
  if (rawRecords === null || typeof rawRecords !== 'object' || Array.isArray(rawRecords)) {
    return { kind: 'unreadable', detail: 'records is not an object', bytes: Buffer.byteLength(text, 'utf-8') };
  }
  const records: Record<string, ManagedWorktreeMeta> = {};
  let droppedRecords = 0;
  for (const [key, value] of Object.entries(rawRecords as Record<string, unknown>)) {
    const record = validateRecord(value);
    if (!record) {
      droppedRecords += 1;
      continue;
    }
    records[key] = record;
  }
  return { kind: 'ok', store: { version: 1, records }, droppedRecords };
}

/**
 * Preserve an unreadable registry file aside so it is recoverable, instead of
 * letting the next write overwrite it. Returns the path it was moved to, or
 * null when the move failed.
 */
function preserveUnreadableStore(storePath: string, detail: string, bytes: number): string | null {
  const preservedPath = `${storePath}${PRESERVED_SUFFIX}-${Date.now()}-${process.pid}`;
  try {
    renameSync(storePath, preservedPath);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return null; // Another process already moved it.
    logger.error('worktree registry: failed to preserve unreadable register aside', {
      storePath,
      error: summarizeError(error),
    });
    return null;
  }
  logger.warn('worktree registry: register failed content validation — preserved aside, not overwritten', {
    storePath,
    preservedPath,
    detail,
    bytes,
  });
  reapPreservedStores(storePath);
  return preservedPath;
}

/**
 * Bound the preserved-aside registry files: an age TTL plus a count cap.
 * ENOENT on removal is success, so two processes sweeping at once is safe.
 */
function reapPreservedStores(storePath: string, now: number = Date.now()): { expired: number; overCap: number } {
  const dir = dirname(storePath);
  const prefix = `${basename(storePath)}${PRESERVED_SUFFIX}-`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { expired: 0, overCap: 0 };
  }
  const preserved: Array<{ path: string; at: number }> = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const path = join(dir, entry);
    try {
      preserved.push({ path, at: statSync(path).mtimeMs });
    } catch {
      // Vanished between readdir and stat: another process already reaped it.
    }
  }

  let expired = 0;
  const withinTtl: Array<{ path: string; at: number }> = [];
  for (const file of preserved) {
    if (now - file.at > PRESERVED_STORE_MAX_AGE_MS) {
      if (removeFile(file.path)) expired += 1;
      continue;
    }
    withinTtl.push(file);
  }

  let overCap = 0;
  if (withinTtl.length > MAX_PRESERVED_STORES) {
    const oldestFirst = [...withinTtl].sort((a, b) => a.at - b.at);
    for (const file of oldestFirst.slice(0, withinTtl.length - MAX_PRESERVED_STORES)) {
      if (removeFile(file.path)) overCap += 1;
    }
  }

  if (expired + overCap > 0) {
    logger.info('worktree registry: removed expired preserved registers', { dir, expired, overCap });
  }
  return { expired, overCap };
}

/** Delete a file, treating ENOENT as success. Returns true when the file is gone afterwards. */
function removeFile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return true;
    logger.warn('worktree registry: failed to remove file during housekeeping', { path, error: summarizeError(error) });
    return false;
  }
}

/**
 * Read the register, validating by content.
 *
 * A missing file is a normal empty register. A file that exists but cannot be
 * trusted is DISCLOSED and preserved aside (so the `kept` tombstones the user
 * asked for stay recoverable) before an empty register is returned — the old
 * behaviour discarded them silently.
 */
function readStore(storePath: string): WorktreeStore {
  let text: string;
  try {
    text = readFileSync(storePath, 'utf-8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ENOENT') {
      logger.warn('worktree registry: could not read register', { storePath, error: summarizeError(error) });
    }
    return defaultStore();
  }

  const verdict = parseStore(text);
  if (verdict.kind === 'unreadable') {
    preserveUnreadableStore(storePath, verdict.detail, verdict.bytes);
    return defaultStore();
  }
  if (verdict.droppedRecords > 0) {
    logger.warn('worktree registry: dropped register records that failed content validation', {
      storePath,
      droppedRecords: verdict.droppedRecords,
    });
  }
  return verdict.store;
}

export function listPersistedWorktreeMeta(options: WorktreeRegistryPaths): ManagedWorktreeMeta[] {
  return Object.values(readStore(getStorePath(options.workingDirectory, options.surfaceRoot)).records)
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function getPersistedWorktreeMeta(path: string, options: WorktreeRegistryPaths): ManagedWorktreeMeta | null {
  const normalized = normalizePath(path, options.workingDirectory);
  return readStore(getStorePath(options.workingDirectory, options.surfaceRoot)).records[normalized] ?? null;
}

export function reviewWorktreeAttachments(
  targetKind: 'session' | 'task',
  targetId: string,
  options: WorktreeRegistryPaths,
): WorktreeAttachmentReview {
  const records = listPersistedWorktreeMeta(options).filter((record) => (
    targetKind === 'session' ? record.sessionId === targetId : record.taskId === targetId
  ));
  return records.reduce<WorktreeAttachmentReview>((summary, record) => ({
    ...summary,
    total: summary.total + 1,
    active: summary.active + (record.state === 'active' ? 1 : 0),
    paused: summary.paused + (record.state === 'paused' ? 1 : 0),
    kept: summary.kept + (record.state === 'kept' ? 1 : 0),
    discard: summary.discard + (record.state === 'discard' ? 1 : 0),
    pendingCleanup: summary.pendingCleanup + (record.state === 'pending-cleanup' ? 1 : 0),
    records: [...summary.records, record],
  }), {
    targetKind,
    targetId,
    total: 0,
    active: 0,
    paused: 0,
    kept: 0,
    discard: 0,
    pendingCleanup: 0,
    records: [],
  });
}

export function summarizeWorktreeOwnership(records: readonly ManagedWorktreeMeta[]): WorktreeOwnershipSummary {
  return records.reduce<WorktreeOwnershipSummary>((summary, record) => ({
    total: summary.total + 1,
    active: summary.active + (record.state === 'active' ? 1 : 0),
    paused: summary.paused + (record.state === 'paused' ? 1 : 0),
    kept: summary.kept + (record.state === 'kept' ? 1 : 0),
    discard: summary.discard + (record.state === 'discard' ? 1 : 0),
    pendingCleanup: summary.pendingCleanup + (record.state === 'pending-cleanup' ? 1 : 0),
    sessionAttached: summary.sessionAttached + (record.sessionId ? 1 : 0),
    taskAttached: summary.taskAttached + (record.taskId ? 1 : 0),
    agentOwned: summary.agentOwned + (record.kind === 'agent' ? 1 : 0),
    orchestratorOwned: summary.orchestratorOwned + (record.kind === 'orchestrator' ? 1 : 0),
    manualOwned: summary.manualOwned + (record.kind === 'manual' ? 1 : 0),
  }), {
    total: 0,
    active: 0,
    paused: 0,
    kept: 0,
    discard: 0,
    pendingCleanup: 0,
    sessionAttached: 0,
    taskAttached: 0,
    agentOwned: 0,
    orchestratorOwned: 0,
    manualOwned: 0,
  });
}

/**
 * Write the register atomically: temp file, then rename.
 *
 * HONEST SCOPE — this makes each write ALL-OR-NOTHING, so a crash mid-write
 * can no longer leave a torn register (it leaves at most a stray temp file,
 * which the next write of that pid replaces and which is never read). It does
 * NOT make the read-modify-write cycle cross-process safe: two processes that
 * read, mutate and write concurrently still resolve last-writer-wins, and the
 * loser's update is lost. Cross-process safety would need a lock file around
 * the whole cycle, which lives outside this module. Improved, not achieved.
 */
function writeStore(store: WorktreeStore, storePath: string): void {
  mkdirSync(dirname(storePath), { recursive: true });
  const tempPath = `${storePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
    renameSync(tempPath, storePath);
  } catch (error) {
    removeFile(tempPath);
    throw error;
  }
}

function classifyWorktreePath(path: string, workingDirectory: string): Pick<ManagedWorktreeMeta, 'kind' | 'ownerId'> {
  const normalized = normalizePath(path, workingDirectory);
  const agentMatch = normalized.match(/[/\\]\.goodvibes[/\\]\.worktrees[/\\]agent-([^/\\]+)$/);
  if (agentMatch) {
    return { kind: 'agent', ownerId: agentMatch[1] };
  }
  if (normalized.includes(`${join('.goodvibes', '.worktrees')}`)) {
    return { kind: 'orchestrator' };
  }
  return { kind: 'manual' };
}

export class WorktreeRegistry {
  private readonly git: GitService;
  private readonly workingDirectory: string;
  private readonly surfaceRoot?: string | undefined;

  public constructor(workingDirectory: string, options?: { readonly surfaceRoot?: string }) {
    this.workingDirectory = workingDirectory;
    this.surfaceRoot = options?.surfaceRoot;
    this.git = new GitService(workingDirectory);
  }

  /**
   * List live worktrees, reconciling the register against `git worktree list`.
   *
   * This is also the register's recurring housekeeping point: surfaces poll it,
   * so reaping here is not startup-only. It reclaims records whose worktree is
   * gone, ages out and count-caps `kept` tombstones, and sweeps expired
   * preserved-aside register files — disclosing every count.
   */
  public async list(): Promise<WorktreeStatusRecord[]> {
    const store = readStore(getStorePath(this.workingDirectory, this.surfaceRoot));
    const listed = await this.git.worktreeList();
    const present = new Set(listed.map((entry) => normalizePath(entry.path, this.workingDirectory)));
    const records: WorktreeStatusRecord[] = listed.map((entry) => {
      const path = normalizePath(entry.path, this.workingDirectory);
      const meta = store.records[path]!;
      const classified = classifyWorktreePath(path, this.workingDirectory);
      return {
        path,
        branch: entry.branch,
        head: entry.head,
        kind: meta?.kind ?? classified.kind,
        state: meta?.state ?? 'active',
        ...(meta?.ownerId ?? classified.ownerId ? { ownerId: meta?.ownerId ?? classified.ownerId } : {}),
        ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
        ...(meta?.taskId ? { taskId: meta.taskId } : {}),
        ...(meta?.setup ? { setup: meta.setup } : {}),
        updatedAt: meta?.updatedAt ?? Date.now(),
      };
    });
    const nextRecords: Record<string, ManagedWorktreeMeta> = {};
    for (const record of records) {
      nextRecords[record.path] = {
        path: record.path,
        kind: record.kind,
        state: record.state,
        ...(record.ownerId ? { ownerId: record.ownerId } : {}),
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        ...(record.taskId ? { taskId: record.taskId } : {}),
        ...(record.setup ? { setup: record.setup } : {}),
        updatedAt: record.updatedAt,
      };
    }
    // REAP: a record whose worktree is no longer on disk has lost its owner.
    // `kept` records are exempt — they are deliberate tombstones — but they get
    // their own age TTL and count cap below so they are bounded rather than
    // immortal. Everything reclaimed here is disclosed.
    let vanished = 0;
    let tombstonesExpired = 0;
    const tombstones: ManagedWorktreeMeta[] = [];
    const now = Date.now();
    for (const [path, meta] of Object.entries(store.records)) {
      if (present.has(path)) continue;
      if (meta.state !== 'kept') {
        vanished += 1;
        continue;
      }
      if (now - meta.updatedAt > TOMBSTONE_MAX_AGE_MS) {
        tombstonesExpired += 1;
        continue;
      }
      tombstones.push(meta);
    }

    let tombstonesOverCap = 0;
    let retainedTombstones = tombstones;
    if (tombstones.length > MAX_TOMBSTONES) {
      retainedTombstones = [...tombstones].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_TOMBSTONES);
      tombstonesOverCap = tombstones.length - retainedTombstones.length;
    }
    for (const meta of retainedTombstones) nextRecords[meta.path] = meta;

    writeStore({ version: 1, records: nextRecords }, getStorePath(this.workingDirectory, this.surfaceRoot));

    const reclaimed = vanished + tombstonesExpired + tombstonesOverCap;
    if (reclaimed > 0) {
      logger.info('worktree registry: reclaimed stale register records', {
        workingDirectory: this.workingDirectory,
        vanished,
        tombstonesExpired,
        tombstonesOverCap,
        total: reclaimed,
      });
    }
    reapPreservedStores(getStorePath(this.workingDirectory, this.surfaceRoot), now);
    return records.sort((a, b) => a.path.localeCompare(b.path));
  }

  public attach(path: string, target: { sessionId?: string; taskId?: string }): void {
    const store = readStore(getStorePath(this.workingDirectory, this.surfaceRoot));
    const normalized = normalizePath(path, this.workingDirectory);
    const existing = store.records[normalized]!;
    const classified = classifyWorktreePath(normalized, this.workingDirectory);
    store.records[normalized] = {
      path: normalized,
      kind: existing?.kind ?? classified.kind,
      state: existing?.state ?? 'active',
      ...(existing?.ownerId ?? classified.ownerId ? { ownerId: existing?.ownerId ?? classified.ownerId } : {}),
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      ...(target.taskId ? { taskId: target.taskId } : {}),
      ...(existing?.setup ? { setup: existing.setup } : {}),
      updatedAt: Date.now(),
    };
    writeStore(store, getStorePath(this.workingDirectory, this.surfaceRoot));
  }

  public setState(path: string, state: ManagedWorktreeState): void {
    const store = readStore(getStorePath(this.workingDirectory, this.surfaceRoot));
    const normalized = normalizePath(path, this.workingDirectory);
    const existing = store.records[normalized]!;
    const classified = classifyWorktreePath(normalized, this.workingDirectory);
    store.records[normalized] = {
      path: normalized,
      kind: existing?.kind ?? classified.kind,
      state,
      ...(existing?.ownerId ?? classified.ownerId ? { ownerId: existing?.ownerId ?? classified.ownerId } : {}),
      ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}),
      ...(existing?.taskId ? { taskId: existing.taskId } : {}),
      ...(existing?.setup ? { setup: existing.setup } : {}),
      updatedAt: Date.now(),
    };
    writeStore(store, getStorePath(this.workingDirectory, this.surfaceRoot));
  }

  /**
   * Record a cold-start setup outcome onto a worktree's record (on creation or
   * a re-run), so a failed setup is a visible, queryable worktree/fleet-node
   * state rather than a lost log. Upserts the record if setup ran before the
   * worktree was otherwise registered.
   */
  public recordSetup(path: string, setup: WorktreeSetupResult): void {
    const store = readStore(getStorePath(this.workingDirectory, this.surfaceRoot));
    const normalized = normalizePath(path, this.workingDirectory);
    const existing = store.records[normalized];
    const classified = classifyWorktreePath(normalized, this.workingDirectory);
    store.records[normalized] = {
      path: normalized,
      kind: existing?.kind ?? classified.kind,
      state: existing?.state ?? 'active',
      ...(existing?.ownerId ?? classified.ownerId ? { ownerId: existing?.ownerId ?? classified.ownerId } : {}),
      ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}),
      ...(existing?.taskId ? { taskId: existing.taskId } : {}),
      setup,
      updatedAt: Date.now(),
    };
    writeStore(store, getStorePath(this.workingDirectory, this.surfaceRoot));
  }

  public async cleanup(path: string): Promise<void> {
    const normalized = isAbsolute(path) ? path : normalizePath(path, this.workingDirectory);
    await this.git.worktreeRemove(normalized);
    const store = readStore(getStorePath(this.workingDirectory, this.surfaceRoot));
    delete store.records[normalized];
    writeStore(store, getStorePath(this.workingDirectory, this.surfaceRoot));
  }

  /**
   * DISCARD actually discards — per the eviction-preserving rules:
   *  1. Any uncommitted state is first COMMITTED onto the worktree's branch
   *     (data safety; a preservation failure refuses the removal rather than
   *     losing work).
   *  2. The worktree DIRECTORY is removed (`git worktree remove`).
   *  3. The BRANCH is kept — never deleted on this path.
   * Returns an honest receipt either way; the record is dropped only when the
   * directory really came off disk.
   */
  public async discard(path: string): Promise<WorktreeDiscardReceipt> {
    const normalized = isAbsolute(path) ? path : normalizePath(path, this.workingDirectory);
    const discardedAt = Date.now();
    const worktreeGit = this.createWorktreeGit(normalized);
    let branch: string | undefined;
    let preservedCommit: string | undefined;
    try {
      branch = (await worktreeGit.branch()).current;
      const status = await worktreeGit.status();
      if (!status.isClean()) {
        await worktreeGit.addAll();
        const commit = await worktreeGit.commit('goodvibes: preserve working state before discard', {
          noVerify: true,
          fallbackIdentity: { name: 'goodvibes', email: 'goodvibes@localhost' },
        });
        preservedCommit = commit.hash;
      }
    } catch (error) {
      // Preservation failed — refuse the removal (losing work is worse than a
      // lingering directory) and say so honestly.
      return {
        path: normalized,
        ok: false,
        ...(branch ? { branch } : {}),
        discardedAt,
        detail: `discard refused: could not preserve uncommitted state (${String(error instanceof Error ? error.message : error)})`,
      };
    }
    try {
      await this.git.worktreeRemove(normalized);
    } catch (error) {
      return {
        path: normalized,
        ok: false,
        ...(branch ? { branch } : {}),
        ...(preservedCommit ? { preservedCommit } : {}),
        discardedAt,
        detail: `discard failed: worktree removal did not complete (${String(error instanceof Error ? error.message : error)})`,
      };
    }
    const store = readStore(getStorePath(this.workingDirectory, this.surfaceRoot));
    delete store.records[normalized];
    writeStore(store, getStorePath(this.workingDirectory, this.surfaceRoot));
    return {
      path: normalized,
      ok: true,
      ...(branch ? { branch } : {}),
      ...(preservedCommit ? { preservedCommit } : {}),
      discardedAt,
      detail: preservedCommit
        ? `worktree removed; uncommitted state preserved as ${preservedCommit.slice(0, 12)} on kept branch ${branch ?? '(unknown)'}`
        : `worktree removed; branch ${branch ?? '(unknown)'} kept`,
    };
  }

  /** Injectable seam for tests: a GitService rooted INSIDE the worktree being discarded. */
  protected createWorktreeGit(worktreePath: string): Pick<GitService, 'branch' | 'status' | 'addAll' | 'commit'> {
    return new GitService(worktreePath);
  }
}

/** The honest record of one discard: what came off disk, what was kept, what was preserved. */
export interface WorktreeDiscardReceipt {
  readonly path: string;
  /** True only when the directory really came off disk. */
  readonly ok: boolean;
  /** The branch that was KEPT (never deleted by discard). */
  readonly branch?: string | undefined;
  /** The preservation commit recorded for uncommitted state, when the tree was dirty. */
  readonly preservedCommit?: string | undefined;
  readonly discardedAt: number;
  readonly detail: string;
}
