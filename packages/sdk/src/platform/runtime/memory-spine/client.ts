/**
 * client.ts — the SDK memory-spine surface client (host-vs-client access mode).
 *
 * The daemon-owned memory service makes the daemon the SINGLE WRITER of its
 * canonical sql.js store. sql.js has no row locking and rewrites the whole file on
 * every save(), so two live processes writing the same file clobber each other —
 * a whole-file lost update that would DELETE memory. One process must own the
 * store; every other surface reaches it over the wire.
 *
 * This client is the surface-side switch that realizes that invariant, mirroring
 * the session-spine host-vs-client pattern:
 *
 *  - HOST / OFFLINE-EMBEDDED mode (transport NOT attached): the surface IS the only
 *    process touching its own store file, so it reads/writes the LOCAL embedded
 *    store directly. This is the offline fallback the agent and TUI keep — a daemon
 *    is not required for them to work.
 *  - CLIENT-OF-ADOPTED-DAEMON mode (transport attached): the daemon owns the store;
 *    the surface routes EVERY memory op through the injected wire transport and
 *    NEVER opens the file. Enforced structurally here — the active branch only ever
 *    touches `this.transport`, never `this.local`.
 *
 * FULL DETACH (SDK 1.2.0). The 1.1.0 wire family covered five verbs (add,
 * honestSearch, get, updateReview, delete). That was enough for a surface to store
 * and recall a fact over the wire, but NOT enough to fully detach every consumer
 * from the store file: the agent's `list`/`update`/semantic-search paths and the
 * TUI's `/recall` browse/link/queue/export paths still fell back to a local file.
 * This client now exposes the FULL read/write catalog those consumers need
 * (see MemoryExtendedAccess), so a wire client never opens the file for ANY of them.
 *
 * ONE-WRITER ENFORCEMENT RULING. The platform's convention (see canonical-memory.ts
 * and the session spine) is honest sequential/owned access plus stated posture, NOT
 * an OS advisory lock — sql.js exposes no lock and a cross-process flock would be a
 * new, unenforceable-on-every-OS mechanism the rest of the store does not rely on.
 * So the invariant is enforced two ways, both honest: (1) mode exclusivity — a
 * client in wire mode provably cannot reach the local file because the code routes
 * exclusively to the transport; (2) a documented single-writer contract for the
 * embedded case — the daemon host and an offline surface are each the sole process
 * for their own file. `mode()` reports the current posture so a surface can surface
 * it rather than guess.
 *
 * HONEST FAILURE. Unlike the fire-and-forget session mirror, memory reads/writes
 * return data, so this client is request/response. In client mode a transport
 * failure is SURFACED to the caller (the promise rejects); it is deliberately NOT
 * silently served from the local store — a wire client must not open the
 * daemon-owned file, and returning a divergent local copy as if it were canonical
 * would be the exact dishonest-recall failure this whole design exists to prevent.
 * A sustained daemon loss is handled by `deactivate()`, which returns the surface
 * to owned-local mode explicitly.
 *
 * VERSION TOLERANCE. The five CORE verbs are required of every transport. The
 * EXTENDED verbs are OPTIONAL on the transport (`MemoryTransport`) so a surface
 * pinned to an older SDK/daemon pair that predates a verb still satisfies the type.
 * When a client in wire mode calls an extended verb its adopted daemon does not
 * implement, the call REJECTS with a stated reason — it never silently reaches into
 * the local file, which would break the one-writer invariant and lie about which
 * store answered.
 */

import { logger } from '../../utils/logger.js';
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
import {
  buildRecallSnapshot,
  emptyRecallSnapshot,
  DEFAULT_RECALL_SNAPSHOT_STALE_AFTER_MS,
  type MemoryRecallSnapshot,
  type MemoryRecallRefreshOptions,
} from './recall-snapshot.js';
import { memoryVerbUnavailableError } from './wire-verb-availability.js';

/** Patch shape accepted by an editable-field update (scope/summary/detail/tags). */
export interface MemoryUpdatePatch {
  readonly scope?: MemoryScope | undefined;
  readonly summary?: string | undefined;
  readonly detail?: string | undefined;
  readonly tags?: string[] | undefined;
}

/**
 * The five CORE verbs, shipped in 1.1.0. Every transport must implement all five —
 * they are the minimum that lets a surface store and recall a fact over the wire.
 */
export interface MemoryCoreAccess {
  add(opts: MemoryAddOptions): Promise<MemoryRecord>;
  honestSearch(filter: MemorySearchFilter, options?: HonestMemorySearchOptions): Promise<HonestMemorySearchResult>;
  get(id: string): Promise<MemoryRecord | null>;
  updateReview(id: string, patch: MemoryReviewPatch): Promise<MemoryRecord | null>;
  delete(id: string): Promise<boolean>;
}

/**
 * The EXTENDED verbs added in 1.2.0 so a wire client can fully detach from the file.
 * Each maps to a MemoryRegistry read/write the consumers were still doing locally:
 *  - `list`          — bulk read (getAll / literal browse): knowledge injection + agent `list`.
 *  - `searchSemantic`— scored semantic recall: agent semantic path + TUI `/recall --semantic`.
 *  - `update`        — edit scope/summary/detail/tags (a scope edit is how a record is "promoted" project→team).
 *  - `link`/`linksFor` — relate records / read a record's links.
 *  - `reviewQueue`   — records prioritised for review (the curator/queue surface).
 *  - `exportBundle`/`importBundle` — the no-loss bundle seam over the wire.
 *  - `vectorStats`/`doctor` — read the daemon's canonical index diagnostics.
 *
 * DELIBERATELY NOT HERE (host-only, ruled in the full-detach decision record):
 * `rebuildVectors`/`rebuildVectorsAsync`. Rebuilding the vector index is maintenance
 * a store performs on its OWN index; the daemon keeps its canonical index current on
 * every add/import and exposes an admin `POST /api/memory/vector/rebuild` for a forced
 * rebuild. A wire client owns no index to rebuild, so a client-initiated rebuild is an
 * admin/diagnostic action against a store it does not own — it stays out of band, not
 * a per-record detach need.
 */
export interface MemoryExtendedAccess {
  list(filter?: MemorySearchFilter): Promise<readonly MemoryRecord[]>;
  searchSemantic(filter?: MemorySearchFilter): Promise<readonly MemorySemanticSearchResult[]>;
  update(id: string, patch: MemoryUpdatePatch): Promise<MemoryRecord | null>;
  link(fromId: string, toId: string, relation: string): Promise<MemoryLink | null>;
  linksFor(id: string): Promise<readonly MemoryLink[]>;
  reviewQueue(limit?: number, scope?: MemoryScope): Promise<readonly MemoryRecord[]>;
  exportBundle(filter?: MemorySearchFilter): Promise<MemoryBundle>;
  importBundle(bundle: MemoryBundle): Promise<MemoryImportResult>;
  vectorStats(): Promise<MemoryVectorStats>;
  doctor(): Promise<MemoryDoctorReport>;
}

/**
 * The full memory read/write surface a caller uses without caring whether it
 * resolves locally or over the wire. Every method is async so a local (sync store)
 * and a wire (async) backend present the SAME shape.
 */
export interface MemoryAccess extends MemoryCoreAccess, MemoryExtendedAccess {}

/**
 * The injected wire transport. A consumer builds a thin adapter over the daemon's
 * memory.records.* routes. The five CORE verbs are required; the EXTENDED verbs are
 * optional so a surface pinned to an older SDK/daemon still satisfies the type — a
 * client calling an extended verb the adopted daemon lacks gets an honest rejection,
 * never a silent local-file read.
 */
export type MemoryTransport = MemoryCoreAccess & Partial<MemoryExtendedAccess>;

/**
 * The local embedded store surface. The SDK's `MemoryRegistry` satisfies this
 * structurally (its methods are mostly synchronous; the facade normalizes them to
 * promises). Kept minimal so the client stays decoupled from the concrete class.
 */
export interface LocalMemoryStore {
  add(opts: MemoryAddOptions): Promise<MemoryRecord> | MemoryRecord;
  honestSearch(filter: MemorySearchFilter, options?: HonestMemorySearchOptions): HonestMemorySearchResult;
  get(id: string): MemoryRecord | null;
  review(id: string, patch: MemoryReviewPatch): MemoryRecord | null;
  delete(id: string): boolean;
  // Extended (all synchronous on the registry; the facade normalizes to promises).
  search(filter?: MemorySearchFilter): MemoryRecord[];
  searchSemantic(filter?: MemorySearchFilter): MemorySemanticSearchResult[];
  update(id: string, patch: MemoryUpdatePatch): MemoryRecord | null;
  link(fromId: string, toId: string, relation: string): Promise<MemoryLink | null> | MemoryLink | null;
  linksFor(id: string): MemoryLink[];
  reviewQueue(limit?: number, scope?: MemoryScope): MemoryRecord[];
  exportBundle(filter?: MemorySearchFilter): MemoryBundle;
  importBundle(bundle: MemoryBundle): Promise<MemoryImportResult> | MemoryImportResult;
  vectorStats(): MemoryVectorStats;
  doctor(): Promise<MemoryDoctorReport> | MemoryDoctorReport;
}

/** Wrap a local embedded store (e.g. a MemoryRegistry) as a full MemoryAccess. */
export function createLocalMemoryAccess(store: LocalMemoryStore): MemoryAccess {
  return {
    add: (opts) => Promise.resolve(store.add(opts)),
    honestSearch: (filter, options) => Promise.resolve(store.honestSearch(filter, options)),
    get: (id) => Promise.resolve(store.get(id)),
    updateReview: (id, patch) => Promise.resolve(store.review(id, patch)),
    delete: (id) => Promise.resolve(store.delete(id)),
    list: (filter) => Promise.resolve(store.search(filter ?? {})),
    searchSemantic: (filter) => Promise.resolve(store.searchSemantic(filter ?? {})),
    update: (id, patch) => Promise.resolve(store.update(id, patch)),
    link: (fromId, toId, relation) => Promise.resolve(store.link(fromId, toId, relation)),
    linksFor: (id) => Promise.resolve(store.linksFor(id)),
    reviewQueue: (limit, scope) => Promise.resolve(store.reviewQueue(limit, scope)),
    exportBundle: (filter) => Promise.resolve(store.exportBundle(filter ?? {})),
    importBundle: (bundle) => Promise.resolve(store.importBundle(bundle)),
    vectorStats: () => Promise.resolve(store.vectorStats()),
    doctor: () => Promise.resolve(store.doctor()),
  };
}

/** Current access posture — honest, reportable, never guessed. */
export type MemoryAccessMode = 'local' | 'client';

type SpineLogger = Pick<typeof logger, 'debug' | 'info'>;

export interface MemorySpineClientOptions {
  /** The local embedded store, always present as the offline/host backend. */
  readonly local: MemoryAccess;
  /**
   * Attach a wire transport at construction for CLIENT mode immediately (a surface
   * that boots already adopted to a daemon). Omit for LOCAL mode until `activate()`
   * (a surface that adopts a daemon later, or runs offline forever).
   */
  readonly transport?: MemoryTransport | undefined;
  /**
   * How long a recall snapshot stays "fresh" before `recallSnapshot()` reports it
   * stale. Defaults to {@link DEFAULT_RECALL_SNAPSHOT_STALE_AFTER_MS}.
   */
  readonly recallSnapshotStaleAfterMs?: number | undefined;
  readonly log?: SpineLogger;
}

export type { MemoryRecallSnapshot, MemoryRecallRefreshOptions } from './recall-snapshot.js';

/**
 * Routes memory access to the LOCAL embedded store or, when a daemon has been
 * adopted, THROUGH the wire — never both. Implements {@link MemoryAccess} so a
 * caller uses one object regardless of mode.
 */
export class MemorySpineClient implements MemoryAccess {
  private readonly local: MemoryAccess;
  private transport: MemoryTransport | null;
  private readonly log: SpineLogger;
  private readonly staleAfterMs: number;

  /** Last recall snapshot captured by refreshRecallSnapshot(); null until first refresh. */
  private snapshot: MemoryRecallSnapshot | null = null;

  constructor(options: MemorySpineClientOptions) {
    this.local = options.local;
    this.transport = options.transport ?? null;
    this.log = options.log ?? logger;
    this.staleAfterMs = options.recallSnapshotStaleAfterMs ?? DEFAULT_RECALL_SNAPSHOT_STALE_AFTER_MS;
  }

  /** The current posture: 'client' when routing over the wire, 'local' otherwise. */
  mode(): MemoryAccessMode {
    return this.transport ? 'client' : 'local';
  }

  /** Whether a wire transport is attached (client-of-adopted-daemon mode). */
  get active(): boolean {
    return this.transport !== null;
  }

  /**
   * Adopt a daemon: route every memory op through the wire from now on. The local
   * store is left untouched for the lifetime of client mode — the daemon is the
   * single writer.
   */
  activate(transport: MemoryTransport): void {
    this.transport = transport;
    this.log.info('memory spine activated — routing memory through the adopted external daemon (single writer)', {});
  }

  /** Release the daemon (mode lost / daemon stopped): return to owned-local access. */
  deactivate(reason: string): void {
    if (this.transport === null) return;
    this.transport = null;
    this.log.info('memory spine deactivated — reverting to owned-local memory access', { reason });
  }

  // ── Core verbs (routed local-or-wire) ─────────────────────────────────────────

  add(opts: MemoryAddOptions): Promise<MemoryRecord> {
    return this.route().add(opts);
  }

  honestSearch(filter: MemorySearchFilter, options?: HonestMemorySearchOptions): Promise<HonestMemorySearchResult> {
    return this.route().honestSearch(filter, options);
  }

  get(id: string): Promise<MemoryRecord | null> {
    return this.route().get(id);
  }

  updateReview(id: string, patch: MemoryReviewPatch): Promise<MemoryRecord | null> {
    return this.route().updateReview(id, patch);
  }

  delete(id: string): Promise<boolean> {
    return this.route().delete(id);
  }

  // ── Extended verbs (routed local-or-wire; honest reject if the daemon lacks one) ─

  list(filter?: MemorySearchFilter): Promise<readonly MemoryRecord[]> {
    return this.routeExtended('list', (a) => a.list(filter), (t) => t.list?.(filter));
  }

  searchSemantic(filter?: MemorySearchFilter): Promise<readonly MemorySemanticSearchResult[]> {
    return this.routeExtended('searchSemantic', (a) => a.searchSemantic(filter), (t) => t.searchSemantic?.(filter));
  }

  update(id: string, patch: MemoryUpdatePatch): Promise<MemoryRecord | null> {
    return this.routeExtended('update', (a) => a.update(id, patch), (t) => t.update?.(id, patch));
  }

  link(fromId: string, toId: string, relation: string): Promise<MemoryLink | null> {
    return this.routeExtended('link', (a) => a.link(fromId, toId, relation), (t) => t.link?.(fromId, toId, relation));
  }

  linksFor(id: string): Promise<readonly MemoryLink[]> {
    return this.routeExtended('linksFor', (a) => a.linksFor(id), (t) => t.linksFor?.(id));
  }

  reviewQueue(limit?: number, scope?: MemoryScope): Promise<readonly MemoryRecord[]> {
    return this.routeExtended('reviewQueue', (a) => a.reviewQueue(limit, scope), (t) => t.reviewQueue?.(limit, scope));
  }

  exportBundle(filter?: MemorySearchFilter): Promise<MemoryBundle> {
    return this.routeExtended('exportBundle', (a) => a.exportBundle(filter), (t) => t.exportBundle?.(filter));
  }

  importBundle(bundle: MemoryBundle): Promise<MemoryImportResult> {
    return this.routeExtended('importBundle', (a) => a.importBundle(bundle), (t) => t.importBundle?.(bundle));
  }

  vectorStats(): Promise<MemoryVectorStats> {
    return this.routeExtended('vectorStats', (a) => a.vectorStats(), (t) => t.vectorStats?.());
  }

  doctor(): Promise<MemoryDoctorReport> {
    return this.routeExtended('doctor', (a) => a.doctor(), (t) => t.doctor?.());
  }

  // ── The sync-recall seam ──────────────────────────────────────────────────────

  /**
   * Refresh the cached recall snapshot ASYNCHRONOUSLY over the CURRENT route (wire
   * when adopted, local otherwise). Call this from an async pre-turn hook so a
   * SYNCHRONOUS prompt builder can read the result via {@link recallSnapshot}
   * without awaiting the wire. Runs the honest recall search (recall-injection
   * contract ON by default), stamps the capture time and mode, and stores it.
   */
  async refreshRecallSnapshot(
    filter: MemorySearchFilter = {},
    options: MemoryRecallRefreshOptions = {},
  ): Promise<MemoryRecallSnapshot> {
    const recall = options.recall ?? true;
    const result = await this.route().honestSearch(filter, { recall });
    this.snapshot = buildRecallSnapshot(result, this.mode(), Date.now(), this.staleAfterMs);
    return this.snapshot;
  }

  /**
   * Read the last recall snapshot SYNCHRONOUSLY (for a sync prompt builder). Never
   * opens the file and never awaits: it returns whatever the last async refresh
   * captured, with a freshly-computed age, a `stale` flag, and an HONEST `note`. If
   * no refresh has happened yet it returns an EMPTY snapshot whose note says exactly
   * that — never a silent empty that reads as "nothing was ever stored."
   */
  recallSnapshot(now: number = Date.now()): MemoryRecallSnapshot {
    const cached = this.snapshot;
    if (cached === null || cached.search === null || cached.capturedAt === null) return emptyRecallSnapshot(this.mode());
    return buildRecallSnapshot(cached.search, cached.mode, cached.capturedAt, this.staleAfterMs, now);
  }

  /**
   * The single choke point that realizes the one-writer invariant: in client mode
   * EVERY op resolves through the transport and the local store is never reached.
   */
  private route(): MemoryAccess {
    return (this.transport as MemoryAccess | null) ?? this.local;
  }

  /**
   * Route an extended verb. Local mode → the local store. Client mode → the
   * transport's verb if it implements it, otherwise an HONEST rejection stating the
   * adopted daemon does not support it (never a silent local-file read, which would
   * break the single-writer invariant and misreport which store answered).
   *
   * TWO honesty layers, both landing on the same {@link memoryVerbUnavailableError}
   * message:
   *  1. COMPILE-TIME omission (here): a transport object that literally does not
   *     implement the verb (`call === undefined`) — a surface pinned to an adapter
   *     that predates the verb. Rejects immediately.
   *  2. RUNTIME signal (the transports): a transport that DOES implement the verb but
   *     whose adopted daemon route answers a route-not-found 404 folds that 404
   *     through `foldMemoryWireExtendedError` in its own catch and rejects with the
   *     same message. That path — not this one — is what a live older daemon
   *     actually produces; this branch alone never sees it, because a real transport
   *     supplies a concrete function for every verb.
   */
  private routeExtended<T>(
    verb: keyof MemoryExtendedAccess,
    local: (access: MemoryAccess) => Promise<T>,
    wire: (transport: MemoryTransport) => Promise<T> | undefined,
  ): Promise<T> {
    if (this.transport === null) return local(this.local);
    const call = wire(this.transport);
    if (call === undefined) {
      return Promise.reject(memoryVerbUnavailableError(verb));
    }
    return call;
  }
}
