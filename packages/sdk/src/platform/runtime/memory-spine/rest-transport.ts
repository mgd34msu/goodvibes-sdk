/**
 * rest-transport.ts — the memory-spine's REST `MemoryTransport`.
 *
 * A thin REST adapter over the daemon-owned `memory.records.*` HTTP routes,
 * built directly on this platform's own `transport-http` primitives
 * (`buildUrl`, `createJsonRequestInit`, `requestJsonRaw`) rather than a
 * hand-rolled fetch wrapper — this is the SDK's own wire, so it uses the
 * SDK's own transport helpers.
 *
 * FULL DETACH (SDK 1.2.0 catalog). Implements all fifteen verbs: the five
 * CORE routes (add, search, get, review, delete) plus the ten EXTENDED
 * routes (list, search-semantic, update, links.list, links.add, export,
 * import, review-queue, vector, doctor) — every read/write a consumer needs
 * to fully detach from its local memory store file once a daemon is adopted.
 *
 * HONESTY. Unlike the session spine (fire-and-forget, folded into a soft
 * 'offline' result), memory reads/writes return data the caller depends on —
 * a transport failure here is NOT swallowed. It propagates as a rejected
 * promise, matching `MemorySpineClient`'s documented contract: a wire client
 * must never silently fall back to a divergent local copy in place of a real
 * failure.
 *
 * A 404 is disambiguated by its RESPONSE CODE (`classifyMemoryWireError`),
 * never by the bare status. A record-missing 404 carries
 * `MEMORY_RECORD_NOT_FOUND`: on a nullable verb (`get`/`updateReview`/
 * `update`/`link`) it maps to the documented `null` "not found"; on a
 * non-nullable verb (`linksFor` etc.) it is not representable as null so it
 * propagates as a thrown error. ANY OTHER 404 — a route-not-found from an
 * older daemon that never registered this route, or a bare legacy 404 with no
 * code — is treated as "this daemon does not serve this verb" and rejects
 * with a stated reason on every verb, never a silent `null`.
 *
 * ── Hoist provenance (2026-07-30 daemon/TUI split) ──────────────────────────
 *
 * Both the TUI (`memory-spine-transport.ts`) and the agent
 * (`memory-spine-rest-transport.ts`) carried a `MemoryTransport`
 * implementation. The TUI's is the superset adopted here: it implements
 * `reviewQueue`, `vectorStats`, and `doctor`, which the agent's copy
 * deliberately left unwired (a CLI-only-access ruling specific to that
 * repo's `/memory` command, not a wire limitation), and it reuses this
 * platform's own transport-http helpers instead of a bespoke fetch wrapper.
 * Kept out of this hoist: bootstrap-side activation wiring
 * (`syncMemorySpineToHostStatus` in the TUI, the adoption reconciler in the
 * agent) — that is each consumer's own daemon-adoption composition, not part
 * of the transport itself.
 */
import { buildUrl, createJsonRequestInit, requestJsonRaw } from '@pellux/goodvibes-transport-http';
import type {
  MemoryAddOptions,
  MemoryBundle,
  MemoryDoctorReport,
  MemoryImportResult,
  MemoryLink,
  MemoryRecord,
  MemoryReviewPatch,
  MemoryScope,
  MemorySearchFilter,
  MemorySemanticSearchResult,
} from '../../state/memory-store.js';
import type { MemoryVectorStats } from '../../state/memory-vector-store.js';
import type { HonestMemorySearchOptions, HonestMemorySearchResult } from '../../state/memory-recall-contract.js';
import { classifyMemoryWireError, memoryVerbUnavailableError } from './wire-verb-availability.js';
import type { MemoryTransport, MemoryUpdatePatch } from './client.js';

/** Fold for a NULLABLE record-scoped verb: record-miss -> null; version-skew -> honest reject; else rethrow. */
function foldNullableMemoryWire404(verb: string, error: unknown): null {
  const kind = classifyMemoryWireError(error);
  if (kind === 'record-missing') return null;
  if (kind === 'method-unavailable') throw memoryVerbUnavailableError(verb, error);
  throw error;
}

/** Fold for a NON-NULLABLE (collection or record-required) verb: version-skew -> honest reject; else rethrow. */
function rethrowMemoryWire404(verb: string, error: unknown): never {
  if (classifyMemoryWireError(error) === 'method-unavailable') throw memoryVerbUnavailableError(verb, error);
  throw error;
}

export interface MemorySpineRestTransportOptions {
  readonly baseUrl: string;
  readonly authToken: string | null;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Build the `MemorySpineClient` wire transport: a REST adapter over the
 * adopted daemon's full `memory.records.*` route catalog (five CORE routes
 * plus the ten 1.2.0 EXTENDED routes).
 */
export function createMemorySpineRestTransport(options: MemorySpineRestTransportOptions): MemoryTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = options.authToken;
  const url = (path: string): string => buildUrl(options.baseUrl, path);
  return {
    add: async (opts: MemoryAddOptions): Promise<MemoryRecord> => {
      const response = await requestJsonRaw<{ record: MemoryRecord }>(
        fetchImpl, url('/api/memory/records'), createJsonRequestInit(token, opts, 'POST'),
      );
      return response.record;
    },
    honestSearch: async (filter?: MemorySearchFilter, searchOptions?: HonestMemorySearchOptions): Promise<HonestMemorySearchResult> => {
      const body = { ...(filter ?? {}), ...(searchOptions?.recall !== undefined ? { recall: searchOptions.recall } : {}) };
      return await requestJsonRaw<HonestMemorySearchResult>(
        fetchImpl, url('/api/memory/records/search'), createJsonRequestInit(token, body, 'POST'),
      );
    },
    get: async (id: string): Promise<MemoryRecord | null> => {
      try {
        const response = await requestJsonRaw<{ record: MemoryRecord }>(
          fetchImpl, url(`/api/memory/records/${encodeURIComponent(id)}`), createJsonRequestInit(token),
        );
        return response.record;
      } catch (error) {
        return foldNullableMemoryWire404('get', error);
      }
    },
    updateReview: async (id: string, patch: MemoryReviewPatch): Promise<MemoryRecord | null> => {
      try {
        const response = await requestJsonRaw<{ record: MemoryRecord }>(
          fetchImpl, url(`/api/memory/records/${encodeURIComponent(id)}/review`), createJsonRequestInit(token, patch, 'POST'),
        );
        return response.record;
      } catch (error) {
        return foldNullableMemoryWire404('updateReview', error);
      }
    },
    delete: async (id: string): Promise<boolean> => {
      const response = await requestJsonRaw<{ id: string; deleted: boolean }>(
        fetchImpl, url(`/api/memory/records/${encodeURIComponent(id)}`), createJsonRequestInit(token, undefined, 'DELETE'),
      );
      return response.deleted;
    },

    // ── Extended verbs (1.2.0 full-detach) ──────────────────────────────────

    list: async (filter?: MemorySearchFilter): Promise<readonly MemoryRecord[]> => {
      try {
        const response = await requestJsonRaw<{ records: readonly MemoryRecord[] }>(
          fetchImpl, url('/api/memory/records/list'), createJsonRequestInit(token, filter ?? {}, 'POST'),
        );
        return response.records;
      } catch (error) {
        return rethrowMemoryWire404('list', error);
      }
    },
    searchSemantic: async (filter?: MemorySearchFilter): Promise<readonly MemorySemanticSearchResult[]> => {
      try {
        const response = await requestJsonRaw<{ results: readonly MemorySemanticSearchResult[] }>(
          fetchImpl, url('/api/memory/records/search-semantic'), createJsonRequestInit(token, filter ?? {}, 'POST'),
        );
        return response.results;
      } catch (error) {
        return rethrowMemoryWire404('searchSemantic', error);
      }
    },
    update: async (id: string, patch: MemoryUpdatePatch): Promise<MemoryRecord | null> => {
      try {
        const response = await requestJsonRaw<{ record: MemoryRecord }>(
          fetchImpl, url(`/api/memory/records/${encodeURIComponent(id)}/update`), createJsonRequestInit(token, patch, 'POST'),
        );
        return response.record;
      } catch (error) {
        return foldNullableMemoryWire404('update', error);
      }
    },
    link: async (fromId: string, toId: string, relation: string): Promise<MemoryLink | null> => {
      try {
        const response = await requestJsonRaw<{ link: MemoryLink }>(
          fetchImpl, url(`/api/memory/records/${encodeURIComponent(fromId)}/links`), createJsonRequestInit(token, { toId, relation }, 'POST'),
        );
        return response.link;
      } catch (error) {
        return foldNullableMemoryWire404('link', error);
      }
    },
    linksFor: async (id: string): Promise<readonly MemoryLink[]> => {
      try {
        const response = await requestJsonRaw<{ links: readonly MemoryLink[] }>(
          fetchImpl, url(`/api/memory/records/${encodeURIComponent(id)}/links`), createJsonRequestInit(token),
        );
        return response.links;
      } catch (error) {
        return rethrowMemoryWire404('linksFor', error);
      }
    },
    reviewQueue: async (limit?: number, scope?: MemoryScope): Promise<readonly MemoryRecord[]> => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set('limit', String(limit));
      if (scope !== undefined) params.set('scope', scope);
      const query = params.toString();
      try {
        const response = await requestJsonRaw<{ records: readonly MemoryRecord[] }>(
          fetchImpl, url(`/api/memory/review-queue${query ? `?${query}` : ''}`), createJsonRequestInit(token),
        );
        return response.records;
      } catch (error) {
        return rethrowMemoryWire404('reviewQueue', error);
      }
    },
    exportBundle: async (filter?: MemorySearchFilter): Promise<MemoryBundle> => {
      try {
        const response = await requestJsonRaw<{ bundle: MemoryBundle }>(
          fetchImpl, url('/api/memory/records/export'), createJsonRequestInit(token, filter ?? {}, 'POST'),
        );
        return response.bundle;
      } catch (error) {
        return rethrowMemoryWire404('exportBundle', error);
      }
    },
    importBundle: async (bundle: MemoryBundle): Promise<MemoryImportResult> => {
      try {
        const response = await requestJsonRaw<{ result: MemoryImportResult }>(
          fetchImpl, url('/api/memory/records/import'), createJsonRequestInit(token, { bundle }, 'POST'),
        );
        return response.result;
      } catch (error) {
        return rethrowMemoryWire404('importBundle', error);
      }
    },
    vectorStats: async (): Promise<MemoryVectorStats> => {
      try {
        const response = await requestJsonRaw<{ vector: MemoryVectorStats }>(
          fetchImpl, url('/api/memory/vector'), createJsonRequestInit(token),
        );
        return response.vector;
      } catch (error) {
        return rethrowMemoryWire404('vectorStats', error);
      }
    },
    doctor: async (): Promise<MemoryDoctorReport> => {
      try {
        return await requestJsonRaw<MemoryDoctorReport>(
          fetchImpl, url('/api/memory/doctor'), createJsonRequestInit(token),
        );
      } catch (error) {
        return rethrowMemoryWire404('doctor', error);
      }
    },
  };
}
