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
// ── group identity, membership and keys ─────────────────────────────────────
export {
  deriveGroupId,
  deriveJoinSalt,
  deriveJoinVerifier,
  digestSurfaceId,
  generateGroupKey,
  generateGroupRoot,
  generateJoinKey,
  generateNodeKeyMaterial,
  isValidGroupId,
  normalizeJoinKey,
  JOIN_SCRYPT_PARAMS,
  type NodeKeyMaterial,
  type WrappedKeyEnvelope,
} from './group-crypto.js';
export {
  admitMember,
  createGroupStateDocument,
  DEFAULT_GROUP_DISPLAY_NAME,
  findTombstone,
  GROUP_TOMBSTONE_MAX_AGE_MS,
  isCurrentMember,
  MAX_GROUP_MEMBERS,
  MAX_GROUP_TOMBSTONES,
  mergeGroupState,
  nextMembershipGeneration,
  readGroupStateDocument,
  readmitMember,
  removeMember,
  renameGroup,
  sweepGroupState,
  type GroupMember,
  type GroupStateDocument,
  type GroupTombstone,
} from './group-state.js';
export {
  adoptGroupKeys,
  clearGroupKeyMaterial,
  createGroupKeyMaterial,
  GROUP_MATERIAL_SECRET_KEY,
  GROUP_STATE_FILENAME,
  GroupKeyring,
  joiningGroupKeyMaterial,
  loadGroupKeyMaterial,
  loadGroupState,
  MAX_KEY_AGE_MS,
  MAX_KEY_GENERATIONS,
  preferredKeyRecord,
  readGroupKeyMaterial,
  rotateGroupKeyMaterial,
  saveGroupKeyMaterial,
  saveGroupState,
  sweepKeyHistory,
  type ClusterSecretStore,
  type GroupKeyMaterial,
  type GroupKeyRecord,
} from './group-store.js';
export {
  ADMISSION_FRESHNESS_MS,
  decideAdmission,
  describeRefusal,
  GROUP_MESSAGE_TYPES,
  isOutOfBandMessageType,
  type AdmissionDecision,
  type AdmissionGrant,
  type AdmissionRefusal,
} from './group-membership.js';
export { GroupAdmissionService, type AdmissionOutcome } from './group-admissions.js';
export {
  CLUSTER_ENVELOPE_VERSION,
  canonicalizeEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  MAX_ENVELOPE_BYTES,
  peekEnvelope,
  signEnvelope,
  type ClusterEnvelope,
  type ClusterKeyring,
  type EnvelopeDecodeResult,
  type EnvelopeRejection,
} from './protocol-envelope.js';
export { GroupWireRouter, type GroupWireCounters } from './group-transport.js';
export {
  classifyDaemonConfigPath,
  isPortConfigKey,
  isReplicatedConfigPath,
  isReplicatedSecretKey,
  listDaemonConfigClassifications,
  listReplicatedConfigPaths,
  NODE_LOCAL_CONFIG_DOMAINS,
  replicatedSecretKeyFor,
  replicatedSecretKeys,
  REPLICATED_CONFIG_DOMAINS,
  type ConfigPathClassification,
  type ConfigReplicationClass,
} from './config-replication-policy.js';
export {
  CONFIG_TOMBSTONE_MAX_AGE_MS,
  createConfigReplicaDocument,
  deleteReplicaEntry,
  findReplicaEntry,
  MAX_REPLICATED_ENTRIES,
  MAX_REPLICATED_TOMBSTONES,
  MAX_REPLICATED_VALUE_BYTES,
  mergeConfigReplica,
  putReplicaEntry,
  readConfigReplicaDocument,
  sweepConfigReplica,
  type ConfigReplicaDocument,
  type ConfigReplicaEntry,
  type ConfigReplicaTombstone,
} from './config-replica.js';
export {
  CONFIG_MESSAGE_TYPES,
  ConfigReplicationService,
  type ConfigReplicationHost,
  type ConfigReplicationStatus,
  type ReplicatedConfigStore,
  type ReplicatedSecretStore,
} from './config-replication.js';
export {
  ClusterGroupRuntime,
  type ClusterGroupRuntimeOptions,
  type DiscoveredGroup,
  type GroupMembershipState,
  type SurfaceHolding,
} from './group-runtime.js';
export {
  ADMISSION_TIMEOUT_MS,
  createClusterGroupVerbs,
  createGroup,
  forgetNode,
  groupNodes,
  groupsOnTheNetwork,
  groupStatus,
  joinGroup,
  joinKeyForGroup,
  leaveGroup,
  rejoinGroup,
  renameGroupTo,
  rotateGroupKey,
  stillOnRoster,
  type CreateGroupResult,
  type ForgetNodeResult,
  type GroupOperationResult,
  type GroupOperationsContext,
  type GroupStatusReport,
  type JoinGroupResult,
  type JoinKeyResult,
  type NodeReport,
  type ClusterGroupVerbSurface,
  type LeaveGroupResult,
  type NodesResult,
  type RemovedNodeReport,
  type RenameGroupResult,
  type RotateKeyResult,
} from './group-operations.js';
export {
  DEFAULT_CLUSTER_GROUP_SETTINGS,
  keyRotationGraceMs,
  keyRotationMs,
  resolveClusterGroupSettings,
  type ClusterGroupSettings,
} from './group-settings.js';
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
