/**
 * @pellux/goodvibes-terminal-shell
 *
 * Shared terminal-shell plumbing for GoodVibes daemon front-ends. This is the
 * single home for the runtime wiring that two front-ends must keep identical:
 * gateway verb-group composition, terminal enter/restore sequencing,
 * render-tick coalescing, the `cluster` command family and its daemon-target
 * convention, and the terminal output guard. Each capability is a thin,
 * dependency-injected wrapper so a front-end's composition root becomes a
 * few named calls into this package instead of a hand-maintained copy that
 * drifts.
 *
 * The CLI argument surface is a generic engine (cli-parser-engine.ts) over a
 * declarative catalog contract (cli-catalog-types.ts): a daemon-shaped
 * front-end and a terminal-shaped one need different command vocabularies —
 * different commands, different flags, different unknown-token policy — over
 * the SAME token/value/arity/refusal mechanics. `parseGoodVibesCli` is that
 * engine driven by this package's own catalog instance
 * (cli-command-catalog.ts, exported as `GOODVIBES_CLI_CATALOG`) plus its
 * supporting modules (redaction, config overrides, endpoint resolution,
 * feature-flag overrides). A different vocabulary is a different catalog
 * against the same engine, not a forked parser.
 *
 * The startup reachability notice lives in the SDK core instead
 * (`@pellux/goodvibes-sdk/platform/runtime`, the `operations` namespace):
 * SDK-side code needs it too, and the SDK cannot import this package.
 *
 * Alongside the wiring sits the terminal IDIOM: the arithmetic and policy a
 * character-cell surface needs before it can draw anything — capability
 * probing and color downsampling, shell/split/overlay geometry, display-width
 * text fitting, escape-sequence sanitization of untrusted content, and the
 * key-semantics and list-filter conventions two terminal front-ends must
 * answer identically or feel like different products. None of it is
 * front-end-specific; all of it is meaningless outside a terminal, which is
 * why it lives here rather than in the SDK core.
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

export {
  type CliFlagKind,
  type CliFlagValue,
  type CommandFlagSpec,
  type CommandSpec,
  type RejectedFlagSpec,
  type CliCatalog,
  type EngineParseResult,
  catalogFlagArity,
  catalogCommandSpec,
  resolveCatalogCommand,
  catalogFlagsForCommand,
  findCatalogFlagArityConflicts,
} from './cli-catalog-types.js';

export { parseWithCatalog } from './cli-parser-engine.js';

export {
  GOODVIBES_CLI_CATALOG,
  type GoodVibesCliFlagField,
} from './cli-command-catalog.js';

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

export {
  classifyBindPosture,
  isLoopbackHost,
  isNetworkFacing,
  type BindPosture,
  type BindPostureKind,
} from './cli-network-posture.js';

export {
  SYNC_BEGIN,
  SYNC_END,
  downsampleColor,
  nearestAnsi16Fg,
  nearestAnsi256,
  probeTermCaps,
  wrapSynced,
  type ColorCapability,
  type TermColorCaps,
} from './term-caps.js';

export { stripDangerousAnsi } from './ansi-sanitize.js';

export {
  createShellLayout,
  createSplitPaneLayout,
  type Rect,
  type ShellLayout,
  type ShellLayoutRequest,
  type SplitPaneLayout,
} from './layout-engine.js';

export {
  getSurfaceContentRows,
  getTrackedVisibleWindow,
  getVisibleWindow,
  sliceVisibleWindow,
  type SurfaceViewportRequest,
  type VisibleWindow,
} from './surface-layout.js';

export {
  getOverlayContentBudget,
  getOverlayMaxWidth,
  getOverlaySurfaceMetrics,
  getOverlayWidthClass,
  getStableOverlayContentRows,
  type OverlaySurfaceMetrics,
  type OverlaySurfaceMetricsOptions,
  type OverlayViewportBudgetOptions,
  type OverlayWidthClass,
} from './overlay-viewport.js';

export {
  fitLabelDetailColumns,
  wrapWithHangingIndent,
} from './text-layout.js';

export { computePromptContentWidth } from './prompt-content-width.js';

export {
  isTextBackspace,
  isTextForwardDelete,
} from './delete-key-policy.js';

export {
  POPULAR_PROVIDERS,
  filterProviders,
  groupProviders,
} from './model-picker-provider-filter.js';

export { BookmarkModal } from './bookmark-modal.js';

export {
  startMcpConfigAutoReload,
  type McpRuntimeReloadHandle,
  type McpRuntimeReloadOptions,
} from './mcp-runtime-reload.js';
