/**
 * @pellux/goodvibes-sdk/platform/runtime/client
 *
 * The client SEAMS: what a surface product does at each place its own process
 * stops and the daemon's begins.
 *
 * `client-services.ts` next door is the COMPOSITION shape, what a surface's
 * turn needs in-process. This directory is the other half of the same split:
 * for every capability that composition deliberately does NOT hold (approvals,
 * daemon-owned config and credentials, inbound session dispatch, conversation
 * rewind, device posture, the fleet and task registers, the spines), the policy
 * a surface applies when reaching the daemon for it.
 *
 * Every module here is policy over injected I/O. The I/O is one shape,
 * {@link DaemonVerbCaller}, two methods, and resolving what it points at stays
 * with the product, because deciding which daemon this surface trusts is a
 * trust-boundary concern the SDK core deliberately never reaches into.
 *
 * These were written twice, once per surface product, before they were written
 * here. What that cost is on the record: two implementations of the same
 * bounded-start policy, three shapes of one rewind port contract, and a
 * permission ask that was invisible to every surface but the one that raised it.
 */

export type { DaemonReachability, DaemonVerbCaller } from './daemon-verbs.js';

export { createClientApprovalRaiser } from './approval-raiser.js';
export type {
  ApprovalUpdateSubscriber,
  ClientApprovalRaiserOptions,
  LocalPermissionPrompt,
} from './approval-raiser.js';

export {
  APPROVAL_UPDATE_DOMAIN,
  APPROVAL_UPDATE_WIRE_EVENT,
  approvalUpdateStreamUrl,
  awaitApprovalDecision,
  readApprovalUpdateNotice,
  watchApprovalUpdates,
} from './approval-updates.js';
export type {
  ApprovalUpdateNotice,
  ApprovalUpdateRecord,
  ApprovalUpdateSubscription,
  WatchApprovalUpdatesOptions,
} from './approval-updates.js';

export { createDaemonConfigClient, isDaemonOwnedConfigKey } from './config-client.js';
export type { DaemonConfigClient } from './config-client.js';

export { createDaemonCredentialsClient } from './credentials-client.js';
export type { CredentialWriteReceipt, DaemonCredentialsClient } from './credentials-client.js';

export { createWireSessionDispatch, readSurfaceAgentOutcome } from './session-dispatch.js';
export type {
  SessionInputsWireClient,
  SurfaceAgentOutcome,
  WireSessionDispatch,
  WireSessionDispatchOptions,
} from './session-dispatch.js';

export { createConversationRewindHost } from './conversation-rewind-host.js';
export type {
  ConversationRewindHostClient,
  ConversationRewindHostOptions,
} from './conversation-rewind-host.js';

export { createDevicesClient } from './devices-client.js';
export type {
  DeviceArtifactSummary,
  DeviceCapabilityOutcomeWire,
  DeviceGrantSummary,
  DeviceNodeSummary,
  DevicesClient,
} from './devices-client.js';

export { createClientPhoneTool, registerClientPhoneTool } from './phone-tool.js';
export type { PhoneToolRegistry } from './phone-tool.js';

export { createTasksClient } from './tasks-client.js';
export type {
  LocalTaskSource,
  TaskOrigin,
  TasksClient,
  TasksUnionResult,
  UnionTask,
} from './tasks-client.js';

export {
  createDaemonFleetRowsPoller,
  daemonOnlyFleetActRefusal,
  DEFAULT_FLEET_REFRESH_MS,
  mergeFleetNodes,
  readDaemonFleetRows,
} from './fleet-union.js';
export type {
  DaemonFleetRows,
  DaemonFleetRowsPoller,
  DaemonFleetRowsPollerOptions,
} from './fleet-union.js';

export {
  autostartInstalledDaemon,
  createDaemonServiceControl,
  describeDaemonAutostart,
  LEGACY_DAEMON_SERVICE_NAME,
  MANAGED_DAEMON_SERVICE_NAME,
} from './daemon-autostart.js';
export type {
  DaemonAutostartInactionReason,
  DaemonAutostartOptions,
  DaemonAutostartOutcome,
  DaemonServiceActionResult,
  DaemonServiceControl,
  DaemonServiceControlOptions,
  DaemonServiceSnapshot,
  DaemonServiceStartResult,
} from './daemon-autostart.js';

export {
  createDaemonHandoverProgress,
  DAEMON_HANDOVER_TIMEOUT_MS,
  DAEMON_REPO_RELEASES_LATEST_URL,
  DAEMON_SPLIT_FLOOR_VERSION,
  DAEMON_VERSION_PROBE_TIMEOUT_MS,
  daemonReleaseDownloadBaseUrl,
  decideDaemonHandover,
  HANDOVER_ABORTED_MESSAGE,
  isPreSplitDaemonVersion,
  parseDaemonVersionOutput,
  performDaemonHandover,
  readInstalledDaemonVersion,
  resolveHandoverServiceName,
  restartHandedOverDaemon,
  runDaemonHandover,
} from './daemon-handover.js';
export type {
  DaemonHandoverDecision,
  DaemonHandoverDecisionInput,
  DaemonHandoverOutcome,
  DaemonHandoverProgress,
  DaemonHandoverSkipReason,
  DaemonRestartOutcome,
  PerformDaemonHandoverOptions,
  RunCommandLike,
  RunDaemonHandoverOptions,
} from './daemon-handover.js';

export { createSpineAdoptionSync } from './spine-adoption.js';
export type {
  InboundInputsActivation,
  MemorySpineActivation,
  SessionUnionActivation,
  SpineActivationTiming,
  SpineAdoptionOptions,
  SpineAdoptionSignal,
  SpineWireBundle,
} from './spine-adoption.js';
