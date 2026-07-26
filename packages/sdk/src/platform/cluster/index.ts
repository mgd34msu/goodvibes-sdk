/**
 * LAN leader election — exactly one node consumes inbound channels.
 *
 * Wire a `ClusterCoordinator` in a composition root, register every INBOUND
 * consumer with it, and start it. Outbound sends, sessions, the control plane
 * and HTTP never pass through here: leadership gates what a node listens to,
 * never what it can do.
 *
 * The protocol is LAN-only. Nothing in this module contacts Telegram, ntfy, or
 * any other external service, and nothing in it is ever surfaced to a user —
 * elections, heartbeats and promotions are log lines and a `/status` section,
 * never a notification and never a transcript line.
 */
export { ClusterCoordinator, type ClusterCoordinatorOptions } from './coordinator.js';
export { ClusterElection, type ClusterElectionOptions } from './election.js';
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
  compareRank,
  compareVersions,
  isStrictlyNewerVersion,
  outranks,
  type ClusterRankable,
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
  ClusterTransport,
  ClusterTransportDescription,
  SignedClusterMessage,
} from './types.js';
