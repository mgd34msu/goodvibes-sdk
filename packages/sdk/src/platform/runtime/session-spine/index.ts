/**
 * @pellux/goodvibes-sdk/platform/runtime/session-spine
 *
 * The ONE session-spine surface client extracted from the near-twin TUI and agent
 * implementations, plus the cross-surface session read facade (union cache). Both
 * are consumed by two-plus surfaces (TUI, agent, and — in waiting — webui / PWA),
 * which is why they live here per the SDK-boundary rule (machinery needed by 2+
 * surfaces => SDK). See docs/decisions/2026-07-05-session-spine-sdk-extraction.md.
 */

export {
  SessionSpineClient,
  foldLegacySpineStore,
  TUI_SPINE_PARTICIPANT,
  AGENT_SPINE_PARTICIPANT,
  type SpineReachability,
  type SpineOutcome,
  type SpineResult,
  type SpineTransport,
  type SessionSpineRecord,
  type SessionSpineClientOptions,
  type FoldLegacySpineStoreOptions,
  type FoldLegacySpineStoreResult,
} from './client.js';

export {
  SessionUnionCache,
  deriveSpineFooterStatus,
  type LocalSessionReader,
  type WireSessionReader,
  type SessionUnionMode,
  type CrossSurfaceView,
  type SessionReadFacade,
  type SessionUnionCacheOptions,
} from './union-cache.js';
