export { DaemonServer } from './server.js';
export { bootDaemon } from './boot.js';
export type { BootDaemonOptions, BootedDaemon } from './boot.js';
// Fatal-boot disclosure: a direct, unbuffered descriptor write immune to a
// replaced process.stdout/stderr and to exit-time truncation. Both the TUI
// and the agent vendored this as an identical local mirror because the
// published SDK predated this export path; this is the one implementation.
export { reportFatalBootFailure, writeExitingStdoutLine, writeFatalLine } from './fatal-boot-report.js';
// Port-conflict-honest Bun.serve wrapper: bounds a thrown request-handler
// failure to a stack-free JSON 500 without swallowing a real bind-time
// failure (e.g. EADDRINUSE), which still propagates to the caller.
export { createHostRequestFailureResponse, createSafeHostServeFactory } from './safe-serve.js';
export type { DaemonUpdateArtifact } from './facade-lifecycle.js';
export { HttpListener } from './http-listener.js';
// Hosted sessions: the composition a product wires, and the option shape it
// states its trust posture through. The engine itself is
// `@pellux/goodvibes-sdk/platform/hosted-sessions`.
export { composeHostedSessions } from './hosted-sessions-composition.js';
export type {
  DaemonHostedSessionsOptions,
  HostedSessionCompositionInput,
} from './hosted-sessions-composition.js';
export { PlatformServiceManager } from './service-manager.js';
// ManagedServiceActionResult joins ManagedServiceStatus: it is the return type
// of the injectable `actionRunner`, so a host supplying one has to name it. The
// agent mirrored its three fields structurally for want of this line.
export type { ManagedServiceActionResult, ManagedServiceStatus } from './service-manager.js';
export { isPortAvailable, requirePortAvailable } from './port-check.js';
// The web listener's port resolver, beside the daemon host/port resolvers this
// barrel already publishes. Both the TUI's and the daemon's endpoint resolution
// re-implemented the coercion inline because only the daemon-port half was
// reachable, so one binding was validated by the SDK and its neighbour by a copy.
export { resolveWebPort } from './host-resolver.js';
export {
  buildMissingScopeBody,
  resolveAuthenticatedPrincipal,
  resolvePrivateHostFetchOptions,
} from './http-policy.js';
export { createDaemonChannelRouteHandlers } from './http/channel-routes.js';
export { createDaemonControlRouteHandlers } from './http/control-routes.js';
export { createDaemonIntegrationRouteHandlers } from './http/integration-routes.js';
export { createDaemonKnowledgeRouteHandlers } from './http/knowledge-routes.js';
export { createDaemonMediaRouteHandlers } from './http/media-routes.js';
export { createDaemonSystemRouteHandlers } from './http/system-routes.js';
export { createDaemonTelemetryRouteHandlers } from './http/telemetry-routes.js';
export { jsonErrorResponse } from '@pellux/goodvibes-daemon-sdk';
export {
  dispatchClusterGroupRoutes,
  type ClusterGroupRouteContext,
  type ClusterGroupVerbs,
} from './http/cluster-group-routes.js';
