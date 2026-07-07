/**
 * @pellux/goodvibes-sdk/platform/runtime/memory-spine
 *
 * The surface-side host-vs-client switch for the daemon-owned single-writer memory
 * service. A daemon host (and any offline/embedded surface) uses the LOCAL store
 * directly; a surface that has adopted a compatible daemon routes memory THROUGH
 * the wire and never opens the store file. Mirrors the session-spine pattern; the
 * offline fallback stays, so the agent and TUI keep working with no daemon running.
 *
 * As of 1.2.0 the client exposes the FULL read/write catalog (see
 * MemoryExtendedAccess) so a wire client fully detaches from the file, plus a
 * freshness-stamped recall snapshot (recall-snapshot.ts) for the synchronous
 * per-turn prompt-injection seam.
 */

export {
  MemorySpineClient,
  createLocalMemoryAccess,
  type MemoryAccess,
  type MemoryCoreAccess,
  type MemoryExtendedAccess,
  type MemoryAccessMode,
  type MemoryTransport,
  type MemoryUpdatePatch,
  type LocalMemoryStore,
  type MemorySpineClientOptions,
  type MemoryRecallSnapshot,
  type MemoryRecallRefreshOptions,
} from './client.js';

export {
  buildRecallSnapshot,
  emptyRecallSnapshot,
  DEFAULT_RECALL_SNAPSHOT_STALE_AFTER_MS,
} from './recall-snapshot.js';

export {
  classifyMemoryWireError,
  memoryVerbUnavailableError,
  foldMemoryWireExtendedError,
  type MemoryWire404Disposition,
} from './wire-verb-availability.js';
