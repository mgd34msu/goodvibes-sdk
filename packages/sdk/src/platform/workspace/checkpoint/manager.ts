/**
 * manager.ts
 *
 * WorkspaceCheckpointManager, the coarse, whole-workspace rewind layer.
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
 *   <workspaceRoot>/.goodvibes/checkpoints/git        , side GIT_DIR
 *   <workspaceRoot>/.goodvibes/checkpoints/index.json , manifest (JsonFileStore)
 *
 * Checkpoint refs live at refs/goodvibes/checkpoints/<id> inside the side
 * repo, entirely separate from the user's real git refs and from compaction's
 * `cpt_` boundary commits (which are conversation snapshots, not filesystem
 * snapshots, and are not stored in git at all, see types.ts's header comment
 * for the full disambiguation).
 *
 * Automatic snapshots subscribe to EXISTING runtime bus events
 * (TURN_COMPLETED / TURN_ERROR / TURN_CANCEL / AGENT_COMPLETED), no new
 * event contract is introduced by this module.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { JsonFileStore } from '../../state/json-file-store.js';
import { quarantineCorruptFile } from '../../utils/atomic-json-store.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import type { TurnEvent } from '../../../events/turn.js';
import type { AgentEvent } from '../../../events/agents.js';
import {
  RetentionPolicy,
  type RetentionConfig,
  type RetentionClass,
  type PruneResult,
} from '../../runtime/retention/index.js';
import { SideGitRunner, CHECKPOINT_REF_PREFIX, EMPTY_TREE_HASH, detectGitToplevel } from './side-git.js';
import { acquireCrossProcessLock } from './cross-process-lock.js';
import { WorkspaceCheckpointPruner } from './pruner.js';
import { computeSessionChanges } from './session-changes.js';
import {
  BROAD_ROOT_OVERRIDE,
  DEFAULT_MAX_FIRST_SNAPSHOT_FILES,
  broadRootReason,
  broadRootRefusalMessage,
  firstSnapshotTooLargeMessage,
} from './root-guard.js';
import type { WorkspaceCheckpoint, CheckpointKind, CheckpointDiff, RestoreResult, CheckpointSessionChanges } from './types.js';

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

// Public option/filter shapes live in manager-options.ts (split out to stay
// under the repo's 800-line file cap) and are re-exported here so every
// existing `from './manager.js'` import site keeps working unchanged.
export type {
  CreateCheckpointOptions,
  RestoreOptions,
  ListCheckpointsFilter,
  CheckpointSessionResolveContext,
  CheckpointSessionResolver,
  WorkspaceCheckpointManagerOptions,
} from './manager-options.js';
import type {
  CreateCheckpointOptions,
  RestoreOptions,
  ListCheckpointsFilter,
  CheckpointSessionResolver,
  WorkspaceCheckpointManagerOptions,
} from './manager-options.js';

/**
 * WorkspaceCheckpointManager, create/list/diff/restore/gc for whole-workspace
 * git-backed snapshots, plus automatic snapshotting on existing turn/agent
 * lifecycle events.
 */
export class WorkspaceCheckpointManager {
  // Resolved at init (git-root preference can move it off the raw option), so
  // these are reassigned once by `buildForRoot`, not `readonly`.
  // Assigned by `buildForRoot`, which the constructor always calls.
  workspaceRoot!: string;
  private checkpointRootDir!: string;
  private sideGit!: SideGitRunner;
  private manifestStore!: JsonFileStore<Manifest>;
  private manifestPath!: string;
  private retentionPolicy!: RetentionPolicy;
  private readonly now: () => number;
  private readonly runtimeBus: RuntimeEventBus | undefined;
  /** Resolves a triggering turn/agent to its owning session id for automatic-snapshot stamping. May be replaced post-construction via `setSessionResolver`. */
  private resolveSessionId: CheckpointSessionResolver | undefined;
  private readonly unsubscribers: (() => void)[] = [];

  // Root-guard configuration (see WorkspaceCheckpointManagerOptions).
  private readonly rawWorkspaceRoot: string;
  private readonly explicitCheckpointDir: string | undefined;
  private readonly surfaceCheckpointsDir: string | undefined;
  private readonly retentionOverride: Partial<RetentionConfig> | undefined;
  private readonly preferGitRoot: boolean;
  private readonly allowBroadRoot: boolean;
  private readonly allowLargeFirstSnapshot: boolean;
  private readonly maxFirstSnapshotFiles: number;
  private readonly autoRetention: boolean;
  private readonly homeDir: string;
  private readonly daemonStateDir: string;
  /** Non-null (the honest refusal message) when the resolved root was refused as too broad; drives both the skipped auto-subscription and rejected explicit `create()` calls. */
  private rootRefusal: string | null = null;

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
   * the `*Internal` method directly, never the public wrapper, so a single
   * logical operation never tries to re-enter its own lock.
   *
   * This in-process chain only serializes callers within THIS process. Two
   * separate processes sharing the same checkpoint directory (two daemon
   * instances, or a daemon and a CLI invocation, pointed at the same
   * workspace) have no in-process chain in common, see the cross-process
   * file lock acquired alongside it below (cross-process-lock.ts).
   */
  private lockChain: Promise<void> = Promise.resolve();

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    // `lockChain` is constructed below so it never itself rejects (its
    // continuation always swallows both outcomes), chaining with a single
    // `.then(...)` is enough to guarantee the body only starts after every
    // previously-queued operation (in this process) has settled, regardless
    // of whether that prior operation resolved or rejected. The body itself
    // additionally acquires the cross-process lock file before running `fn`,
    // so a concurrent operation in ANOTHER process sharing this same
    // checkpoint directory is serialized too, released in `finally` even if
    // `fn` throws.
    const result = this.lockChain.then(async () => {
      const release = await acquireCrossProcessLock(join(this.sideGit.gitDir, '.gv-lock'));
      try {
        return await fn();
      } finally {
        release();
      }
    });
    this.lockChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  constructor(opts: WorkspaceCheckpointManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.runtimeBus = opts.runtimeBus;
    this.resolveSessionId = opts.resolveSessionId;
    this.rawWorkspaceRoot = opts.workspaceRoot;
    this.explicitCheckpointDir = opts.checkpointDir;
    this.surfaceCheckpointsDir = opts.surface?.checkpointsDir;
    this.retentionOverride = opts.retention;
    this.preferGitRoot = opts.preferGitRoot ?? true;
    this.allowBroadRoot = opts.allowBroadRoot ?? false;
    this.allowLargeFirstSnapshot = opts.allowLargeFirstSnapshot ?? false;
    this.maxFirstSnapshotFiles = opts.maxFirstSnapshotFiles ?? DEFAULT_MAX_FIRST_SNAPSHOT_FILES;
    this.autoRetention = opts.autoRetention ?? true;
    this.homeDir = opts.homeDir ?? homedir();
    this.daemonStateDir = opts.daemonStateDir ?? join(this.homeDir, '.goodvibes');
    // Build against the raw root first; init() may rebuild once the git-root
    // preference resolves a different (enclosing-repo) root.
    this.buildForRoot(opts.workspaceRoot);
  }

  /**
   * (Re)construct every root-bound collaborator for `root`: storage dir, side
   * git runner, manifest store, and retention policy (whose pruner closes over
   * the side git runner, so it is rebuilt alongside it). Called from the
   * constructor with the raw root, and again from init() if the git-root
   * preference resolves a different root.
   */
  private buildForRoot(root: string): void {
    this.workspaceRoot = root;
    // Precedence: an explicit checkpointDir override always wins; otherwise a
    // surface's checkpointsDir (fixed to the surface's own workingDirectory,
    // not re-derived from `root`, see WorkspaceCheckpointManagerOptions.surface);
    // otherwise the legacy, unscoped `<root>/.goodvibes/checkpoints` (compat).
    this.checkpointRootDir = this.explicitCheckpointDir ?? this.surfaceCheckpointsDir ?? join(root, '.goodvibes', 'checkpoints');
    this.sideGit = new SideGitRunner({
      workspaceRoot: root,
      gitDir: join(this.checkpointRootDir, 'git'),
    });
    this.manifestPath = join(this.checkpointRootDir, 'index.json');
    this.manifestStore = new JsonFileStore<Manifest>(this.manifestPath);
    this.retentionPolicy = new RetentionPolicy(
      this.retentionOverride,
      this.now,
      new WorkspaceCheckpointPruner(this.sideGit, (id) => this.checkpoints.delete(id)),
    );
  }

  /**
   * Install (or replace) the session resolver used to stamp `sessionId` onto
   * automatic snapshots. Wired after construction because the daemon's
   * agent→session mapping (the session broker) is built alongside this manager;
   * the subscription reads the resolver at each event, so a later install takes
   * effect for all subsequent snapshots.
   */
  setSessionResolver(resolver: CheckpointSessionResolver | undefined): void {
    this.resolveSessionId = resolver;
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
      // A failed init must not be cached: every public method starts with
      // `await this.init()`, so a single transient failure (a busy side repo,
      // an unreadable manifest) would otherwise replay the same rejection for
      // the life of the process and disable checkpoints entirely. Clearing the
      // slot on rejection makes the next call a real retry.
      this.initPromise = this._init().catch((error: unknown) => {
        this.initPromise = null;
        throw error;
      });
    }
    await this.initPromise;
  }

  private async _init(): Promise<void> {
    await this.resolveAndGuardRoot();
    // Cross-process lock around the side repo's `git init`, not just the
    // later withLock-guarded operations: two processes constructing a
    // manager against the same not-yet-initialized checkpoint directory at
    // once race `git init` itself (observed failure: "cannot copy
    // .../info/exclude: File exists" when both processes' `git init` calls
    // overlap), before any of the create/restore/gc/diff critical sections
    // are ever reached.
    {
      const release = await acquireCrossProcessLock(join(this.sideGit.gitDir, '.gv-lock'));
      try {
        await this.sideGit.init();
      } finally {
        release();
      }
    }
    const manifest = await this.loadManifestOrQuarantine();
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
      if (this.rootRefusal) {
        logger.warn('WorkspaceCheckpointManager: refusing automatic snapshot subscription for a broad root', {
          root: this.workspaceRoot,
          reason: this.rootRefusal,
          override: BROAD_ROOT_OVERRIDE,
        });
      } else {
        this.subscribeToAutomaticSnapshots(this.runtimeBus);
      }
    }
    this.initialized = true;
    // One retention sweep at init so a store that grew past its limits in a
    // previous process shrinks on the next startup (non-blocking).
    this.maybeRunRetention();
  }

  /**
   * Resolve the effective root (preferring the enclosing git repo top level)
   * and decide whether it is too broad to snapshot. When the git-root
   * preference moves the root, every root-bound collaborator is rebuilt via
   * `buildForRoot`. A refused root sets `rootRefusal` (logged with the
   * override name in `_init`) so automatic subscription is skipped and explicit
   * `create()` calls fail honestly; the `allowBroadRoot` override clears it.
   */
  private async resolveAndGuardRoot(): Promise<void> {
    let resolved = this.rawWorkspaceRoot;
    if (this.preferGitRoot) {
      const toplevel = await detectGitToplevel(this.rawWorkspaceRoot);
      if (toplevel) resolved = toplevel;
    }
    if (resolved !== this.workspaceRoot) {
      this.buildForRoot(resolved);
    }

    const reason = broadRootReason(resolved, this.homeDir, this.daemonStateDir);
    this.rootRefusal = reason && !this.allowBroadRoot ? broadRootRefusalMessage(resolved, reason) : null;
  }

  /** Cheap, non-blocking retention sweep: skips when auto-retention is off, the root was refused, or nothing is over-limit; else fires the lock-serialized `gc()` fire-and-forget (like the auto-snapshot path). */
  private maybeRunRetention(): void {
    if (!this.autoRetention || this.rootRefusal) return;
    let due = false;
    try {
      due = this.retentionPolicy.needsPrune();
    } catch {
      due = false;
    }
    if (!due) return;
    void this.gc().catch((err) => {
      logger.warn('WorkspaceCheckpointManager: automatic retention sweep failed', {
        error: summarizeError(err),
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Automatic snapshots
  // ---------------------------------------------------------------------------

  /**
   * Subscribes to the EXISTING turn/agent lifecycle events, no new event
   * types are introduced. A snapshot is taken at the boundary AFTER each
   * turn/agent-run finishes, meaning "revert everything turn N did" means
   * restoring the checkpoint captured BEFORE turn N, i.e. checkpoint[N-1] in
   * `list()`'s (newest-first) ordering, an intentional off-by-one, documented
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
      // Resolve the owning session synchronously, at event-fire time, so the id
      // is captured even though create() runs async and the resolver's backing
      // state (e.g. the session's active turn/agent) may move on afterwards.
      const sessionId = this.resolveSessionId?.({ turnId });
      this.create({ kind: 'turn', turnId, sessionId, retentionClass: 'standard', label: `turn ${reason}` }).catch((err) => {
        logger.warn('WorkspaceCheckpointManager: automatic turn snapshot failed', {
          turnId,
          reason,
          error: summarizeError(err),
        });
      });
    };
    const snapshotAgentRun = (agentId: string): void => {
      const sessionId = this.resolveSessionId?.({ agentId });
      this.create({ kind: 'agent-run', agentId, sessionId, retentionClass: 'standard', label: 'agent run' }).catch((err) => {
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
   * workspace tree is identical to the parent checkpoint's tree, no commit,
   * no ref, no manifest entry is created in that case.
   *
   * Serialized against every other index-touching operation on this manager
   *, see `withLock`.
   */
  async create(opts: CreateCheckpointOptions): Promise<WorkspaceCheckpoint | null> {
    await this.init();
    if (this.rootRefusal) throw new Error(this.rootRefusal);
    const checkpoint = await this.withLock(() => this.createInternal(opts));
    // After a real (non-no-op) create, sweep retention if a limit is now
    // crossed, outside the lock, non-blocking, so create() stays fast.
    if (checkpoint) this.maybeRunRetention();
    return checkpoint;
  }

  private async createInternal(opts: CreateCheckpointOptions): Promise<WorkspaceCheckpoint | null> {
    await this.guardFirstSnapshotSize(opts);
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
      sessionId: opts.sessionId,
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
    if (filter?.sessionId) results = results.filter((c) => c.sessionId === filter.sessionId);
    if (filter?.since != null) results = results.filter((c) => c.createdAt >= filter.since!);
    if (filter?.limit != null) results = results.slice(0, filter.limit);
    return results;
  }

  /**
   * Diff two checkpoints, or a checkpoint against the live working tree when
   * `b` is omitted.
   *
   * Serialized against every other index-touching operation on this manager
   *, see `withLock`. The single-argument form (`b` omitted, diffing against
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
   * Aggregate the file changes a single session made, the "what changed in
   * this session" surface a remote view needs, one diff spanning every
   * turn/agent snapshot stamped with `sessionId` (see
   * {@link computeSessionChanges} for the base/latest selection and the honest
   * empty result for a session with no stamped checkpoints). Both endpoints are
   * committed side-repo trees, so this is a pure two-tree diff; it still takes
   * the lock to stay consistent with a concurrent create()/gc().
   */
  async sessionChanges(sessionId: string): Promise<CheckpointSessionChanges> {
    await this.init();
    return this.withLock(() => computeSessionChanges(this.checkpoints, this.sideGit, sessionId));
  }

  /**
   * Restore the workspace to the state captured by checkpoint `id`.
   *
   * By default (`safetyCheckpoint: true`) takes a checkpoint of the CURRENT
   * state first, so a restore is itself undoable via another restore.
   *
   * Whole-workspace restore (no `opts.paths`):
   *   1. Snapshot the current tracked-file set (via the safety checkpoint, or
   *      a transient write-tree when `safetyCheckpoint: false`), this is the
   *      "before" set.
   *   2. Reset the side index to the target checkpoint's tree and check every
   *      file in it out to disk (re-creates anything the checkpoint had that
   *      is currently missing or modified).
   *   3. Remove exactly the files that were in the "before" set but are NOT
   *      in the target checkpoint's tree (files created/tracked after the
   *      checkpoint). Anything NOT in the "before" set, i.e. any untracked
   *      path outside what this engine has ever snapshotted, is never
   *      touched, by construction: it never appears in either set.
   *
   * Scoped restore (`opts.paths` provided) only checks out those paths from
   * the target tree; it never removes files outside the given paths.
   *
   * Serialized against every other index-touching operation on this manager
   *, see `withLock`. Without this, an auto-snapshot `create()` firing on a
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
      // `create()`), this whole method already holds the lock.
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
   * unreachable objects. This never touches compaction's boundary commits,
   * they are tracked in an entirely separate `RetentionPolicy` instance
   * (../../runtime/compaction) with no shared state.
   *
   * Reclamation only works because checkpoint commits are parentless (see
   * `SideGitRunner.commitTree`): a pruned ref's commit has no descendant
   * keeping it reachable via a git parent pointer, so once its ref is
   * deleted it is genuinely unreachable and `--prune=now` frees it.
   *
   * Serialized against every other index/object-store-touching operation on
   * this manager, see `withLock`. Without this, a `create()` racing this
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

  /**
   * Before the FIRST-ever whole-workspace snapshot for this store, refuse if
   * the sweep would capture more than `maxFirstSnapshotFiles` files, a cheap
   * `ls-files`-style enumeration (no blobs written), not a full stage. This
   * catches an over-broad root (e.g. a home directory) before it materializes
   * a large object store, rather than proceeding silently. Only the first
   * snapshot is checked (a store with existing checkpoints has already proven
   * its root is sane), and only whole-workspace sweeps (a scoped `paths` create
   * is bounded by construction). The `allowLargeFirstSnapshot` override skips it.
   */
  private async guardFirstSnapshotSize(opts: CreateCheckpointOptions): Promise<void> {
    if (this.allowLargeFirstSnapshot) return;
    if (this.checkpoints.size > 0) return;
    if (opts.paths && opts.paths.length > 0) return;
    const count = await this.sideGit.countFirstSnapshotFiles();
    if (count > this.maxFirstSnapshotFiles) {
      throw new Error(firstSnapshotTooLargeMessage(this.workspaceRoot, count, this.maxFirstSnapshotFiles));
    }
  }

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
   * exact git object-store accounting, it exists for retention's `maxSizeBytes`
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

  /**
   * Load the manifest, moving it aside instead of failing when it cannot be
   * parsed.
   *
   * An index.json left unreadable by an unclean shutdown must not wedge the
   * whole checkpoint feature: the file is quarantined with a receipt and the
   * manager starts from an empty index, which the next save rewrites. Only the
   * index is lost, the checkpoint commits themselves stay in the side repo and
   * remain reachable by ref.
   */
  private async loadManifestOrQuarantine(): Promise<Manifest | null> {
    try {
      return await this.manifestStore.load();
    } catch (error) {
      quarantineCorruptFile(this.manifestPath, {
        label: 'workspace/checkpoints',
        reason: summarizeError(error),
        recovery: 'The checkpoint index was rebuilt empty; snapshot commits in the side repo are untouched but are no longer listed',
      });
      return null;
    }
  }

  private async persistManifest(): Promise<void> {
    await this.manifestStore.save({ checkpoints: Array.from(this.checkpoints.values()) });
  }
}
