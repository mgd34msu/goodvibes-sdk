/**
 * Browser automation as a platform capability.
 *
 * Provisioning, sessions, snapshots and every page operation, with no product
 * surface in sight. Everything that reaches outside this module, a process, a
 * file, the Playwright driver, the untrusted-content ledger, arrives through
 * an injected record, so the same engine serves the agent, the daemon, and any
 * other surface without carrying one product's wiring.
 *
 * Requires `playwright-core` at runtime. It is an optional dependency: a build
 * that never opens a browser never installs it, and one that does gets it
 * staged beside the executable or self-provisioned on first use.
 */
export type {
  BrowserBinarySource,
  BrowserDriverResolution,
  BrowserElementRef,
  BrowserLaunchResult,
  BrowserPageInfo,
  BrowserProvisionFailure,
  BrowserProvisionIo,
  BrowserProvisionReport,
  BrowserProvisionStep,
  BrowserSessionInfo,
  BrowserSessionOrigin,
  BrowserSnapshot,
  CommandOutcome,
  OutwardEffectDecision,
  OwnerApproval,
  UntrustedContentEnvelope,
  UntrustedContentPort,
} from './browser-types.js';

export { BrowserEngine, UntrustedEffectError } from './browser-engine.js';
export type { BrowserEngineOptions, BrowserExtractField, BrowserTarget } from './browser-engine.js';
export { looksLikeCredentialPage } from './browser-engine-contract.js';

export {
  BrowserSessionError,
  BrowserSessionManager,
  browserProfileRoot,
  browserScreenshotRoot,
  cdpEndpointCandidates,
  hasDisplay,
} from './browser-sessions.js';
export type {
  BrowserAttachOptions,
  BrowserLaunchOptions,
  BrowserSessionManagerDeps,
  ReachableCdpEndpoint,
} from './browser-sessions.js';

export {
  SnapshotStore,
  StaleElementError,
  resolveRef,
  takeSnapshot,
} from './browser-snapshot.js';

export {
  describeProvisionWork,
  ensureBrowserBinary,
  installRuntimeCandidates,
  installRuntimeCandidatesFor,
} from './browser-provisioning.js';
export type { EnsureBrowserOptions, InstallRuntimeCandidate } from './browser-provisioning.js';

export {
  DRIVER_REQUIRED_FILES,
  DRIVER_VERSION,
  createBrowserProvisionIo,
  defaultBrowsersPath,
  driverSearchDirectories,
  driverTarballUrl,
  findDriverDirectory,
  loadDriverModule,
  managedDriverRoot,
  resolveDriver,
  runCommand,
} from './browser-provision-io.js';
export type { BrowserDriverLocation, BrowserProvisionIoOptions } from './browser-provision-io.js';

export { BrowserHostClient, BrowserHostError, browserHostScriptPath, remoteContext, remotePage } from './browser-host-client.js';
export type { BrowserHostOptions, RemoteContextHandle } from './browser-host-client.js';

export { driverRemediation, shippedDriverPath } from './browser-driver-remediation.js';
export type {
  BrowserDriverInstallKind,
  BrowserDriverInstallProfile,
  DriverRemediationOptions,
} from './browser-driver-remediation.js';

export { extractTarGzEntry, extractTarGzTree, readTarGzEntries } from './browser-driver-archive.js';
export type {
  ExtractTarGzTreeOptions,
  ExtractTarGzTreeResult,
  TarEntry,
  TarEntryKind,
} from './browser-driver-archive.js';
