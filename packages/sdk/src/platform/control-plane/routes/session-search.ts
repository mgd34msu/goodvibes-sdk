/**
 * routes/session-search.ts
 *
 * W3-S2 — `sessions.search`: a paginated/filtered query over the
 * ALREADY-daemon-resident `SharedSessionBroker`'s home-scoped store,
 * extending the Wave-1 list-filter shape (`ListSharedSessionsOptions`:
 * project/kind/includeClosed) with a free-text `query`, `surfaceKind`,
 * `status`, and opaque cursor pagination (mirrors the
 * daemon-sdk `paginateItems` convention already used by
 * automation-jobs/runs and knowledge listings).
 *
 * DELIBERATELY a standalone read-only helper, NOT a `SharedSessionBroker`
 * method: the brief's file_ownership marks session-broker.ts read-only for
 * S2 ("add a search method only if unavoidable — prefer a read-only query
 * helper; coordinate with S3 which also reads the broker"). Everything here
 * is built from the broker's existing public `listSessions()` — no new
 * broker state, no new broker method.
 *
 * Bounded in-memory filter+sort (risk #3, W3-S2 brief): the store is
 * single-user scale, so a full unbounded scan per call is intentional (no
 * index) — see the brief's decision record for the documented ceiling.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type { SharedSessionBroker } from '../session-broker.js';
import type { SharedSessionKind, SharedSessionRecord, SharedSessionStatus } from '../session-types.js';
import type { SurfaceKind } from '../../../events/surfaces.js';
import { SURFACE_KINDS } from '../../../events/surfaces.js';
import { paginateItems } from '@pellux/goodvibes-daemon-sdk';
import { GatewayVerbError } from './gateway-verb-error.js';

const SHARED_SESSION_KINDS: readonly SharedSessionKind[] = [
  'tui',
  'agent',
  'webui',
  'companion-task',
  'companion-chat',
  'automation',
];
const SHARED_SESSION_STATUSES: readonly SharedSessionStatus[] = ['active', 'closed'];

const SESSIONS_SEARCH_DEFAULT_LIMIT = 50;
const SESSIONS_SEARCH_MAX_LIMIT = 200;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function validateKind(value: unknown): SharedSessionKind | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !SHARED_SESSION_KINDS.includes(value as SharedSessionKind)) {
    throw new GatewayVerbError(
      `Invalid kind: ${String(value)} (expected one of ${SHARED_SESSION_KINDS.join(', ')})`,
      'INVALID_ARGUMENT',
      400,
    );
  }
  return value as SharedSessionKind;
}

function validateStatus(value: unknown): SharedSessionStatus | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !SHARED_SESSION_STATUSES.includes(value as SharedSessionStatus)) {
    throw new GatewayVerbError(
      `Invalid status: ${String(value)} (expected one of ${SHARED_SESSION_STATUSES.join(', ')})`,
      'INVALID_ARGUMENT',
      400,
    );
  }
  return value as SharedSessionStatus;
}

function validateSurfaceKind(value: unknown): SurfaceKind | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !(SURFACE_KINDS as readonly string[]).includes(value)) {
    throw new GatewayVerbError(`Invalid surfaceKind: ${String(value)}`, 'INVALID_ARGUMENT', 400);
  }
  return value as SurfaceKind;
}

function clampLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return SESSIONS_SEARCH_DEFAULT_LIMIT;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new GatewayVerbError(`Invalid limit: ${String(raw)}`, 'INVALID_ARGUMENT', 400);
  }
  return Math.min(Math.floor(n), SESSIONS_SEARCH_MAX_LIMIT);
}

/** Structural dep — only the read surface `sessions.search` needs. */
export type SessionSearchBroker = Pick<SharedSessionBroker, 'listSessions'>;

export function createSessionsSearchHandler(broker: SessionSearchBroker): GatewayMethodHandler {
  return (invocation) => {
    const query = invocation.query ?? {};
    const textQuery = optionalString(query.query)?.toLowerCase();
    const project = optionalString(query.project);
    const kind = validateKind(query.kind);
    const surfaceKind = validateSurfaceKind(query.surfaceKind);
    const status = validateStatus(query.status);
    const includeClosed = query.includeClosed === true || query.includeClosed === 'true';
    const limit = clampLimit(query.limit);
    const rawCursor = typeof query.cursor === 'string' ? query.cursor : null;

    // Always fetch WITH closed sessions from the broker (its own default),
    // then apply the wire-level closed policy ourselves below: sessions.search
    // deliberately defaults to EXCLUDING closed sessions unless
    // includeClosed:true is explicit — the opposite of
    // SharedSessionBroker.listSessions' own default — because a "search"
    // surface should not surface dead sessions by default.
    const all: readonly SharedSessionRecord[] = broker.listSessions(Number.MAX_SAFE_INTEGER, {
      project,
      kind,
      includeClosed: true,
    });

    const filtered = all.filter((session) => {
      if (!includeClosed && session.status === 'closed') return false;
      if (status !== undefined && session.status !== status) return false;
      if (surfaceKind !== undefined && !session.surfaceKinds.includes(surfaceKind)) return false;
      if (textQuery !== undefined) {
        const haystack = `${session.id} ${session.title}`.toLowerCase();
        if (!haystack.includes(textQuery)) return false;
      }
      return true;
    });

    // Mirrors sortSessions (session-broker-state.ts): updatedAt desc, id asc tiebreak.
    const sorted = [...filtered].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));

    const page = paginateItems(
      sorted,
      limit,
      rawCursor,
      (session) => session.id,
      (session) => session.updatedAt,
      { descending: true },
    );
    if ('error' in page) {
      throw new GatewayVerbError(page.error, 'INVALID_CURSOR', 400);
    }
    return {
      sessions: page.items,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  };
}

/**
 * Attach the `sessions.search` handler to the descriptor already registered
 * (without a handler) from ../method-catalog-control-core.ts's static
 * builtin array. Call once, at RuntimeServices construction time. A missing
 * descriptor is a silent no-op — see routes/fleet.ts's
 * `registerFleetGatewayMethods` for the same rationale.
 */
export function registerSessionSearchGatewayMethod(catalog: GatewayMethodCatalog, broker: SessionSearchBroker): void {
  const descriptor = catalog.get('sessions.search');
  if (descriptor) {
    catalog.register(descriptor, createSessionsSearchHandler(broker), { replace: true });
  }
}
