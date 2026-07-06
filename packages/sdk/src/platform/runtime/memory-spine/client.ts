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
 */

import { logger } from '../../utils/logger.js';
import type { MemoryAddOptions, MemoryRecord, MemoryReviewPatch, MemorySearchFilter } from '../../state/memory-store.js';
import type { HonestMemorySearchOptions, HonestMemorySearchResult } from '../../state/memory-recall-contract.js';

/**
 * The memory read/write surface a caller uses without caring whether it resolves
 * locally or over the wire. Every method is async so a local (sync store) and a
 * wire (async) backend present the SAME shape.
 */
export interface MemoryAccess {
  add(opts: MemoryAddOptions): Promise<MemoryRecord>;
  honestSearch(filter: MemorySearchFilter, options?: HonestMemorySearchOptions): Promise<HonestMemorySearchResult>;
  get(id: string): Promise<MemoryRecord | null>;
  updateReview(id: string, patch: MemoryReviewPatch): Promise<MemoryRecord | null>;
  delete(id: string): Promise<boolean>;
}

/**
 * The injected wire transport. A consumer builds a thin adapter over the daemon's
 * memory.records.* routes (POST /api/memory/records, /search, GET/DELETE
 * /api/memory/records/:id, POST /api/memory/records/:id/review). The core only ever
 * calls these methods — it never assumes a typed client exists, so a surface pinned
 * to an older SDK can still adapt raw REST, exactly like the session spine.
 */
export type MemoryTransport = MemoryAccess;

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
}

/** Wrap a local embedded store (e.g. a MemoryRegistry) as a MemoryAccess. */
export function createLocalMemoryAccess(store: LocalMemoryStore): MemoryAccess {
  return {
    add: (opts) => Promise.resolve(store.add(opts)),
    honestSearch: (filter, options) => Promise.resolve(store.honestSearch(filter, options)),
    get: (id) => Promise.resolve(store.get(id)),
    updateReview: (id, patch) => Promise.resolve(store.review(id, patch)),
    delete: (id) => Promise.resolve(store.delete(id)),
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
  readonly log?: SpineLogger;
}

/**
 * Routes memory access to the LOCAL embedded store or, when a daemon has been
 * adopted, THROUGH the wire — never both. Implements {@link MemoryAccess} so a
 * caller uses one object regardless of mode.
 */
export class MemorySpineClient implements MemoryAccess {
  private readonly local: MemoryAccess;
  private transport: MemoryTransport | null;
  private readonly log: SpineLogger;

  constructor(options: MemorySpineClientOptions) {
    this.local = options.local;
    this.transport = options.transport ?? null;
    this.log = options.log ?? logger;
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

  /**
   * The single choke point that realizes the one-writer invariant: in client mode
   * EVERY op resolves through the transport and the local store is never reached.
   */
  private route(): MemoryAccess {
    return this.transport ?? this.local;
  }
}
