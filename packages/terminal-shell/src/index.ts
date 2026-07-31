/**
 * @pellux/goodvibes-terminal-shell
 *
 * Shared terminal-shell plumbing for GoodVibes daemon front-ends. This is the
 * single home for the runtime wiring that two front-ends must keep identical:
 * gateway verb-group composition, terminal enter/restore sequencing,
 * render-tick coalescing, the `cluster` command family and its daemon-target
 * convention, the shared CLI argument parser and its supporting modules
 * (redaction, config overrides, endpoint resolution, feature-flag overrides),
 * and the terminal output guard. Each capability is a thin, dependency-injected
 * wrapper so a front-end's composition root becomes a few named calls into
 * this package instead of a hand-maintained copy that drifts.
 *
 * The startup reachability notice lives in the SDK core instead
 * (`@pellux/goodvibes-sdk/platform/runtime`, the `operations` namespace):
 * SDK-side code needs it too, and the SDK cannot import this package.
 *
 * See ./conformance for the descriptor/handler gate a consumer runs against its
 * own composition in CI.
 */
export {
  attachWsOnlyGatewayVerbHandlers,
  createArchivableFleetRegistry,
  type GatewayVerbGroupDeps,
  type ProcessRegistryDeps,
  type ArchivableProcessRegistry,
} from './gateway-verbs.js';

export {
  TERMINAL_ESCAPES,
  createTerminalLifecycle,
  type TerminalEscapes,
  type TerminalSequenceSet,
  type TerminalLifecycleDeps,
  type TerminalLifecycle,
} from './terminal-lifecycle.js';

export {
  createRenderScheduler,
  type RenderScheduler,
} from './render-scheduler.js';

export {
  findMethodsMissingHandlers,
  assertEveryDescriptorHasHandler,
  type GatewayCatalogConformanceView,
  type ConformanceOptions,
} from './conformance.js';

export {
  CLUSTER_SUBCOMMANDS,
  isClusterSubcommand,
  parseClusterCommand,
  runClusterCommand,
  type ClusterSubcommand,
  type ParsedClusterCommand,
  type ClusterCommandResult,
  type RunClusterCommandInput,
} from './cluster-commands.js';

export {
  describeAge,
  renderStatus,
  renderNodes,
  renderCreated,
  renderJoined,
  renderForgotten,
  renderDiscovered,
  clipboardEscapeSequence,
  renderJoinKey,
  renderRotated,
  renderJoinKeyQr,
  renderFailure,
  type JoinKeyRendering,
} from './cluster-render.js';

export {
  extractOperatorToken,
  resolveRemoteDaemonTarget,
  callDaemonVerb,
  type RemoteDaemonTarget,
  type RemoteTargetFlags,
  type RemoteTargetResolution,
  type ResolveRemoteTargetInput,
  type DaemonFetch,
  type DaemonVerbOutcome,
} from './cluster-remote-daemon-target.js';

export type {
  GoodVibesCliCommand,
  GoodVibesCliOutputFormat,
  CliCommandOutput,
  GoodVibesCliFlags,
  GoodVibesCliParseResult,
  CliCommandRuntime,
} from './cli-types.js';

export { parseGoodVibesCli } from './cli-parser.js';

export {
  REDACTED_VALUE,
  isSensitiveConfigPath,
  isRedactedValue,
  redactConfig,
  redactText,
  collectSensitiveConfigValues,
  redactSerializedSecrets,
  type RedactedConfigResult,
} from './cli-redaction.js';

export {
  RUNTIME_ENDPOINT_DEFAULT_PORTS,
  RUNTIME_ENDPOINT_CONFIG_KEYS,
  formatRuntimeEndpointBinding,
  hostModeForHostname,
  resolveRuntimeEndpointBinding,
  type RuntimeEndpointId,
  type RuntimeHostMode,
  type RuntimeEndpointBinding,
} from './cli-endpoints.js';

export {
  FEATURE_SETTINGS_BY_ID,
  getFeatureSetting,
  getConfigSchemaSetting,
  isFeatureDefaultEnabled,
  featuresForEnablementKey,
  isFeatureValueEnabled,
  isFeatureConfigEnabled,
  featureEnablementWrite,
  type FeatureEnablementWrite,
} from './cli-feature-settings.js';

export {
  applyRuntimeConfigDefault,
  applyTerminalRuntimeConfigDefaults,
  applyConfiguredHitlMode,
  applyRuntimeConfigValue,
  applyRuntimeConfigOverrides,
  applyRuntimeFeatureFlagOverrides,
  applyRuntimeEndpointFlagOverrides,
  applyRuntimeCommandEndpointFlagOverrides,
} from './cli-config-overrides.js';

export {
  allowTerminalWrite,
  installTerminalOutputGuard,
  installFullScreenTerminalOutputGuard,
  type TerminalOutputInterceptSource,
  type TerminalOutputIntercept,
  type TerminalOutputGuard,
  type TerminalOutputGuardOptions,
  type FullScreenTerminalOutputGuardOptions,
} from './terminal-output-guard.js';
