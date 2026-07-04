/**
 * manager.ts
 *
 * WorkspaceCheckpointManager — the coarse, whole-workspace rewind layer.
 *
 * Complements (does not replace) FileUndoManager (../../state/file-undo.ts),
 * which stays as the fine-grained, in-memory, per-file /undo layer. This
 * manager persists across sessions, snapshots the ENTIRE workspace tree, and
 * survives process restarts (backed by git objects + a JSON manifest on
 * disk), which is the wrong shape for FileUndoManager but exactly the shape
 * needed for "revert everything turn N did" or "restore the workspace to how
 * it looked an hour ago".
 *
 * Storage layout (workspace-local, see side-git.ts for the git mechanics):
 *   <workspaceRoot>/.goodvibes/checkpoints/git         — side GIT_DIR
 *   <workspaceRoot>/.goodvibes/checkpoints/index.json  — manifest (JsonFileStore)
 *
 * Checkpoint refs live at refs/goodvibes/checkpoints/<id> inside the side
 * repo, entirely separate from the user's real git refs and from compaction's
 * `cpt_` boundary commits (which are conversation snapshots, not filesystem
 * snapshots, and are not stored in git at all — see types.ts's header comment
 * for the full disambiguation).
 *
 * Automatic snapshots subscribe to EXISTING runtime bus events
 * (TURN_COMPLETED / TURN_ERROR / TURN_CANCEL / AGENT_COMPLETED) — no new
 * event contract is introduced by this module.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { JsonFileStore } from '../../state/json-file-store.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import type { TurnEvent } from '../../../events/turn.js';
import type { AgentEvent } from '../../../events/agents.js';
import {
  RetentionPolicy,
  type RetentionConfig,
  type RetentionClass,
  type CheckpointRecord,
  type Pruner,
  type PruneResult,
  type PruneOptions,
} from '../../runtime/retention/index.js';
import { SideGitRunner, CHECKPOINT_REF_PREFIX, EMPTY_TREE_HASH } from './side-git.js';
import type { WorkspaceCheckpoint, CheckpointKind, CheckpointDiff, RestoreResult } from './types.js';

const ID_PREFIX = 'wcp';

function generateCheckpointId(now: () => number): string {
  const ts = now().toString(36);
  const rand = randomUUID().slice(0, 8);
  return `${ID_PREFIX}_${ts}_${rand}`;
}

/** Default retention class per checkpoint kind when the caller does not specify one. */
function defaultRetentionClassFor(kind: CheckpointKind): RetentionClass {
  return kind === 'manual' ? 'forensic' : 'standard';
}

interface Manifest {
  checkpoints: WorkspaceCheckpoint[];
}

/**
 * `Pruner` implementation for `RetentionPolicy` that deletes checkpoint REFS
 * (not filesystem paths — that is what `SnapshotPruner`, the compaction-side
 * pruner, does, and reusing it here would be a no-op at best since our
 * "artifacts" are refs+objects, not files). Actual object reclamation is a
 * single `git gc --prune=now` run once by `WorkspaceCheckpointManager.gc()`
 * after refs are deleted, not per-record here.
 */
class WorkspaceCheckpointPruner implements Pruner {
  constructor(
    private readonly sideGit: SideGitRunner,
    private readonly onDeleted: (id: string) => void,
  ) {}

  async delete(candidates: readonly CheckpointRecord[], options?: PruneOptions): Promise<PruneResult> {
    const dryRun = options?.dryRun ?? false;
    const deletedIds: string[] = [];
    const failedIds: string[] = [];
    const errors: Record<string, string> = {};
    let reclaimedBytes = 0;
    const byClass: Record<RetentionClass, { deletedCount: number; reclaimedBytes: number; deletedIds: string[]; candidateIds: string[]; failedIds: string[] }> = {
      short: { deletedCount: 0, reclaimedBytes: 0, deletedIds: [], candidateIds: [], failedIds: [] },
      standard: { deletedCount: 0, reclaimedBytes: 0, deletedIds: [], candidateIds: [], failedIds: [] },
      forensic: { deletedCount: 0, reclaimedBytes: 0, deletedIds: [], candidateIds: [], failedIds: [] },
    };
    for (const record of candidates) {
      byClass[record.retentionClass].candidateIds.push(record.id);
    }
    if (dryRun) {
      return {
        deletedCount: 0,
        reclaimedBytes: 0,
        deletedIds: [],
        candidateIds: candidates.map((c) => c.id),
        failedIds: [],
        errors: {},
        dryRun: true,
        byClass,
      };
    }
    for (const record of candidates) {
      try {
        await this.sideGit.deleteRef(`${CHECKPOINT_REF_PREFIX}${record.id}`);
        deletedIds.push(record.id);
        reclaimedBytes += record.sizeBytes;
        byClass[record.retentionClass].deletedCount += 1;
        byClass[record.retentionClass].reclaimedBytes += record.sizeBytes;
        byClass[record.retentionClass].deletedIds.push(record.id);
        this.onDeleted(record.id);
      } catch (err) {
        failedIds.push(record.id);
        errors[record.id] = summarizeError(err);
        byClass[record.retentionClass].failedIds.push(record.id);
      }
    }
    return {
      deletedCount: deletedIds.length,
      reclaimedBytes,
      deletedIds,
      candidateIds: [],
      failedIds,
      errors,
      dryRun: false,
      byClass,
    };
  }
}

export interface CreateCheckpointOptions {
  readonly kind: CheckpointKind;
  readonly label?: string | undefined;
  readonly retentionClass?: RetentionClass | undefined;
  readonly turnId?: string | undefined;
  readonly agentId?: string | undefined;
  /** Scope the snapshot to these paths instead of sweeping the whole workspace. */
  readonly paths?: string[] | undefined;
}

export interface RestoreOptions {
  /** Restrict restore to these paths instead of the whole workspace. */
  readonly paths?: string[] | undefined;
  /** Take a safety checkpoint of the current state before restoring. Defaults to true. */
  readonly safetyCheckpoint?: boolean | undefined;
}

export interface ListCheckpointsFilter {
  readonly kind?: CheckpointKind | undefined;
  readonly since?: number | undefined;
  readonly limit?: number | undefined;
}

export interface WorkspaceCheckpointManagerOptions {
  readonly workspaceRoot: string;
  /** Override the side repo's GIT_DIR. Defaults to `<workspaceRoot>/.goodvibes/checkpoints/git`. */
  readonly checkpointDir?: string | undefined;
  /** When provided, the manager subscribes to TURN_COMPLETED/TURN_ERROR/TURN_CANCEL/AGENT_COMPLETED for automatic snapshots. */
  readonly runtimeBus?: RuntimeEventBus | undefined;
  readonly retention?: Partial<RetentionConfig> | undefined;
  /** Clock override for deterministic tests. */
  readonly now?: (() => number) | undefined;
}

/**
 * WorkspaceCheckpointManager — create/list/diff/restore/gc for whole-workspace
 * git-backed snapshots, plus automatic snapshotting on existing turn/agent
 * lifecycle events.
 */
export class WorkspaceCheckpointManager {
  readonly workspaceRoot: string;
  private readonly checkpointRootDir: string;
  private readonly sideGit: SideGitRunner;
  private readonly manifestStore: JsonFileStore<Manifest>;
  private readonly retentionPolicy: RetentionPolicy;
  private readonly now: () => number;
  private readonly runtimeBus: RuntimeEventBus | undefined;
  private readonly unsubscribers: (() => void)[] = [];

  private checkpoints = new Map<string, WorkspaceCheckpoint>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Promise-chain mutex serializing every public operation that touches the
   * side repo's shared index or shared object store: `create`, `restore`,
   * `gc`, and `diff` (see each method's `*Internal` body below). Without
   * this, an auto-snapshot `create()` firing on a bus event (TURN_COMPLETED,
   * TURN_ERROR, TURN_CANCEL, or AGENT_COMPLETED) could run its `git add -A`
   * in between `restore()`'s
   * `read-tree --reset` and `checkout-index -a -f`, silently corrupting the
   * restore; two concurrent `create()` calls share the same hazard on the
   * index, and a same-tick `gc()` could treat a not-yet-ref'd loose commit
   * from an in-flight `create()` as unreachable and prune it out from under
   * it. `diff()` is included too: the single-argument `git diff <tree-ish>`
   * form (diffing a checkpoint against the live working tree) refreshes the
   * index's stat cache as a side effect, which is itself a write.
   *
   * Each public method below only does `await this.init()` (idempotent, safe
   * to race) before calling `withLock`; the actual git-touching work lives in
   * a same-named `*Internal` method. Internal callers that need another
   * locked operation's behavior (e.g. `restore()`'s safety checkpoint) call
   * the `*Internal` method directly — never the public wrapper — so a single
   * logical operation never tries to re-enter its own lock.
   */
  private lockChain: Promise<void> = Promise.resolve();

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    // `lockChain` is constructed below so it never itself rejects (its
    // continuation always swallows both outcomes) — chaining with a single
    // `.then(fn)` is enough to guarantee `fn` only starts after every
    // previously-queued operation has settled, regardless of whether that
    // prior operation resolved or rejected.
    const result = this.lockChain.then(fn);
    this.lockChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  constructor(opts: WorkspaceCheckpointManagerOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.checkpointRootDir = opts.checkpointDir ?? join(opts.workspaceRoot, '.goodvibes', 'checkpoints');
    this.sideGit = new SideGitRunner({
      workspaceRoot: opts.workspaceRoot,
      gitDir: join(this.checkpointRootDir, 'git'),
    });
    this.manifestStore = new JsonFileStore<Manifest>(join(this.checkpointRootDir, 'index.json'));
    this.now = opts.now ?? Date.now;
    this.runtimeBus = opts.runtimeBus;
    this.retentionPolicy = new RetentionPolicy(
      opts.retention,
      this.now,
      new WorkspaceCheckpointPruner(this.sideGit, (id) => this.checkpoints.delete(id)),
    );
  }

  /**
   * Idempotent setup: init the side repo, load the manifest (re-hydrating the
   * in-memory RetentionPolicy so retention state survives process restarts),
   * and subscribe to automatic-snapshot events if a runtime bus was provided.
   * Safe to call multiple times; concurrent callers share one in-flight init.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this._init();
    }
    await this.initPromise;
  }

  private async _init(): Promise<void> {
    await this.sideGit.init();
    const manifest = await this.manifestStore.load();
    this.checkpoints = new Map((manifest?.checkpoints ?? []).map((c) => [c.id, c]));
    for (const checkpoint of this.checkpoints.values()) {
      this.retentionPolicy.register({
        id: checkpoint.id,
        createdAt: checkpoint.createdAt,
        sizeBytes: checkpoint.sizeBytes,
        retentionClass: checkpoint.retentionClass,
        path: this.sideGit.gitDir,
      });
    }
    if (this.runtimeBus) {
      this.subscribeToAutomaticSnapshots(this.runtimeBus);
    }
    this.initialized = true;
  }

  // ---------------------------------------------------------------------------
  // Automatic snapshots
  // ---------------------------------------------------------------------------

  /**
   * Subscribes to the EXISTING turn/agent lifecycle events — no new event
   * types are introduced. A snapshot is taken at the boundary AFTER each
   * turn/agent-run finishes, meaning "revert everything turn N did" means
   * restoring the checkpoint captured BEFORE turn N, i.e. checkpoint[N-1] in
   * `list()`'s (newest-first) ordering — an intentional off-by-one, documented
   * here rather than hidden: this module always snapshots "where things ended
   * up", never "where things started".
   *
   * Listener bodies are wrapped so a failure NEVER throws back into the bus:
   * `RuntimeEventBus.emit()` only catches synchronous throws from a listener,
   * not rejections from a returned (but un-awaited) promise, so every
   * auto-snapshot call here is deliberately `.catch()`-guarded.
   */
  private subscribeToAutomaticSnapshots(bus: RuntimeEventBus): void {
    const snapshotTurn = (turnId: string, reason: string): void => {
      this.create({ kind: 'turn', turnId, retentionClass: 'standard', label: `turn ${reason}` }).catch((err) => {
        logger.warn('WorkspaceCheckpointManager: automatic turn snapshot failed', {
          turnId,
          reason,
          error: summarizeError(err),
        });
      });
    };
    const snapshotAgentRun = (agentId: string): void => {
      this.create({ kind: 'agent-run', agentId, retentionClass: 'standard', label: 'agent run' }).catch((err) => {
        logger.warn('WorkspaceCheckpointManager: automatic agent-run snapshot failed', {
          agentId,
          error: summarizeError(err),
        });
      });
    };

    this.unsubscribers.push(
      bus.on<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>('TURN_COMPLETED', ({ payload }) => {
        snapshotTurn(payload.turnId, 'completed');
      }),
      bus.on<Extract<TurnEvent, { type: 'TURN_ERROR' }>>('TURN_ERROR', ({ payload }) => {
        snapshotTurn(payload.turnId, 'error');
      }),
      bus.on<Extract<TurnEvent, { type: 'TURN_CANCEL' }>>('TURN_CANCEL', ({ payload }) => {
        snapshotTurn(payload.turnId, 'cancelled');
      }),
      bus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => {
        snapshotAgentRun(payload.agentId);
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create a new checkpoint. Returns `null` (a cheap no-op) when the current
   * workspace tree is identical to the parent checkpoint's tree — no commit,
   * no ref, no manifest entry is created in that case.
   *
   * Serialized against every other index-touching operation on this manager
   * — see `withLock`.
   */
  async create(opts: CreateCheckpointOptions): Promise<WorkspaceCheckpoint | null> {
    await this.init();
    return this.withLock(() => this.createInternal(opts));
  }

  private async createInternal(opts: CreateCheckpointOptions): Promise<WorkspaceCheckpoint | null> {
    await this.sideGit.stageAll(opts.paths);
    const treeHash = await this.sideGit.writeTree();

    const parent = this.mostRecentCheckpoint();
    const parentTree = parent ? await this.sideGit.treeOf(parent.commit) : EMPTY_TREE_HASH;
    if (parentTree === treeHash) {
      logger.debug('WorkspaceCheckpointManager.create: tree unchanged since parent, no-op', {
        kind: opts.kind,
        parentId: parent?.id ?? null,
      });
      return null;
    }

    const id = generateCheckpointId(this.now);
    const kind = opts.kind;
    const retentionClass = opts.retentionClass ?? defaultRetentionClassFor(kind);
    const label = opts.label ?? this.defaultLabel(kind, id);
    const message = `wcp: ${kind} ${label}`.trim();
    const commit = await this.sideGit.commitTree(treeHash, message);
    await this.sideGit.updateRef(`${CHECKPOINT_REF_PREFIX}${id}`, commit);

    const changedPaths = parent
      ? await this.sideGit.diffNameOnly(parent.commit, commit)
      : await this.sideGit.listTrackedFiles(commit);
    const sizeBytes = await this.computeSizeBytes(changedPaths);

    const checkpoint: WorkspaceCheckpoint = {
      id,
      kind,
      label,
      createdAt: this.now(),
      parentId: parent?.id ?? null,
      turnId: opts.turnId,
      agentId: opts.agentId,
      retentionClass,
      commit,
      sizeBytes,
    };

    this.checkpoints.set(id, checkpoint);
    this.retentionPolicy.register({
      id,
      createdAt: checkpoint.createdAt,
      sizeBytes,
      retentionClass,
      path: this.sideGit.gitDir,
    });
    await this.persistManifest();

    logger.debug('WorkspaceCheckpointManager.create: checkpoint created', { id, kind, parentId: checkpoint.parentId });
    return checkpoint;
  }

  /** List checkpoints, newest-first. `list()[0]` is always the most recent checkpoint. */
  async list(filter?: ListCheckpointsFilter): Promise<WorkspaceCheckpoint[]> {
    await this.init();
    let results = Array.from(this.checkpoints.values()).sort((a, b) => b.createdAt - a.createdAt);
    if (filter?.kind) results = results.filter((c) => c.kind === filter.kind);
    if (filter?.since != null) results = results.filter((c) => c.createdAt >= filter.since!);
    if (filter?.limit != null) results = results.slice(0, filter.limit);
    return results;
  }

  /**
   * Diff two checkpoints, or a checkpoint against the live working tree when
   * `b` is omitted.
   *
   * Serialized against every other index-touching operation on this manager
   * — see `withLock`. The single-argument form (`b` omitted, diffing against
   * the live working tree) refreshes the side index's stat cache as a side
   * effect, so it is not purely read-only.
   */
  async diff(a: string, b?: string): Promise<CheckpointDiff> {
    await this.init();
    return this.withLock(() => this.diffInternal(a, b));
  }

  private async diffInternal(a: string, b?: string): Promise<CheckpointDiff> {
    const fromCheckpoint = this.requireCheckpoint(a);
    const toCheckpoint = b ? this.requireCheckpoint(b) : undefined;

    const [unifiedDiff, stat_, files] = await Promise.all([
      this.sideGit.diff(fromCheckpoint.commit, toCheckpoint?.commit),
      this.sideGit.diffStat(fromCheckpoint.commit, toCheckpoint?.commit),
      this.sideGit.diffNameOnly(fromCheckpoint.commit, toCheckpoint?.commit),
    ]);

    return {
      from: a,
      to: b ?? 'WORKING',
      files,
      unifiedDiff,
      stat: stat_,
    };
  }

  /**
   * Restore the workspace to the state captured by checkpoint `id`.
   *
   * By default (`safetyCheckpoint: true`) takes a checkpoint of the CURRENT
   * state first, so a restore is itself undoable via another restore.
   *
   * Whole-workspace restore (no `opts.paths`):
   *   1. Snapshot the current tracked-file set (via the safety checkpoint, or
   *      a transient write-tree when `safetyCheckpoint: false`) — this is the
   *      "before" set.
   *   2. Reset the side index to the target checkpoint's tree and check every
   *      file in it out to disk (re-creates anything the checkpoint had that
   *      is currently missing or modified).
   *   3. Remove exactly the files that were in the "before" set but are NOT
   *      in the target checkpoint's tree (files created/tracked after the
   *      checkpoint). Anything NOT in the "before" set — i.e. any untracked
   *      path outside what this engine has ever snapshotted — is never
   *      touched, by construction: it never appears in either set.
   *
   * Scoped restore (`opts.paths` provided) only checks out those paths from
   * the target tree; it never removes files outside the given paths.
   *
   * Serialized against every other index-touching operation on this manager
   * — see `withLock`. Without this, an auto-snapshot `create()` firing on a
   * bus event could run its `git add -A` in between the `read-tree --reset`
   * and `checkout-index -a -f` calls below, silently corrupting the restore.
   */
  async restore(id: string, opts?: RestoreOptions): Promise<RestoreResult> {
    await this.init();
    return this.withLock(() => this.restoreInternal(id, opts));
  }

  private async restoreInternal(id: string, opts?: RestoreOptions): Promise<RestoreResult> {
    const target = this.requireCheckpoint(id);
    const wantSafety = opts?.safetyCheckpoint ?? true;

    let beforeFiles: string[];
    let safetyCheckpointId: string | null = null;
    if (wantSafety) {
      // Calls createInternal directly (not the public, lock-acquiring
      // `create()`) — this whole method already holds the lock.
      const safety = await this.createInternal({ kind: 'manual', label: `pre-restore safety (before ${id})`, retentionClass: 'forensic' });
      safetyCheckpointId = safety?.id ?? null;
      const current = safety ?? this.mostRecentCheckpoint();
      beforeFiles = current ? await this.sideGit.listTrackedFiles(current.commit) : [];
    } else {
      await this.sideGit.stageAll();
      const transientTree = await this.sideGit.writeTree();
      beforeFiles = await this.sideGit.listTrackedFiles(transientTree);
    }

    if (opts?.paths && opts.paths.length > 0) {
      const restoredFiles: string[] = [];
      for (const path of opts.paths) {
        try {
          await this.sideGit.raw(['checkout', target.commit, '--', path]);
          restoredFiles.push(path);
        } catch (err) {
          logger.warn('WorkspaceCheckpointManager.restore: scoped path checkout failed', {
            id,
            path,
            error: summarizeError(err),
          });
        }
      }
      return { checkpointId: id, safetyCheckpointId, restoredFiles, removedFiles: [] };
    }

    const targetFiles = await this.sideGit.listTrackedFiles(target.commit);
    const targetFileSet = new Set(targetFiles);
    const removedFiles = beforeFiles.filter((path) => !targetFileSet.has(path));

    await this.sideGit.readTreeReset(target.commit);
    await this.sideGit.checkoutIndexAll();

    for (const path of removedFiles) {
      try {
        rmSync(join(this.workspaceRoot, path), { force: true });
      } catch (err) {
        logger.warn('WorkspaceCheckpointManager.restore: failed to remove file added after checkpoint', {
          id,
          path,
          error: summarizeError(err),
        });
      }
    }

    logger.debug('WorkspaceCheckpointManager.restore: restored', {
      id,
      safetyCheckpointId,
      restoredCount: targetFiles.length,
      removedCount: removedFiles.length,
    });

    return { checkpointId: id, safetyCheckpointId, restoredFiles: targetFiles, removedFiles };
  }

  /**
   * Apply retention limits: `RetentionPolicy` selects prune candidates,
   * `WorkspaceCheckpointPruner` deletes their refs, then (only if anything
   * was actually deleted) a single `git gc --prune=now` reclaims the now-
   * unreachable objects. This never touches compaction's boundary commits —
   * they are tracked in an entirely separate `RetentionPolicy` instance
   * (../../runtime/compaction) with no shared state.
   *
   * Reclamation only works because checkpoint commits are parentless (see
   * `SideGitRunner.commitTree`): a pruned ref's commit has no descendant
   * keeping it reachable via a git parent pointer, so once its ref is
   * deleted it is genuinely unreachable and `--prune=now` frees it.
   *
   * Serialized against every other index/object-store-touching operation on
   * this manager — see `withLock`. Without this, a `create()` racing this
   * method could write a loose commit object that isn't ref'd yet at the
   * moment `--prune=now` runs, and lose it.
   */
  async gc(): Promise<PruneResult> {
    await this.init();
    return this.withLock(() => this.gcInternal());
  }

  private async gcInternal(): Promise<PruneResult> {
    const result = await this.retentionPolicy.prune();
    if (result.deletedCount > 0) {
      await this.persistManifest();
      await this.sideGit.gc();
    }
    return result;
  }

  /** Unsubscribe from the runtime bus. Does not touch anything on disk. */
  dispose(): void {
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch {
        // best-effort
      }
    }
    this.unsubscribers.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private mostRecentCheckpoint(): WorkspaceCheckpoint | null {
    let latest: WorkspaceCheckpoint | null = null;
    for (const checkpoint of this.checkpoints.values()) {
      if (!latest || checkpoint.createdAt > latest.createdAt) {
        latest = checkpoint;
      }
    }
    return latest;
  }

  private requireCheckpoint(id: string): WorkspaceCheckpoint {
    const checkpoint = this.checkpoints.get(id);
    if (!checkpoint) {
      throw new Error(`WorkspaceCheckpointManager: no checkpoint found with id "${id}"`);
    }
    return checkpoint;
  }

  private defaultLabel(kind: CheckpointKind, id: string): string {
    if (kind === 'manual') return id;
    return `${kind} snapshot`;
  }

  /**
   * Approximate incremental bytes introduced by a checkpoint: sum of on-disk
   * sizes of the changed paths, read immediately after they were staged and
   * committed (so they still reflect exactly the content just captured).
   * Deleted paths (no longer on disk) contribute 0. This is deliberately not
   * exact git object-store accounting — it exists for retention's `maxSizeBytes`
   * bookkeeping, not for a byte-perfect audit.
   */
  private async computeSizeBytes(paths: string[]): Promise<number> {
    let total = 0;
    for (const path of paths) {
      const absolute = join(this.workspaceRoot, path);
      if (!existsSync(absolute)) continue;
      try {
        const info = await stat(absolute);
        if (info.isFile()) total += info.size;
      } catch {
        // Ignore races (file removed between listing and stat).
      }
    }
    return total;
  }

  private async persistManifest(): Promise<void> {
    await this.manifestStore.save({ checkpoints: Array.from(this.checkpoints.values()) });
  }
}
