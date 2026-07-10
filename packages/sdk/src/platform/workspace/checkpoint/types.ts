/**
 * types.ts
 *
 * Types for the workspace checkpoint engine (`WorkspaceCheckpointManager`).
 *
 * NAMING: this is deliberately "WorkspaceCheckpoint" / `wcp_` ids, NOT
 * "checkpoint" bare. "checkpoint" is already used for two unrelated concepts
 * in this codebase:
 *   - compaction boundary commits (`cpt_` ids, ../../runtime/compaction/strategies/boundary-commit.ts)
 *     — a CONVERSATION snapshot (messages/tokens), not a filesystem snapshot.
 *   - the generic retention `CheckpointRecord` (../../runtime/retention/types.ts)
 *     — a size/age/count bookkeeping record reused by both the boundary-commit
 *     GC path and this module's GC path, but tracked in independent
 *     `RetentionPolicy` instances so pruning one never touches the other.
 *
 * A WorkspaceCheckpoint is a whole-workspace filesystem snapshot stored as a
 * commit object in a hidden side git repository (see side-git.ts) — never a
 * conversation snapshot, never mixed with the user's real git history.
 */

import type { RetentionClass } from '../../runtime/retention/types.js';

export type { RetentionClass };

/**
 * What triggered a checkpoint to be created.
 *
 * - `turn`      — automatic snapshot taken at a conversation turn boundary
 *                 (TURN_COMPLETED / TURN_ERROR / TURN_CANCEL).
 * - `agent-run` — automatic snapshot taken after a spawned agent's changes
 *                 have been merged into the main workspace (AGENT_COMPLETED).
 * - `manual`    — explicit user-requested checkpoint (e.g. TUI `/checkpoint`).
 */
export type CheckpointKind = 'turn' | 'agent-run' | 'manual';

/**
 * Metadata record for a single workspace checkpoint.
 *
 * Persisted in the manifest (`index.json`, via JsonFileStore) alongside the
 * side git repo that actually holds the commit/blob/tree objects. The
 * manifest exists because git commit messages are a lossy encoding for
 * structured metadata and because `list()` / retention need it without
 * reading git object contents.
 */
export interface WorkspaceCheckpoint {
  /** Unique id, format `wcp_<ts36>_<rand8>`. Also the ref name suffix under refs/goodvibes/checkpoints/<id>. */
  readonly id: string;
  /** What triggered this checkpoint. */
  readonly kind: CheckpointKind;
  /** Human-readable label. Auto-generated for turn/agent-run kinds, user-supplied for manual. */
  readonly label: string;
  /** Unix timestamp (ms) when the checkpoint was created. */
  readonly createdAt: number;
  /** id of the checkpoint this one was created on top of, or null for the first checkpoint ever taken. */
  readonly parentId: string | null;
  /** Turn id, when kind === 'turn' (or when passed explicitly). */
  readonly turnId?: string | undefined;
  /** Agent id, when kind === 'agent-run' (or when passed explicitly). */
  readonly agentId?: string | undefined;
  /**
   * Session id this checkpoint belongs to, when the snapshot path could
   * resolve one (an explicit `create({ sessionId })`, or an automatic snapshot
   * whose turn/agent resolved to a session via the manager's `resolveSessionId`
   * hook). Absent when no session was in scope — never fabricated. This is the
   * linkage that lets a remote surface ask "what changed in THIS session"
   * (`sessions.changes.get`) and filter `list({ sessionId })`; it is also the
   * join key a future unified message-anchored rewind will use to line
   * workspace checkpoints up against conversation snapshots and file undo.
   */
  readonly sessionId?: string | undefined;
  /** Retention class controlling how long this checkpoint survives gc(). */
  readonly retentionClass: RetentionClass;
  /** Git commit hash (in the side repo's object store) this checkpoint points to. */
  readonly commit: string;
  /**
   * Approximate bytes of NEW content this checkpoint introduced relative to
   * its parent (unchanged files are deduped by git and cost ~0; this is not
   * exact object-store accounting, it is the sum of on-disk sizes of the
   * files that differ from the parent, read at commit time).
   */
  readonly sizeBytes: number;
}

/** Result of `WorkspaceCheckpointManager.diff()`. */
export interface CheckpointDiff {
  /** The checkpoint id (or ref) diffed from. */
  readonly from: string;
  /** The checkpoint id diffed to, or the literal string 'WORKING' when diffed against the live working tree. */
  readonly to: string;
  /** Paths that differ between `from` and `to`. */
  readonly files: string[];
  /** Unified diff text (`git diff`). */
  readonly unifiedDiff: string;
  /** `git diff --stat` text. */
  readonly stat: string;
}

/**
 * Result of `WorkspaceCheckpointManager.sessionChanges()` — the aggregate file
 * changes a single session made, computed by diffing the state BEFORE the
 * session's earliest checkpoint (its parent, or the empty tree when the
 * session's first checkpoint was the first one ever taken) against the
 * session's latest checkpoint. `checkpointCount === 0` (with an empty diff) is
 * an honest "this session has no workspace checkpoints", not an error.
 */
export interface CheckpointSessionChanges {
  /** The session id these changes belong to. */
  readonly sessionId: string;
  /** How many of this session's checkpoints the aggregate spans. */
  readonly checkpointCount: number;
  /** The session's checkpoint ids, oldest-first. */
  readonly checkpointIds: string[];
  /** The base the aggregate diff is taken from: the parent checkpoint id, or the literal 'EMPTY' when the session opened the store. */
  readonly from: string;
  /** The session's latest checkpoint id the aggregate diff is taken to, or the literal 'EMPTY' when the session has no checkpoints. */
  readonly to: string;
  /** Paths that differ across the session's aggregate change. */
  readonly files: string[];
  /** Unified diff text for the aggregate change. */
  readonly unifiedDiff: string;
  /** `git diff --stat` text for the aggregate change. */
  readonly stat: string;
}

/** Result of `WorkspaceCheckpointManager.restore()`. */
export interface RestoreResult {
  /** The checkpoint id that was restored. */
  readonly checkpointId: string;
  /**
   * id of the safety checkpoint taken immediately before restoring, or null
   * when `safetyCheckpoint: false` was passed, or when the working tree was
   * already identical to the checkpoint being restored (no-op dedupe).
   */
  readonly safetyCheckpointId: string | null;
  /** Paths written or overwritten to match the restored checkpoint. */
  readonly restoredFiles: string[];
  /** Paths that existed (and were tracked by this engine) after the checkpoint but not in it, and were removed. */
  readonly removedFiles: string[];
}
