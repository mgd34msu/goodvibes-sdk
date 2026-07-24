/**
 * manager-options.ts — the public option/filter shapes for
 * WorkspaceCheckpointManager (manager.ts), split out to keep manager.ts under
 * the repo's 800-line file cap. Re-exported from manager.ts, so every
 * existing import site (`from './manager.js'` / `from './index.js'`) keeps
 * working unchanged — this is a pure code-organization split, not a public
 * API change.
 */
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import type { RetentionConfig, RetentionClass } from '../../runtime/retention/index.js';
import type { CheckpointKind } from './types.js';

export interface CreateCheckpointOptions {
  readonly kind: CheckpointKind;
  readonly label?: string | undefined;
  readonly retentionClass?: RetentionClass | undefined;
  readonly turnId?: string | undefined;
  readonly agentId?: string | undefined;
  /**
   * Session this checkpoint belongs to. Explicit callers may pass it directly;
   * automatic snapshots leave it undefined and let the manager's
   * `resolveSessionId` hook stamp it from the triggering turn/agent. Never
   * fabricated — stays undefined when no session is in scope.
   */
  readonly sessionId?: string | undefined;
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
  /** Restrict to checkpoints stamped with this session id (see `WorkspaceCheckpoint.sessionId`). */
  readonly sessionId?: string | undefined;
}

/**
 * Context handed to {@link WorkspaceCheckpointManagerOptions.resolveSessionId}
 * when an automatic snapshot fires, carrying whichever id the triggering
 * lifecycle event supplied (a turn id for TURN_* events, an agent id for
 * AGENT_COMPLETED). The resolver returns the owning session id, or undefined
 * when it cannot map the event to a session — in which case the checkpoint is
 * simply left unstamped rather than guessed.
 */
export interface CheckpointSessionResolveContext {
  readonly turnId?: string | undefined;
  readonly agentId?: string | undefined;
}

export type CheckpointSessionResolver = (ctx: CheckpointSessionResolveContext) => string | undefined;

export interface WorkspaceCheckpointManagerOptions {
  readonly workspaceRoot: string;
  /** Override the side repo's GIT_DIR. Defaults to `<workspaceRoot>/.goodvibes/checkpoints/git`. */
  readonly checkpointDir?: string | undefined;
  /** When provided, the manager subscribes to TURN_COMPLETED/TURN_ERROR/TURN_CANCEL/AGENT_COMPLETED for automatic snapshots. */
  readonly runtimeBus?: RuntimeEventBus | undefined;
  /**
   * Optional hook that maps a triggering turn/agent to its owning session id so
   * automatic snapshots can be stamped with `sessionId`. Consulted at the
   * moment each lifecycle event fires (not at subscription time), so it may be
   * installed after construction via {@link WorkspaceCheckpointManager.setSessionResolver}.
   * Returning undefined leaves the checkpoint unstamped — the linkage is never
   * fabricated.
   */
  readonly resolveSessionId?: CheckpointSessionResolver | undefined;
  readonly retention?: Partial<RetentionConfig> | undefined;
  /** Clock override for deterministic tests. */
  readonly now?: (() => number) | undefined;
  /**
   * Prefer the enclosing git repository's top level over the raw
   * `workspaceRoot` when the root is inside one. Defaults to `true`: keeps a
   * daemon launched in a project subdirectory snapshotting the whole repo, and
   * (with the broad-root guard) stops a `$HOME` cwd from becoming a checkpoint
   * root. Set `false` to snapshot exactly `workspaceRoot`.
   */
  readonly preferGitRoot?: boolean | undefined;
  /**
   * Opt in to snapshotting a broad root (filesystem root, the user's home
   * directory, or `~/.goodvibes`). Defaults to `false`: such roots are refused
   * (no auto subscription, explicit `create()` throws) to avoid an unbounded
   * store. Set only when a broad root is genuinely intended.
   */
  readonly allowBroadRoot?: boolean | undefined;
  /**
   * Opt in to a first snapshot whose full sweep exceeds
   * `maxFirstSnapshotFiles`. Defaults to `false`: an oversized first sweep is
   * refused with a message stating the count and this override.
   */
  readonly allowLargeFirstSnapshot?: boolean | undefined;
  /** Ceiling for the first-ever snapshot's file sweep. Defaults to {@link DEFAULT_MAX_FIRST_SNAPSHOT_FILES}. */
  readonly maxFirstSnapshotFiles?: number | undefined;
  /**
   * Run a retention sweep automatically (cheap threshold check, then a
   * non-blocking `gc()` only when something is over-limit) after each
   * successful `create()` and once at init. Defaults to `true`. Set `false` to
   * drive retention purely via manual `gc()` (e.g. unit tests, or an embedder
   * with its own schedule).
   */
  readonly autoRetention?: boolean | undefined;
  /** Home-directory override (broad-root detection). Defaults to `os.homedir()`. */
  readonly homeDir?: string | undefined;
  /** Daemon state-directory override (broad-root detection). Defaults to `<homeDir>/.goodvibes`. */
  readonly daemonStateDir?: string | undefined;
  /**
   * A declare-once `SessionSurface` (see platform/runtime/session-surface.ts).
   * When given (and `checkpointDir` is not explicitly set), the checkpoint
   * store resolves to `surface.checkpointsDir` —
   * `<workingDirectory>/.goodvibes/<surfaceRoot>/checkpoints` — instead of the
   * legacy, unscoped `<workspaceRoot>/.goodvibes/checkpoints`. Fixed to the
   * surface's own `workingDirectory` regardless of the `preferGitRoot`
   * resolution (the surface is a deterministic, declare-once handle; it does
   * not move when the enclosing git repo's top level differs from the raw
   * root). Legacy construction (no `surface`) is unchanged — existing
   * consumers keep working exactly as before; adopting the surface form is
   * each consumer's own choice to make.
   */
  readonly surface?: import('../../runtime/session-surface.js').SessionSurface | undefined;
}
