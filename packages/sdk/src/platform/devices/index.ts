/**
 * platform/devices — paired-device capabilities as agent tools.
 *
 * The contract spine for using a paired phone's camera, screen, location,
 * clipboard, and device commands from the agent. Native contract over the
 * existing peer transport — deliberately not an MCP server.
 *
 * Layout:
 *  - device-capability-contract — the node-kind-neutral capability catalog and
 *    node profile resolution (runtime-neutral).
 *  - device-peer-work — the wire shape of one request/response (runtime-neutral).
 *  - device-grants — durable "always allow" grants, with revocation and GC.
 *  - device-capture-artifacts — retained captures under a 24h TTL, validated
 *    by content rather than existence.
 *  - device-housekeeping — recovery-time and periodic sweeps, with disclosure.
 *  - device-capability-service — the single path a capability is reached through.
 */
export {
  DEVICE_CAPABILITY_CONTRACT_VERSION,
  DEVICE_CAPABILITY_CATALOG,
  DEVICE_CAPABILITY_IDS,
  KNOWN_DEVICE_NODE_KINDS,
  isDeviceCapabilityId,
  isDeviceNodeKind,
  getDeviceCapability,
  listDeviceCapabilitiesByFamily,
  resolveDeviceNodeProfile,
  describeDeviceNodeKind,
} from './device-capability-contract.js';
export type {
  DeviceCapabilityFamily,
  DeviceCapabilityId,
  DeviceCapabilityEffect,
  DeviceArtifactKind,
  DeviceCapabilitySensitivity,
  DeviceCapabilityField,
  DeviceCapabilityDescriptor,
  DeviceNodeKind,
  DeviceNodeAnnouncement,
  DeviceNodeProfile,
  DeviceNodeRejectionReason,
  DeviceNodeResolution,
} from './device-capability-contract.js';

export {
  DEVICE_CAPABILITY_WORK_TYPE,
  buildDeviceCapabilityWorkRequest,
  parseDeviceCapabilityWorkRequest,
  parseDeviceCapabilityWorkResult,
  validateDeviceCapabilityInput,
  decodeDeviceCapabilityMedia,
} from './device-peer-work.js';
export type {
  DeviceCapabilityWorkRequest,
  DeviceCapabilityWorkResult,
  DeviceCapabilityInputProblem,
} from './device-peer-work.js';

export { DeviceGrantStore, DEFAULT_DEVICE_GRANT_POLICY } from './device-grants.js';
export type {
  DeviceCapabilityGrant,
  DeviceGrantScope,
  DeviceGrantPolicy,
  DeviceGrantOwnership,
  DeviceGrantStoreOptions,
  DeviceGrantRemoval,
  DeviceGrantRemovalReason,
  DeviceGrantAuditRecord,
  DeviceGrantSweepReport,
} from './device-grants.js';

export { DeviceCaptureArtifactStore, DEFAULT_DEVICE_ARTIFACT_POLICY } from './device-capture-artifacts.js';
export type {
  DeviceCaptureArtifact,
  DeviceCaptureStoreOptions,
  DeviceArtifactPolicy,
  DeviceArtifactRemoval,
  DeviceArtifactRemovalReason,
  DeviceArtifactSweepReport,
  DeviceArtifactReadResult,
} from './device-capture-artifacts.js';

export { DeviceHousekeeper } from './device-housekeeping.js';
export type { DeviceHousekeepingOptions, DeviceHousekeepingReport } from './device-housekeeping.js';

export {
  DeviceCapabilityService,
  DEFAULT_DEVICE_CAPABILITY_POLICY,
  isAllowAlwaysOffered,
  capabilityDisabledReason,
} from './device-capability-service.js';
export type {
  DeviceCapabilityMode,
  DeviceAllowAlwaysOffer,
  DeviceLocationPrecision,
  DeviceClipboardReadMode,
  DeviceCapabilityPolicy,
  DeviceConfirmationDecision,
  DeviceConfirmationRequest,
  DeviceConfirmationResponse,
  DeviceConfirmationHandler,
  DeviceDispatchInput,
  DeviceDispatchResult,
  DeviceCapabilityDispatcher,
  DeviceCapabilityServiceOptions,
  DeviceCapabilityOutcome,
  DeviceRequestRefusal,
} from './device-capability-service.js';
