/**
 * routes/checkpoints.ts
 *
 * (see CHANGELOG 1.0.0) — `checkpoints.list` / `checkpoints.create` / `checkpoints.diff` /
 * `checkpoints.restore` gateway-method handlers over the ALREADY
 * daemon-resident `WorkspaceCheckpointManager` (constructed +
 * eagerly-`init()`'d at ../../runtime/services.ts:620, exposed on
 * RuntimeServices at :245). Thin verb registration over an existing manager
 * — see routes/fleet.ts's header comment for the full rationale on why these
 * are wired via `GatewayMethodCatalog.register(descriptor, handler)` instead
 * of a daemon-sdk REST route or a router.ts change.
 *
 * CONFIRMATION CONTRACT: `checkpoints.restore` refuses to run unconfirmed.
 * A caller must supply EITHER `confirm: true` (an explicit acknowledgment that
 * the destructive restore should execute immediately) OR a `confirmToken`
 * obtained from a prior `checkpoints.restorePreview` call (which returns a
 * short-lived, single-use token plus a preview of what would change). An
 * unconfirmed call is NOT an error — it returns a structured, non-destructive
 * refusal body (`result: null, refused: true, refusal: {...}`) that names both
 * paths, so a surface can proceed without guessing. Existing callers that
 * already gate restore behind their own UI confirm (the TUI's DiffPanel
 * confirm overlay, src/input/commands/checkpoint-runtime.ts) keep working by
 * adding the single field `confirm: true` to their restore invocation; no
 * preview round-trip is forced on them. A webui that fires restore blind now
 * gets the actionable refusal instead of a silent git-backed workspace rewrite.
 */
import { createHash } from 'node:crypto';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type { WorkspaceCheckpointManager } from '../../workspace/checkpoint/manager.js';
import type { CheckpointKind, RetentionClass } from '../../workspace/checkpoint/types.js';
import { applyHunkRevert, HunkRevertConflictError, previewHunkRevert } from '../../workspace/hunk-revert.js';
import type { WorkspaceEvent } from '../../../events/workspace.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { RestoreTokenStore } from './checkpoint-restore-tokens.js';

/** Sink for the checkpoints.revertHunk receipt event (adapted onto the RuntimeEventBus by the registrar). */
export type CheckpointsEventSink = (event: WorkspaceEvent, sessionId: string) => void;

/** The two ways to authorize a hunk revert, named verbatim in the refusal body. */
const REVERT_HUNK_CONFIRM_OPTIONS: readonly string[] = [
  'Pass confirm:true to acknowledge the working-tree write and execute it immediately.',
  'Call checkpoints.revertHunkPreview for this hunk, then pass the returned token as confirmToken.',
];

/** Fingerprint binding a revert confirm token to its exact (path, hunk) pair. */
function revertHunkFingerprint(path: string, hunk: string): string {
  return createHash('sha256').update(path).update('\0').update(hunk).digest('hex');
}

/** How many affected paths a restore preview lists inline before it is just a count. */
const RESTORE_PREVIEW_PATH_SAMPLE_LIMIT = 20;

/** The two ways to authorize a restore, named verbatim in the refusal body. */
const RESTORE_CONFIRM_OPTIONS: readonly string[] = [
  'Pass confirm:true to acknowledge the destructive restore and execute it immediately.',
  'Call checkpoints.restorePreview for this id, then pass the returned token as confirmToken.',
];

const CHECKPOINT_KINDS: readonly CheckpointKind[] = ['turn', 'agent-run', 'manual'];
const RETENTION_CLASSES: readonly RetentionClass[] = ['short', 'standard', 'forensic'];

const CHECKPOINTS_LIST_DEFAULT_LIMIT = 100;
const CHECKPOINTS_LIST_MAX_LIMIT = 500;

/**
 * `WorkspaceCheckpointManager.requireCheckpoint` (../../workspace/checkpoint/manager.ts:599-604,
 * private) throws a plain `Error` with this exact message shape for an
 * unknown/gc'd id. `diff`/`restore` both route through it. There is no
 * public `get(id)` to pre-check existence without a second full manager
 * call, so this handler matches the message text the manager already
 * commits to (any manager.ts rewrite of that string is covered by the
 * bootDaemon proof test — see test/w3-s2-*.test.ts — as a regression net,
 * not by this string match alone).
 */
const NO_CHECKPOINT_FOUND_MARKER = 'no checkpoint found with id';

async function callOrHonestNotFound<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes(NO_CHECKPOINT_FOUND_MARKER)) {
      // Preserve the manager's own message (it already names the specific
      // missing id) — only the status/code are being upgraded from the
      // blanket 500 a plain throw would collapse to.
      throw new GatewayVerbError(message, 'NOT_FOUND', 404);
    }
    throw err;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GatewayVerbError(`Missing required field: ${field}`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new GatewayVerbError(`Invalid number for field: ${field}`, 'INVALID_ARGUMENT', 400);
  }
  return n;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new GatewayVerbError('Invalid field: paths must be a string array', 'INVALID_ARGUMENT', 400);
  }
  return value as string[];
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new GatewayVerbError(`Invalid boolean for field: ${field}`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

function validateCheckpointKind(value: unknown, required: boolean): CheckpointKind | undefined {
  if (value === undefined || value === null) {
    if (required) throw new GatewayVerbError('Missing required field: kind', 'INVALID_ARGUMENT', 400);
    return undefined;
  }
  if (typeof value !== 'string' || !CHECKPOINT_KINDS.includes(value as CheckpointKind)) {
    throw new GatewayVerbError(
      `Invalid kind: ${String(value)} (expected one of ${CHECKPOINT_KINDS.join(', ')})`,
      'INVALID_ARGUMENT',
      400,
    );
  }
  return value as CheckpointKind;
}

function validateRetentionClass(value: unknown): RetentionClass | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !RETENTION_CLASSES.includes(value as RetentionClass)) {
    throw new GatewayVerbError(
      `Invalid retentionClass: ${String(value)} (expected one of ${RETENTION_CLASSES.join(', ')})`,
      'INVALID_ARGUMENT',
      400,
    );
  }
  return value as RetentionClass;
}

function clampLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return CHECKPOINTS_LIST_DEFAULT_LIMIT;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new GatewayVerbError(`Invalid limit: ${String(raw)}`, 'INVALID_ARGUMENT', 400);
  }
  return Math.min(Math.floor(n), CHECKPOINTS_LIST_MAX_LIMIT);
}

/** Structural deps — the read/write surface `checkpoints.*` + `sessions.changes.get` needs. */
export type CheckpointsGatewayManager = Pick<WorkspaceCheckpointManager, 'list' | 'create' | 'diff' | 'restore' | 'sessionChanges' | 'workspaceRoot'>;

export function createCheckpointsListHandler(manager: CheckpointsGatewayManager): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const kind = validateCheckpointKind(params.kind, false);
    const sessionId = optionalString(params.sessionId);
    const since = optionalNumber(params.since, 'since');
    const limit = clampLimit(params.limit);
    const checkpoints = await manager.list({ kind, sessionId, since, limit });
    return { checkpoints };
  };
}

/**
 * `sessions.changes.get` — the aggregate workspace file changes a session made,
 * joined over its sessionId-stamped checkpoints (see
 * WorkspaceCheckpointManager.sessionChanges). A session with no stamped
 * checkpoints returns checkpointCount:0 with an empty diff, not an error.
 */
export function createSessionChangesHandler(manager: CheckpointsGatewayManager): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = requiredString(params.sessionId, 'sessionId');
    return manager.sessionChanges(sessionId);
  };
}

export function createCheckpointsCreateHandler(manager: CheckpointsGatewayManager): GatewayMethodHandler {
  return async (invocation) => {
    const body = readInvocationParams(invocation);
    const kind = validateCheckpointKind(body.kind, true);
    if (!kind) throw new GatewayVerbError('Missing required field: kind', 'INVALID_ARGUMENT', 400);
    const checkpoint = await manager.create({
      kind,
      label: optionalString(body.label),
      retentionClass: validateRetentionClass(body.retentionClass),
      turnId: optionalString(body.turnId),
      agentId: optionalString(body.agentId),
      sessionId: optionalString(body.sessionId),
      paths: optionalStringArray(body.paths),
    });
    // `create` returns null when the workspace tree is unchanged since the
    // parent checkpoint (manager.ts:349-357) — an honest no-op, not an
    // error and not a fabricated checkpoint record.
    return { checkpoint, noop: checkpoint === null };
  };
}

export function createCheckpointsDiffHandler(manager: CheckpointsGatewayManager): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const a = requiredString(params.a, 'a');
    const b = optionalString(params.b);
    const diff = await callOrHonestNotFound(() => manager.diff(a, b));
    return { diff };
  };
}

/**
 * Build a preview of what restoring checkpoint `id` would change: the label,
 * the affected-path count and a bounded sample, and the diffstat — all from the
 * manager's own diff against the live working tree (no workspace mutation). An
 * unknown/gc'd id surfaces as the same honest 404 `diff`/`restore` already use.
 */
export function createCheckpointsRestorePreviewHandler(
  manager: CheckpointsGatewayManager,
  tokens: RestoreTokenStore,
): GatewayMethodHandler {
  return async (invocation) => {
    const body = readInvocationParams(invocation);
    const id = requiredString(body.id, 'id');
    // `diff(id)` (second arg omitted) diffs the checkpoint against the live
    // working tree and routes through requireCheckpoint, so an unknown id is a
    // 404 here before any token is minted.
    const diff = await callOrHonestNotFound(() => manager.diff(id));
    const checkpoint = (await manager.list()).find((c) => c.id === id);
    const affectedPaths = diff.files;
    const { token, expiresAt } = tokens.issue(id);
    return {
      token,
      expiresAt,
      preview: {
        checkpointId: id,
        label: checkpoint?.label ?? '',
        affectedPathCount: affectedPaths.length,
        affectedPathSample: affectedPaths.slice(0, RESTORE_PREVIEW_PATH_SAMPLE_LIMIT),
        stat: diff.stat,
      },
    };
  };
}

export function createCheckpointsRestoreHandler(
  manager: CheckpointsGatewayManager,
  tokens: RestoreTokenStore,
): GatewayMethodHandler {
  return async (invocation) => {
    const body = readInvocationParams(invocation);
    const id = requiredString(body.id, 'id');
    const confirm = optionalBoolean(body.confirm, 'confirm');
    const confirmToken = optionalString(body.confirmToken);

    if (confirmToken !== undefined) {
      // An explicit token that does not check out is a real failure of the
      // caller's confirm attempt (not the "you didn't confirm" refusal), so it
      // is an honest 400 that names the remedy — mint a fresh one.
      if (!tokens.consume(confirmToken, id)) {
        throw new GatewayVerbError(
          'confirmToken is invalid, already used, expired, or was issued for a different checkpoint — call checkpoints.restorePreview to obtain a fresh one.',
          'INVALID_ARGUMENT',
          400,
        );
      }
    } else if (confirm !== true) {
      // Unconfirmed: honest, actionable, NON-destructive. Not a thrown error —
      // a 200 body the caller can branch on.
      return {
        result: null,
        refused: true,
        refusal: {
          reason: 'checkpoints.restore is destructive (a git-backed workspace rewrite) and requires confirmation before it will run.',
          confirmField: 'confirm',
          previewMethod: 'checkpoints.restorePreview',
          options: RESTORE_CONFIRM_OPTIONS,
        },
      };
    }

    const result = await callOrHonestNotFound(() => manager.restore(id, {
      paths: optionalStringArray(body.paths),
      safetyCheckpoint: optionalBoolean(body.safetyCheckpoint, 'safetyCheckpoint'),
    }));
    return { result, refused: false, refusal: null };
  };
}

/**
 * `checkpoints.revertHunkPreview` — read-only: does reverse-applying this one
 * unified-diff hunk to its file apply cleanly right now? A stale/drifted hunk is
 * `applies:false` with a human-readable `conflict` and a null token (honest, not
 * an error); a clean hunk mints a single-use token bound to this exact (path,
 * hunk) that the matching checkpoints.revertHunk consumes.
 */
export function createCheckpointsRevertHunkPreviewHandler(
  manager: CheckpointsGatewayManager,
  tokens: RestoreTokenStore,
): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const path = requiredString(params.path, 'path');
    const hunk = requiredString(params.hunk, 'hunk');
    const preview = previewHunkRevert(manager.workspaceRoot, path, hunk);
    if (!preview.applies) {
      return { ...preview, token: null, expiresAt: null };
    }
    const { token, expiresAt } = tokens.issue(revertHunkFingerprint(path, hunk));
    return { ...preview, token, expiresAt };
  };
}

/**
 * `checkpoints.revertHunk` — confirm-gated reverse-apply of ONE hunk to the live
 * working tree, following the checkpoints.restore / rewind.apply confirm idiom:
 * an unconfirmed call is a non-error refusal, a bad token is a 400, and a hunk
 * that no longer applies cleanly is a 409 conflict (never a partial write). The
 * apply snapshots the whole tree first (the undo point) and emits a HUNK_REVERTED
 * receipt event when an event sink is wired.
 */
export function createCheckpointsRevertHunkHandler(
  manager: CheckpointsGatewayManager,
  tokens: RestoreTokenStore,
  emit?: CheckpointsEventSink,
): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const path = requiredString(params.path, 'path');
    const hunk = requiredString(params.hunk, 'hunk');
    const sessionId = optionalString(params.sessionId);
    const confirm = optionalBoolean(params.confirm, 'confirm');
    const confirmToken = optionalString(params.confirmToken);
    const fingerprint = revertHunkFingerprint(path, hunk);

    if (confirmToken !== undefined) {
      if (!tokens.consume(confirmToken, fingerprint)) {
        throw new GatewayVerbError(
          'confirmToken is invalid, already used, expired, or was issued for a different hunk — call checkpoints.revertHunkPreview to obtain a fresh one.',
          'INVALID_ARGUMENT',
          400,
        );
      }
    } else if (confirm !== true) {
      return {
        receipt: null,
        refused: true,
        refusal: {
          reason: 'checkpoints.revertHunk mutates the working tree (reverse-applies a hunk) and requires confirmation before it will run.',
          confirmField: 'confirm',
          previewMethod: 'checkpoints.revertHunkPreview',
          options: REVERT_HUNK_CONFIRM_OPTIONS,
        },
      };
    }

    let receipt;
    try {
      receipt = await applyHunkRevert(manager, path, hunk);
    } catch (err) {
      if (err instanceof HunkRevertConflictError) {
        // The hunk went stale (the file changed since the diff was taken). Honest
        // 409 — nothing was written, so the caller can re-diff and retry.
        throw new GatewayVerbError(err.message, 'CONFLICT', 409);
      }
      throw err;
    }
    if (emit) {
      emit(
        {
          type: 'HUNK_REVERTED',
          path: receipt.path,
          hunkHeader: receipt.hunkHeader,
          sessionId: sessionId ?? null,
          safetyCheckpointId: receipt.safetyCheckpointId,
          undoAvailable: receipt.undo !== null,
        },
        sessionId ?? 'workspace',
      );
    }
    return { receipt, refused: false, refusal: null };
  };
}

/**
 * Attach the `checkpoints.*` handlers to the descriptors already registered
 * (without a handler) from ../method-catalog-control-core.ts's static
 * builtin array. Call once, at RuntimeServices construction time, after
 * `workspaceCheckpointManager` exists. A missing descriptor is a silent
 * no-op — see routes/fleet.ts's `registerFleetGatewayMethods` for the same
 * rationale.
 */
export function registerCheckpointGatewayMethods(
  catalog: GatewayMethodCatalog,
  manager: CheckpointsGatewayManager,
  emit?: CheckpointsEventSink,
): void {
  // One token store shared by the preview (mints) and restore (consumes)
  // handlers for this daemon's lifetime.
  const restoreTokens = new RestoreTokenStore();
  // A separate store for the per-hunk revert preview/apply pair — its tokens bind
  // to a (path, hunk) fingerprint, not a checkpoint id, so they never cross with
  // the whole-checkpoint restore tokens above.
  const revertHunkTokens = new RestoreTokenStore();

  const listDescriptor = catalog.get('checkpoints.list');
  if (listDescriptor) catalog.register(listDescriptor, createCheckpointsListHandler(manager), { replace: true });

  const createDescriptor = catalog.get('checkpoints.create');
  if (createDescriptor) catalog.register(createDescriptor, createCheckpointsCreateHandler(manager), { replace: true });

  const diffDescriptor = catalog.get('checkpoints.diff');
  if (diffDescriptor) catalog.register(diffDescriptor, createCheckpointsDiffHandler(manager), { replace: true });

  const restorePreviewDescriptor = catalog.get('checkpoints.restorePreview');
  if (restorePreviewDescriptor) {
    catalog.register(restorePreviewDescriptor, createCheckpointsRestorePreviewHandler(manager, restoreTokens), { replace: true });
  }

  const restoreDescriptor = catalog.get('checkpoints.restore');
  if (restoreDescriptor) catalog.register(restoreDescriptor, createCheckpointsRestoreHandler(manager, restoreTokens), { replace: true });

  const revertHunkPreviewDescriptor = catalog.get('checkpoints.revertHunkPreview');
  if (revertHunkPreviewDescriptor) {
    catalog.register(revertHunkPreviewDescriptor, createCheckpointsRevertHunkPreviewHandler(manager, revertHunkTokens), { replace: true });
  }

  const revertHunkDescriptor = catalog.get('checkpoints.revertHunk');
  if (revertHunkDescriptor) {
    catalog.register(revertHunkDescriptor, createCheckpointsRevertHunkHandler(manager, revertHunkTokens, emit), { replace: true });
  }

  // sessions.changes.get is a session-category verb, but it is served over the
  // same workspaceCheckpointManager as the checkpoints.* verbs (it joins the
  // session's stamped checkpoints), so its handler is attached here alongside
  // them rather than in a separate registration site.
  const sessionChangesDescriptor = catalog.get('sessions.changes.get');
  if (sessionChangesDescriptor) catalog.register(sessionChangesDescriptor, createSessionChangesHandler(manager), { replace: true });
}
