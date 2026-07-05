/**
 * routes/checkpoints.ts
 *
 * W3-S2 — `checkpoints.list` / `checkpoints.create` / `checkpoints.diff` /
 * `checkpoints.restore` gateway-method handlers over the ALREADY
 * daemon-resident `WorkspaceCheckpointManager` (constructed +
 * eagerly-`init()`'d at ../../runtime/services.ts:620, exposed on
 * RuntimeServices at :245). Thin verb registration over an existing manager
 * — see routes/fleet.ts's header comment for the full rationale on why these
 * are wired via `GatewayMethodCatalog.register(descriptor, handler)` instead
 * of a daemon-sdk REST route or a router.ts change.
 *
 * IMPORTANT (brief-mandated, do not "fix"): `checkpoints.restore` executes
 * the restore immediately, with NO server-side confirmation gate. The TUI
 * gates this behind a confirm overlay in the UI layer
 * (src/input/commands/checkpoint-runtime.ts, DiffPanel.confirmOverlay) —
 * confirmation is the CALLING SURFACE's responsibility, not the wire verb's.
 * A future caller (webui) that fires this unguarded will perform a real
 * git-backed workspace rewrite.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type { WorkspaceCheckpointManager } from '../../workspace/checkpoint/manager.js';
import type { CheckpointKind, RetentionClass } from '../../workspace/checkpoint/types.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

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

/** Structural deps — the read/write surface `checkpoints.*` needs. */
export type CheckpointsGatewayManager = Pick<WorkspaceCheckpointManager, 'list' | 'create' | 'diff' | 'restore'>;

export function createCheckpointsListHandler(manager: CheckpointsGatewayManager): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const kind = validateCheckpointKind(params.kind, false);
    const since = optionalNumber(params.since, 'since');
    const limit = clampLimit(params.limit);
    const checkpoints = await manager.list({ kind, since, limit });
    return { checkpoints };
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

export function createCheckpointsRestoreHandler(manager: CheckpointsGatewayManager): GatewayMethodHandler {
  return async (invocation) => {
    const body = readInvocationParams(invocation);
    const id = requiredString(body.id, 'id');
    const result = await callOrHonestNotFound(() => manager.restore(id, {
      paths: optionalStringArray(body.paths),
      safetyCheckpoint: optionalBoolean(body.safetyCheckpoint, 'safetyCheckpoint'),
    }));
    return { result };
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
export function registerCheckpointGatewayMethods(catalog: GatewayMethodCatalog, manager: CheckpointsGatewayManager): void {
  const listDescriptor = catalog.get('checkpoints.list');
  if (listDescriptor) catalog.register(listDescriptor, createCheckpointsListHandler(manager), { replace: true });

  const createDescriptor = catalog.get('checkpoints.create');
  if (createDescriptor) catalog.register(createDescriptor, createCheckpointsCreateHandler(manager), { replace: true });

  const diffDescriptor = catalog.get('checkpoints.diff');
  if (diffDescriptor) catalog.register(diffDescriptor, createCheckpointsDiffHandler(manager), { replace: true });

  const restoreDescriptor = catalog.get('checkpoints.restore');
  if (restoreDescriptor) catalog.register(restoreDescriptor, createCheckpointsRestoreHandler(manager), { replace: true });
}
