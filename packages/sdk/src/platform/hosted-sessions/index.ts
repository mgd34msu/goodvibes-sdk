/**
 * platform/hosted-sessions — a conversation loop composed INSIDE the daemon.
 *
 * The capability behind `sessions.hosted.*`: the same orchestrator, tool
 * registry and permission gate a terminal runs, hosted in the daemon process so
 * a conversation does not depend on the client that opened it staying open.
 *
 * The pieces, in the order they matter:
 *  - {@link HostedSessionManager} — lifecycle, the detach policy, durability.
 *  - {@link createHostedSessionRuntime} — one session's loop.
 *  - {@link HostedWorkspaceFloors} — the composition every session in one
 *    workspace shares, and the reasoning for sharing it.
 *  - {@link HostedSessionStore} — the bounded, validated, swept disk state.
 *
 * A product supplies two things and no more: how a workspace floor is built
 * (which is where its trust posture lives) and where lifecycle notices go.
 */

export {
  HostedSessionManager,
  HostedSessionArgumentError,
  HostedSessionLimitError,
  HostedSessionNotFoundError,
  HostedSessionUnavailableError,
  HOSTED_SESSION_WIRE_EVENT,
} from './manager.js';
export type {
  HostedLiveTurnRegistry,
  HostedSessionAttachment,
  HostedSessionEventPublisher,
  HostedSessionManagerOptions,
  HostedSessionSettings,
  HostedSessionSpine,
} from './manager.js';

export { createHostedSessionRuntime, newHostedSessionId } from './session-runtime.js';
export type { HostedSessionRuntime, HostedSessionRuntimeOptions } from './session-runtime.js';

export { HostedWorkspaceFloors } from './workspace-floor.js';
export type {
  HostedWorkspaceFloor,
  HostedWorkspaceFloorFactory,
  HostedWorkspaceFloorLease,
} from './workspace-floor.js';

export {
  HostedSessionStore,
  boundMessages,
  describeInvalidPersistedHostedSession,
} from './store.js';
export type {
  HostedSessionLoadReport,
  HostedSessionStoreLimits,
  PersistedHostedSession,
} from './store.js';

export { resolveHostedModelDefinition, withHostedSessionModel } from './model-route.js';

export type {
  CreateHostedSessionInput,
  HostedDetachPolicy,
  HostedSessionHistoryMessage,
  HostedSessionLifecycleEvent,
  HostedSessionRecord,
  HostedSessionStatus,
  HostedSessionTerminationReason,
  HostedSessionUpdatePayload,
} from './types.js';
