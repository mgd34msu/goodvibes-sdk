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
export { PlatformServiceManager } from './service-manager.js';
export type { ManagedServiceStatus } from './service-manager.js';
export { isPortAvailable, requirePortAvailable } from './port-check.js';
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
