/**
 * routes/fleet.ts
 *
 * `fleet.snapshot` / `fleet.list` gateway-method handlers (see CHANGELOG 1.0.0) over the
 * ALREADY daemon-resident `ProcessRegistry` (createProcessRegistry(),
 * ../../runtime/fleet/registry.ts:204, constructed + exposed on
 * RuntimeServices at ../../runtime/services.ts:712/:242). This is thin verb
 * registration, not new machinery: every call is a direct pass-through to
 * `registry.query()`, the registry's own cheap aggregate-on-read scan.
 *
 * Wired via `GatewayMethodCatalog.register(descriptor, handler)` — the SAME
 * mechanism the plugin API already uses (../../plugins/api.ts
 * `registerGatewayMethod`) — rather than a new REST path in the external
 * `@pellux/goodvibes-daemon-sdk` package or a change to
 * ../../daemon/http/router.ts (both out of this brief's file ownership).
 * The registered handler is reached over real HTTP today via the existing
 * generic invoke endpoint `POST /api/control-plane/methods/{methodId}/invoke`
 * (daemon-sdk/src/control-routes.ts `invokeGatewayMethod`).
 *
 * Descriptors live in ../method-catalog-control-core.ts (so
 * `buildOperatorContract` / api.md / contract-artifact generation see them
 * whether or not a handler has been attached yet); `registerFleetGatewayMethods`
 * below attaches the handler at RuntimeServices construction time
 * (../../runtime/services.ts, right after `processRegistry` exists).
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type {
  FleetQueryFilter,
  ProcessKind,
  ProcessNode,
  ProcessRegistry,
  ProcessState,
} from '../../runtime/fleet/types.js';
import type { FleetArchiveView } from '../../runtime/fleet/archive.js';
import type { AttemptJudgment, AttemptPickResult, HeldMergeGroup } from '../../orchestration/types.js';
import { AttemptError } from '../../orchestration/attempts.js';
import { paginateItems } from '@pellux/goodvibes-daemon-sdk';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

/**
 * `fleet.snapshot` payload cap: the registry's
 * `query()` is a cheap O(n) in-memory scan, but the wire response must not
 * grow unbounded with fleet size. Nodes beyond this cap are dropped (newest
 * activity first is NOT guaranteed here — see `truncated`/`totalCount` so a
 * caller that needs the full set knows to page via `fleet.list` instead).
 */
export const FLEET_SNAPSHOT_NODE_CAP = 2000;

export const FLEET_LIST_DEFAULT_LIMIT = 100;
export const FLEET_LIST_MAX_LIMIT = 500;

const PROCESS_KINDS: readonly ProcessKind[] = [
  'agent',
  'wrfc-chain',
  'wrfc-subtask',
  'workflow',
  'trigger',
  'schedule',
  'watcher',
  'background-process',
  'workstream',
  'phase',
  'work-item',
  'code-index',
];

const PROCESS_STATES: readonly ProcessState[] = [
  'thinking',
  'executing-tool',
  'awaiting-approval',
  'streaming',
  'stalled',
  'retrying',
  'done',
  'failed',
  'killed',
  'interrupted',
  'idle',
  'queued',
  'paused',
];

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
  return undefined;
}

function readFleetQueryFilter(query: Record<string, unknown> | undefined): FleetQueryFilter | undefined {
  if (!query) return undefined;
  const rawKinds = asStringArray(query.kinds);
  const rawStates = asStringArray(query.states);
  let kinds: ProcessKind[] | undefined;
  if (rawKinds) {
    const invalid = rawKinds.filter((k) => !PROCESS_KINDS.includes(k as ProcessKind));
    if (invalid.length > 0) {
      throw new GatewayVerbError(`Unknown fleet kind(s): ${invalid.join(', ')}`, 'INVALID_ARGUMENT', 400);
    }
    kinds = rawKinds as ProcessKind[];
  }
  let states: ProcessState[] | undefined;
  if (rawStates) {
    const invalid = rawStates.filter((s) => !PROCESS_STATES.includes(s as ProcessState));
    if (invalid.length > 0) {
      throw new GatewayVerbError(`Unknown fleet state(s): ${invalid.join(', ')}`, 'INVALID_ARGUMENT', 400);
    }
    states = rawStates as ProcessState[];
  }
  if (!kinds && !states) return undefined;
  return { ...(kinds ? { kinds } : {}), ...(states ? { states } : {}) };
}

function clampLimit(raw: unknown, fallback: number, max: number): number {
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new GatewayVerbError(`Invalid limit: ${String(raw)}`, 'INVALID_ARGUMENT', 400);
  }
  return Math.min(Math.floor(n), max);
}

/** Structural dep — only the read surface `fleet.*` needs. */
export type FleetQueryOnlyRegistry = Pick<ProcessRegistry, 'query'>;

export function createFleetSnapshotHandler(registry: FleetQueryOnlyRegistry): GatewayMethodHandler {
  return (invocation) => {
    const filter = readFleetQueryFilter(readInvocationParams(invocation));
    const snapshot = registry.query(filter);
    const truncated = snapshot.nodes.length > FLEET_SNAPSHOT_NODE_CAP;
    const nodes: readonly ProcessNode[] = truncated
      ? snapshot.nodes.slice(0, FLEET_SNAPSHOT_NODE_CAP)
      : snapshot.nodes;
    return {
      capturedAt: snapshot.capturedAt,
      nodes,
      truncated,
      totalCount: snapshot.nodes.length,
    };
  };
}

export function createFleetListHandler(registry: FleetQueryOnlyRegistry): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const filter = readFleetQueryFilter(params);
    const limit = clampLimit(params.limit, FLEET_LIST_DEFAULT_LIMIT, FLEET_LIST_MAX_LIMIT);
    const rawCursor = typeof params.cursor === 'string' ? params.cursor : null;
    const snapshot = registry.query(filter);
    // Sort key and recovery key MUST agree (mirrors sessions.search's
    // sortSessions-then-paginateItems pattern in session-search.ts): the array
    // is sorted newest-first by startedAt (id tiebreak for determinism when
    // two nodes share a timestamp, or neither has started), and paginateItems
    // is handed that SAME startedAt extractor with { descending: true }. A
    // node's `startedAt` is optional (not-yet-started processes), so absent
    // values are normalized to 0 for both the sort and the recovery key —
    // otherwise `paginateItems`' deleted-cursor recovery (which does a
    // findIndex assuming the array is actually ordered by the field it is
    // given) would search a startedAt-ordered predicate over an array that
    // was really sorted by id, silently skipping or repeating nodes once a
    // process is gc'd between pages.
    const startedAtOf = (node: ProcessNode): number => node.startedAt ?? 0;
    const sorted = [...snapshot.nodes].sort((a, b) => startedAtOf(b) - startedAtOf(a) || a.id.localeCompare(b.id));
    const page = paginateItems(
      sorted,
      limit,
      rawCursor,
      (node) => node.id,
      startedAtOf,
      { descending: true },
    );
    if ('error' in page) {
      throw new GatewayVerbError(page.error, 'INVALID_CURSOR', 400);
    }
    return {
      items: page.items,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      capturedAt: snapshot.capturedAt,
    };
  };
}

/** Registry surface for the archive verbs — optional so a runtime without the archive layer degrades honestly. */
export type FleetArchiveCapableRegistry = FleetQueryOnlyRegistry & Partial<FleetArchiveView>;

function requireArchive<K extends keyof FleetArchiveView>(
  registry: FleetArchiveCapableRegistry,
  method: K,
): FleetArchiveView[K] {
  const fn = registry[method];
  if (!fn) {
    throw new GatewayVerbError('This runtime has no fleet archive layer.', 'UNSUPPORTED', 501);
  }
  return fn as FleetArchiveView[K];
}

export function createFleetArchiveHandler(registry: FleetArchiveCapableRegistry): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const id = typeof params.id === 'string' ? params.id.trim() : '';
    if (!id) throw new GatewayVerbError('id is required', 'INVALID_ARGUMENT', 400);
    return requireArchive(registry, 'archive')(id);
  };
}

export function createFleetUnarchiveHandler(registry: FleetArchiveCapableRegistry): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const id = typeof params.id === 'string' ? params.id.trim() : '';
    if (!id) throw new GatewayVerbError('id is required', 'INVALID_ARGUMENT', 400);
    return { restored: requireArchive(registry, 'unarchive')(id) };
  };
}

export function createFleetArchiveFinishedHandler(registry: FleetArchiveCapableRegistry): GatewayMethodHandler {
  return () => ({ archivedCount: requireArchive(registry, 'archiveFinished')() });
}

export function createFleetArchivedListHandler(registry: FleetArchiveCapableRegistry): GatewayMethodHandler {
  return () => {
    const snapshot = requireArchive(registry, 'listArchived')();
    return { capturedAt: snapshot.capturedAt, nodes: snapshot.nodes };
  };
}

/**
 * The best-of-N surface the fleet verbs need — the orchestration engine's held-
 * merge methods. Optional at registration: a runtime with no orchestration
 * engine simply doesn't register the fleet.attempts.* verbs (graceful degrade).
 */
export interface FleetAttemptsController {
  listHeldMergeGroups(workstreamId?: string): Promise<HeldMergeGroup[]>;
  pickAttemptWinner(groupId: string, winnerItemId: string): Promise<AttemptPickResult>;
  proposeAttemptWinner(groupId: string): Promise<AttemptJudgment>;
}

/** Map an AttemptError to an honest wire status: a missing judge is 501, every other precondition miss is 409. */
function attemptGatewayError(error: unknown): never {
  if (error instanceof AttemptError) {
    if (error.message.includes('no judge')) {
      throw new GatewayVerbError(error.message, 'UNSUPPORTED', 501);
    }
    throw new GatewayVerbError(error.message, 'FAILED_PRECONDITION', 409);
  }
  throw error;
}

export function createFleetAttemptsListHandler(controller: FleetAttemptsController): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const workstreamId = typeof params.workstreamId === 'string' && params.workstreamId.length > 0 ? params.workstreamId : undefined;
    return { groups: await controller.listHeldMergeGroups(workstreamId) };
  };
}

export function createFleetAttemptsPickHandler(controller: FleetAttemptsController): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const groupId = typeof params.groupId === 'string' ? params.groupId.trim() : '';
    const winnerItemId = typeof params.winnerItemId === 'string' ? params.winnerItemId.trim() : '';
    if (!groupId) throw new GatewayVerbError('groupId is required', 'INVALID_ARGUMENT', 400);
    if (!winnerItemId) throw new GatewayVerbError('winnerItemId is required', 'INVALID_ARGUMENT', 400);
    try {
      return await controller.pickAttemptWinner(groupId, winnerItemId);
    } catch (error) {
      return attemptGatewayError(error);
    }
  };
}

export function createFleetAttemptsJudgeHandler(controller: FleetAttemptsController): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const groupId = typeof params.groupId === 'string' ? params.groupId.trim() : '';
    if (!groupId) throw new GatewayVerbError('groupId is required', 'INVALID_ARGUMENT', 400);
    try {
      return await controller.proposeAttemptWinner(groupId);
    } catch (error) {
      return attemptGatewayError(error);
    }
  };
}

/**
 * Attach the `fleet.*` handlers to the descriptors
 * already registered (without a handler) from
 * ../method-catalog-fleet.ts's static builtin array. Call once, at
 * RuntimeServices construction time, after `processRegistry` exists.
 * A missing descriptor (contract/registration drift) is a silent no-op
 * rather than a throw — construction must never fail because a wire verb
 * failed to register; the operator-contract gates catch a real drift.
 */
export function registerFleetGatewayMethods(
  catalog: GatewayMethodCatalog,
  registry: FleetArchiveCapableRegistry,
  attempts?: FleetAttemptsController,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('fleet.snapshot', createFleetSnapshotHandler(registry));
  attach('fleet.list', createFleetListHandler(registry));
  attach('fleet.archive', createFleetArchiveHandler(registry));
  attach('fleet.unarchive', createFleetUnarchiveHandler(registry));
  attach('fleet.archiveFinished', createFleetArchiveFinishedHandler(registry));
  attach('fleet.archived.list', createFleetArchivedListHandler(registry));
  // fleet.attempts.* (best-of-N held-merge) — registered only when an
  // orchestration engine is wired; absent, the verbs stay cataloged-but-
  // unhandled rather than a facade (graceful degrade, like the archive verbs).
  if (attempts) {
    attach('fleet.attempts.list', createFleetAttemptsListHandler(attempts));
    attach('fleet.attempts.pick', createFleetAttemptsPickHandler(attempts));
    attach('fleet.attempts.judge', createFleetAttemptsJudgeHandler(attempts));
  }
}
