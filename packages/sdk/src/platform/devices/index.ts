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
 *  - device-policy-source — fixed policy or live resolver, shared by all three.
 *  - device-posture-config — the `device.*` settings → policy structs mapping.
 *  - device-posture-runtime — one call that stands the feature up in a host.
 *  - device-phone-tool — the `phone` tool every host registers on its registry.
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
  encodeDeviceCapabilityMedia,
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
  resolveDeviceRequestTimeoutMs,
} from './device-capability-service.js';
export { resolveDevicePolicySource } from './device-policy-source.js';
export type { DevicePolicySource } from './device-policy-source.js';

export {
  DEVICE_POSTURE_CONFIG_KEYS,
  readDeviceArtifactPolicy,
  readDeviceCapabilityPolicy,
  readDeviceGrantPolicy,
  readDeviceRequestTimeoutMs,
  readDeviceSweepIntervalMs,
  readDevicePostureSettings,
} from './device-posture-config.js';
export type {
  DevicePostureConfigKey,
  DevicePostureConfigReader,
  DevicePostureSettings,
} from './device-posture-config.js';

export {
  DEVICE_NODE_ANNOUNCEMENT_KEY,
  createDevicePostureRuntime,
  listDeviceNodesFromTransport,
  readDeviceAnnouncement,
} from './device-posture-runtime.js';
export type {
  DeviceApprovalBridge,
  DevicePeerTransport,
  DevicePeerView,
  DevicePostureRuntime,
  DevicePostureRuntimeOptions,
  DeviceWorkView,
} from './device-posture-runtime.js';

export { createDevicePhoneTool, registerDevicePhoneTool } from './device-phone-tool.js';
export type { DevicePhoneToolRegistry } from './device-phone-tool.js';

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
