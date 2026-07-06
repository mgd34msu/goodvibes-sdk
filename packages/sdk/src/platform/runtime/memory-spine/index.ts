/**
 * @pellux/goodvibes-sdk/platform/runtime/memory-spine
 *
 * The surface-side host-vs-client switch for the daemon-owned single-writer memory
 * service. A daemon host (and any offline/embedded surface) uses the LOCAL store
 * directly; a surface that has adopted a compatible daemon routes memory THROUGH
 * the wire and never opens the store file. Mirrors the session-spine pattern; the
 * offline fallback stays, so the agent and TUI keep working with no daemon running.
 */

export {
  MemorySpineClient,
  createLocalMemoryAccess,
  type MemoryAccess,
  type MemoryAccessMode,
  type MemoryTransport,
  type LocalMemoryStore,
  type MemorySpineClientOptions,
} from './client.js';
