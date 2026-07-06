/**
 * routes/fleet.ts
 *
 * W3-S2 — `fleet.snapshot` / `fleet.list` gateway-method handlers over the
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
import { paginateItems } from '@pellux/goodvibes-daemon-sdk';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

/**
 * `fleet.snapshot` payload cap (risk #1, W3-S2 brief): the registry's
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

/**
 * Attach the `fleet.snapshot` / `fleet.list` handlers to the descriptors
 * already registered (without a handler) from
 * ../method-catalog-control-core.ts's static builtin array. Call once, at
 * RuntimeServices construction time, after `processRegistry` exists.
 * A missing descriptor (contract/registration drift) is a silent no-op
 * rather than a throw — construction must never fail because a wire verb
 * failed to register; the operator-contract gates catch a real drift.
 */
export function registerFleetGatewayMethods(catalog: GatewayMethodCatalog, registry: FleetQueryOnlyRegistry): void {
  const snapshotDescriptor = catalog.get('fleet.snapshot');
  if (snapshotDescriptor) {
    catalog.register(snapshotDescriptor, createFleetSnapshotHandler(registry), { replace: true });
  }
  const listDescriptor = catalog.get('fleet.list');
  if (listDescriptor) {
    catalog.register(listDescriptor, createFleetListHandler(registry), { replace: true });
  }
}
