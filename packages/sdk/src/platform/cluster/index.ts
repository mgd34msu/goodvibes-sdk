/**
 * LAN leader election — exactly one node consumes each inbound surface.
 *
 * Wire a `ClusterCoordinator` in a composition root, register every INBOUND
 * consumer with it — one gate per surface it can actually serve — and start it.
 * Outbound sends, sessions, the control plane and HTTP never pass through here:
 * leadership gates what a node listens to, never what it can do.
 *
 * Elections are per surface, so a node that can serve ntfy but not Telegram
 * contests ntfy alone, and losing the ntfy holder moves ntfy without touching
 * anything else.
 *
 * The protocol is LAN-only. Nothing in this module contacts Telegram, ntfy, or
 * any other external service, and nothing in it is ever surfaced to a user —
 * elections, heartbeats and promotions are log lines and a `/status` section,
 * never a notification and never a transcript line. Surfaces travel as digests,
 * so a packet capture on the LAN never yields a topic name or a bot id.
 */
export { ClusterCoordinator, type ClusterCoordinatorOptions } from './coordinator.js';
export { ClusterElection, type ClusterElectionOptions } from './election-node.js';
export { SurfaceElection, type SurfaceElectionHost, type SurfaceElectionOptions } from './election.js';
export {
  ClusterSurfaceRegistry,
  type RegisteredClusterSurface,
} from './surface-registry.js';
export {
  ClusterHoldingsLedger,
  type ClusterHoldingRecord,
  type ClusterHoldingsOptions,
} from './holdings.js';
export { createSystemClusterClock, FakeClusterClock } from './clock.js';
export { MemoryClusterBus, MemoryClusterTransport } from './memory-transport.js';
export { UdpClusterTransport, parsePeers, type UdpClusterTransportOptions } from './udp-transport.js';
export {
  CLUSTER_NODE_ID_FILENAME,
  isValidNodeId,
  resolveNodeIdentity,
  type ResolveNodeIdOptions,
  type ResolvedNodeIdentity,
} from './identity.js';
export {
  canonicalSurfaceKey,
  inboxSurface,
  isSurfaceId,
  ntfySurface,
  providerSurface,
  stableSurfaceHash,
  surfaceIdFor,
  surfaceLabel,
  telegramBotIdFromToken,
  telegramSurface,
  type ClusterSurfaceKey,
  type ClusterSurfaceKind,
} from './surface-id.js';
export {
  compareSpreadRank,
  compareStableRank,
  compareVersions,
  isStrictlyNewerVersion,
  outranksForSurface,
  outranksStably,
  shouldYieldSurface,
  SURFACE_YIELD_GAP,
  type ClusterRankable,
  type ClusterSpreadRankable,
} from './ranking.js';
export {
  canonicalizeMessage,
  decodeMessage,
  encodeMessage,
  signMessage,
  type ClusterDecodeResult,
} from './protocol.js';
export { readClusterSettings } from './config-read.js';
export {
  DEFAULT_CLUSTER_MULTICAST_GROUP,
  DEFAULT_CLUSTER_PORT,
  DEFAULT_CLUSTER_SETTINGS,
  resolveClusterSettings,
} from './settings.js';
export { deriveClusterTiming, type ClusterTiming } from './timing.js';
export { CLUSTER_PROTOCOL_VERSION } from './types.js';
export type {
  ClusterClock,
  ClusterConsumerGate,
  ClusterConsumerStartContext,
  ClusterLogger,
  ClusterMessage,
  ClusterMessageType,
  ClusterPeerStatus,
  ClusterRole,
  ClusterSettings,
  ClusterStatus,
  ClusterSurfaceStatus,
  ClusterTransport,
  ClusterTransportDescription,
  SignedClusterMessage,
} from './types.js';
