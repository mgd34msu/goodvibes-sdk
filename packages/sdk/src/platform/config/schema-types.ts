/**
 * Shared config schema types for goodvibes-sdk.
 */
import type { ProfileConfigKey, ProfileConfigValue } from './schema-types-owner-profile.js';
import type { OccasionsConfigKey } from './schema-types-occasions.js';


export * from "./schema-types-surfaces.js";
import type { InboundEmailCapabilityPolicy, InboundEmailMode, InboundEmailNoticeMode, InboundEmailSource, SurfacesConfig } from "./schema-types-surfaces.js";

export * from "./schema-types-network.js";
import type {
  ControlPlaneConfig,
  HttpListenerRuntimeConfig,
  NetworkConfig,
  RelayConfig,
  WebConfig,
} from "./schema-types-network.js";

export * from "./schema-types-platform.js";
import type {
  AtRestConfig,
  BatchConfig,
  BatchFallbackMode,
  BatchMode,
  BatchQueueBackend,
  CloudflareConfig,
  TelemetryConfig,
} from "./schema-types-platform.js";

export * from "./schema-types-permissions.js";
import type { BackgroundAgentsMode, LineNumberMode, PermissionAction, PermissionMode, PermissionsToolConfig } from "./schema-types-permissions.js";
export * from "./schema-types-payments.js";
import type { PaymentsConfig, PaymentsConfigKey, PaymentsConfigValueMap } from "./schema-types-payments.js";

export * from "./schema-types-daemon.js";
import type {
  AutomationConfig,
  NotificationsConfig,
  RuntimeConfig,
  ServiceConfig,
  TtsConfig,
  WatchersConfig,
  DaemonProcessConfig,
  DaemonProcessConfigKey,
  DaemonProcessConfigValueMap,
} from "./schema-types-daemon.js";


export interface GoodVibesConfig {
  display: {
    stream: boolean;            // default: true
    lineNumbers: LineNumberMode; // default: 'off'
    collapseThreshold: number;  // default: 30
    theme: string;              // default: 'vaporwave'
    showThinking: boolean;      // default: false
    showReasoningSummary: boolean; // default: false
    showTokenSpeed: boolean;    // default: false
    showToolPreview: boolean;   // default: false
  };
  provider: {
    reasoningEffort: string;    // default: 'medium' — per-model levels, see providers/reasoning-effort.ts
    model: string;              // default: 'openrouter:openrouter/free'
    embeddingProvider: string;  // default: 'hashed-local'
    systemPromptFile: string;   // default: ''
    optimizerMode: 'off' | 'manual' | 'auto' | 'pinned'; // default: 'off' — provider routing optimizer ('off' = optimizer inactive)
    optimizerPinnedModel: string; // default: '' — provider-qualified model id applied when optimizerMode is 'pinned'
    localContextIngestion: boolean; // default: true — ingest max_context_length from local/custom provider /v1/models
  };
  behavior: {
    autoApprove: boolean;       // default: false
    autoCompactThreshold: number; // default: 80
    compactionStrategy: 'off' | 'structured' | 'distiller'; // default: 'structured' — 'off' runs sessions uncompacted
    staleContextWarnings: boolean; // default: true
    saveHistory: boolean;       // default: true
    notifyOnComplete: boolean;  // default: true
    suggestAlternativeOnProviderFail: boolean; // default: false
    hitlMode: 'off' | 'quiet' | 'balanced' | 'operator'; // default: 'balanced' — 'off' keeps the baseline notification policy
    toolResultReconciliation: 'reconcile' | 'warn-only'; // default: 'reconcile' — inject synthetic results for dangling tool calls at turn end
    returnContextMode: 'off' | 'local' | 'assisted'; // default: 'off'
    guidanceMode: 'off' | 'minimal' | 'guided'; // default: 'minimal'
  };
  storage: {
    secretPolicy: 'plaintext_allowed' | 'preferred_secure' | 'require_secure'; // default: 'preferred_secure'
    artifacts: {
      maxBytes: number;          // default: 512 MiB
    };
  };
  permissions: {
    mode: PermissionMode;       // default: 'prompt'
    tools: PermissionsToolConfig;
    backgroundAgents: BackgroundAgentsMode; // default: 'inherit'
    engine: 'baseline' | 'policy-engine'; // default: 'baseline' — layered tool/path policy evaluator (restart to apply)
    simulation: boolean;        // default: true — dual-evaluator shadow pipeline recording divergence (restart to apply)
    divergenceDashboard: boolean; // default: true — divergence aggregation + enforce-mode gate
    commandParser: 'ast' | 'flat'; // default: 'ast' — shell AST per-segment verdicts vs flat segmentation
    divergenceThreshold: number; // default: 0.05 — divergence-gate max divergence rate
    maxDivergenceRecords: number; // default: 500 — retained divergence records for the simulation dashboard
  };
  diagnostics: {
    postEdit: 'on' | 'off';     // default: 'on' — cheap in-process post-edit syntax diagnostics
  };
  orchestration: {
    recursionEnabled: boolean;  // default: false — allow recursive agent spawning under bounded policy
    maxDepth: number;           // default: 0 — 0=off, higher values allow deeper bounded recursion
  };
  planner: {
    decomposition: 'agent' | 'heuristic';  // default: 'agent' — 'heuristic' forces the old single-item path
    maxTurns: number;                       // default: 6 — turn ceiling for the planning-decomposition agent
    tokenCeiling: number;                   // default: 120000 — token budget for the planning-decomposition agent
    wallTimeoutMs: number;                  // default: 60000 — wall-clock timeout for the planning-decomposition agent
    adaptive: boolean;                      // default: false — score single/cohort/background/remote strategies each turn
  };
  sandbox: {
    // Per-command exec sandbox (bubblewrap). enabled is the operator switch
    // (default true; honestly unavailable where bubblewrap is absent).
    // egressAllowlist and workspaceWritable are arrays (accessed via
    // getCategory('sandbox')), not scalar ConfigKeys.
    enabled: boolean;
    // Model-judgment pass on the residual sandbox ask-tail: off, annotate
    // (default — annotates the human ask, never decides), or auto-approve
    // (additionally auto-approves looks-safe verdicts; explicit opt-in).
    judgment: 'off' | 'annotate' | 'auto-approve';
    egressAllowlist: string[];
    workspaceWritable: string[];
    replIsolation: 'shared-vm' | 'per-runtime-vm';
    mcpIsolation: 'disabled' | 'shared-vm' | 'hybrid' | 'per-server-vm';
    windowsMode: 'native-basic' | 'require-wsl';
    vmBackend: 'local' | 'qemu';
    qemuBinary: string;
    qemuImagePath: string;
    qemuExecWrapper: string;
    qemuGuestHost: string;
    qemuGuestPort: number;
    qemuGuestUser: string;
    qemuWorkspacePath: string;
    qemuSessionMode: 'attach' | 'launch-per-command';
    replJavaScriptCommand: string;
  };
  ui: {
    voiceEnabled: boolean;
    systemMessages: 'panel' | 'conversation' | 'both';
    operationalMessages: 'panel' | 'conversation' | 'both';
    wrfcMessages: 'panel' | 'conversation' | 'both';
  };
  tts: TtsConfig;
  release: {
    channel: 'stable' | 'preview';
  };
  automation: AutomationConfig;
  controlPlane: ControlPlaneConfig;
  httpListener: HttpListenerRuntimeConfig;
  web: WebConfig;
  surfaces: SurfacesConfig;
  watchers: WatchersConfig;
  service: ServiceConfig;
  network: NetworkConfig;
  relay: RelayConfig;
  daemon: { enabled: boolean; embedInProcess: boolean; timezone: string };
  payments: PaymentsConfig;
    // default: enabled true — run the local session daemon (loopback only); embedInProcess false — daemon runs as a detached process, not inside this surface; timezone '' — IANA name the daemon reckons calendar days in, empty means UTC
  danger: {
    httpListener: boolean;          // default: false — enable HTTP webhook listener
  };
  tools: {
    llmEnabled: boolean;            // default: false — enable dedicated tool LLM for internal operations
    llmProvider: string;            // default: '' — provider for tool LLM calls (empty = use current)
    llmModel: string;               // default: '' — model for tool LLM calls (empty = fastest available)
    autoHeal: boolean;              // default: false — auto-fix syntax errors on write/edit
    defaultTokenBudget: number;     // default: 5000 — default token budget for read operations
    hooksFile: string;              // default: 'hooks.json' — hook configuration file name
    overflowSpillBackend: 'file' | 'ledger' | 'diagnostics'; // default: 'file' — where overflow content spills
    contractVerification: boolean;  // default: true — registration-time contract checks on every tool
    outputSchemaFingerprints: boolean; // default: false — append _meta schema fingerprints to find/analyze/inspect results
  };
  wrfc: {
    scoreThreshold: number;
    maxFixAttempts: number;
    autoCommit: boolean;
    agentHeartbeatTimeoutMs: number;
    transportRetryLimit: number;
    transportRetryDelayMs: number;
    commitScope: 'off' | 'scoped' | 'all';   // default: 'scoped'
    // NOTE: gates is an array of objects and does not fit the scalar-value dot-path config API.
    // Access via configManager.getCategory('wrfc').gates — not via ConfigKey/ConfigValue.
    gates: Array<{ name: string; command: string; enabled: boolean }>;
  };
  cache: {
    enabled: boolean;                    // default: true
    stableTtl: '5m' | '1h';          // default: '1h' (for stable content like system+tools)
    monitorHitRate: boolean;             // default: true
    hitRateWarningThreshold: number;     // default: 0.3
  };
  helper: {
    enabled: boolean;                    // default: false
    globalProvider: string;              // default: ''
    globalModel: string;                 // default: ''
    // Per-provider overrides accessed via configManager.getCategory('helper').providers
  };
  // NOTE: notifications.webhookUrls is an array and does not fit the scalar-value dot-path config API.
  // Access via configManager.getCategory('notifications') or mergeCategory('notifications', ...).
  notifications: NotificationsConfig;
  runtime: RuntimeConfig;
  telemetry: TelemetryConfig;
  atRest: AtRestConfig;
  batch: BatchConfig;
  cloudflare: CloudflareConfig;
  pricing: PricingConfig;
}

/** One user-set manual model price, USD per 1M tokens. */
export interface ManualModelPriceConfig {
  input: number;
  output: number;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
}

/** Pricing domain — manual model prices keyed `provider:model`. */
export interface PricingConfig {
  modelPrices: Record<string, ManualModelPriceConfig>;
}

export interface ConfigSetting {
  key: ConfigKey;
  type: 'boolean' | 'number' | 'string' | 'enum' | 'object';
  default: unknown;
  description: string;
  enumValues?: string[] | undefined;
  validate?: ((value: unknown) => boolean) | undefined;
  /** Hint appended to the validation-failure message when `validate` returns false, e.g. `'finite number in [0.25, 4.0]'`. */
  validationHint?: string | undefined;
}

/** Dot-path config keys for all settings. */
export type ConfigKey =
  | 'display.stream'
  | 'display.lineNumbers'
  | 'display.collapseThreshold'
  | 'display.theme'
  | 'display.showThinking'
  | 'display.showReasoningSummary'
  | 'display.showTokenSpeed'
  | 'display.showToolPreview'
  | 'provider.reasoningEffort'
  | 'provider.model'
  | 'provider.embeddingProvider'
  | 'provider.systemPromptFile'
  | 'provider.optimizerMode'
  | 'provider.optimizerPinnedModel'
  | 'provider.localContextIngestion'
  | 'behavior.autoApprove'
  | 'behavior.autoCompactThreshold'
  | 'behavior.compactionStrategy'
  | 'behavior.staleContextWarnings'
  | 'behavior.saveHistory'
  | 'behavior.notifyOnComplete'
  | 'behavior.suggestAlternativeOnProviderFail'
  | 'behavior.hitlMode'
  | 'behavior.toolResultReconciliation'
  | 'behavior.returnContextMode'
  | 'behavior.guidanceMode'
  | 'storage.secretPolicy'
  | 'storage.artifacts.maxBytes'
  | 'permissions.mode'
  | 'permissions.backgroundAgents'
  | 'permissions.engine'
  | 'permissions.simulation'
  | 'permissions.divergenceDashboard'
  | 'permissions.commandParser'
  | 'permissions.divergenceThreshold'
  | 'permissions.maxDivergenceRecords'
  | 'permissions.tools.read'
  | 'permissions.tools.write'
  | 'permissions.tools.edit'
  | 'permissions.tools.exec'
  | 'permissions.tools.find'
  | 'permissions.tools.fetch'
  | 'permissions.tools.analyze'
  | 'permissions.tools.inspect'
  | 'permissions.tools.agent'
  | 'permissions.tools.state'
  | 'permissions.tools.workflow'
  | 'permissions.tools.registry'
  | 'permissions.tools.delegate'
  | 'permissions.tools.mcp'
  | 'diagnostics.postEdit'
  | 'orchestration.recursionEnabled'
  | 'orchestration.maxDepth'
  | 'planner.decomposition'
  | 'planner.maxTurns'
  | 'planner.tokenCeiling'
  | 'planner.wallTimeoutMs'
  | 'planner.adaptive'
  | 'sandbox.enabled'
  | 'sandbox.judgment'
  | 'sandbox.replIsolation'
  | 'sandbox.mcpIsolation'
  | 'sandbox.windowsMode'
  | 'sandbox.vmBackend'
  | 'sandbox.qemuBinary'
  | 'sandbox.qemuImagePath'
  | 'sandbox.qemuExecWrapper'
  | 'sandbox.qemuGuestHost'
  | 'sandbox.qemuGuestPort'
  | 'sandbox.qemuGuestUser'
  | 'sandbox.qemuWorkspacePath'
  | 'sandbox.qemuSessionMode'
  | 'sandbox.replJavaScriptCommand'
  | 'ui.voiceEnabled'
  | 'ui.systemMessages'
  | 'ui.operationalMessages'
  | 'ui.wrfcMessages'
  | 'tts.provider'
  | 'tts.voice'
  | 'tts.llmProvider'
  | 'tts.llmModel'
  | 'tts.speed'
  | 'release.channel'
  | PaymentsConfigKey
  | DaemonProcessConfigKey
  | 'danger.httpListener'
  | 'tools.llmEnabled'
  | 'tools.llmProvider'
  | 'tools.llmModel'
  | 'tools.autoHeal'
  | 'tools.defaultTokenBudget'
  | 'tools.hooksFile'
  | 'tools.overflowSpillBackend'
  | 'tools.contractVerification'
  | 'tools.outputSchemaFingerprints'
  | 'wrfc.scoreThreshold'
  | 'wrfc.maxFixAttempts'
  | 'wrfc.autoCommit'
  | 'wrfc.commitScope'
  | 'wrfc.agentHeartbeatTimeoutMs'
  | 'wrfc.transportRetryLimit'
  | 'wrfc.transportRetryDelayMs'
  | 'cache.enabled'
  | 'cache.stableTtl'
  | 'cache.monitorHitRate'
  | 'cache.hitRateWarningThreshold'
  | 'helper.enabled'
  | 'helper.globalProvider'
  | 'helper.globalModel'
  | 'automation.enabled'
  | 'automation.maxConcurrentRuns'
  | 'automation.runHistoryLimit'
  | 'automation.defaultTimeoutMs'
  | 'automation.catchUpWindowMinutes'
  | 'automation.failureCooldownMs'
  | 'automation.deleteAfterRun'
  | 'controlPlane.enabled'
  | 'controlPlane.gateway'
  | 'controlPlane.hostMode'
  | 'controlPlane.host'
  | 'controlPlane.port'
  | 'controlPlane.publicBaseUrl' | 'conversationGate.mode' | 'conversationGate.proposalTtlMs' | 'conversationGate.maxPendingProposals'
  | 'hostedSessions.detachPolicy' | 'hostedSessions.maxSessions' | 'hostedSessions.maxMessagesPerSession' | 'hostedSessions.terminatedRetentionMs'
  | 'hostedSessions.attachmentTtlMs'
  | 'hostedSessions.promoteInboundConversations'
  | 'controlPlane.streamMode'
  | 'controlPlane.allowRemote'
  | 'controlPlane.trustProxy'
  | 'controlPlane.openaiCompatible.enabled'
  | 'controlPlane.openaiCompatible.pathPrefix'
  | 'controlPlane.webui.serve'
  | 'controlPlane.webui.bundleDir'
  | 'controlPlane.cors.enabled'
  | 'controlPlane.cors.allowedOrigins'
  | 'controlPlane.tls.mode'
  | 'controlPlane.tls.certFile'
  | 'controlPlane.tls.keyFile'
  | 'httpListener.hostMode'
  | 'httpListener.host'
  | 'httpListener.port'
  | 'httpListener.trustProxy'
  | 'httpListener.tls.mode'
  | 'httpListener.tls.certFile'
  | 'httpListener.tls.keyFile'
  | 'web.enabled'
  | 'web.hostMode'
  | 'web.host'
  | 'web.port'
  | 'web.publicBaseUrl'
  | 'web.staticAssetsDir'
  | 'surfaces.slack.enabled'
  | 'surfaces.slack.signingSecret'
  | 'surfaces.slack.botToken'
  | 'surfaces.slack.appToken'
  | 'surfaces.slack.defaultChannel'
  | 'surfaces.slack.workspaceId'
  | 'surfaces.discord.enabled'
  | 'surfaces.discord.publicKey'
  | 'surfaces.discord.botToken'
  | 'surfaces.discord.applicationId'
  | 'surfaces.discord.defaultChannelId'
  | 'surfaces.discord.guildId'
  | 'surfaces.ntfy.enabled'
  | 'surfaces.ntfy.baseUrl'
  | 'surfaces.ntfy.topic'
  | 'surfaces.ntfy.chatTopic'
  | 'surfaces.ntfy.agentTopic'
  | 'surfaces.ntfy.remoteTopic'
  | 'surfaces.ntfy.token'
  | 'surfaces.ntfy.defaultPriority'
  | 'surfaces.webhook.enabled'
  | 'surfaces.webhook.defaultTarget'
  | 'surfaces.webhook.timeoutMs'
  | 'surfaces.webhook.secret'
  | 'surfaces.homeassistant.enabled'
  | 'surfaces.homeassistant.instanceUrl'
  | 'surfaces.homeassistant.accessToken'
  | 'surfaces.homeassistant.webhookSecret'
  | 'surfaces.homeassistant.defaultConversationId'
  | 'surfaces.homeassistant.deviceId'
  | 'surfaces.homeassistant.deviceName'
  | 'surfaces.homeassistant.eventType'
  | 'surfaces.homeassistant.remoteSessionTtlMs'
  | 'surfaces.telegram.enabled'
  | 'surfaces.telegram.botToken'
  | 'surfaces.telegram.webhookSecret'
  | 'surfaces.telegram.defaultChatId'
  | 'surfaces.telegram.botUsername'
  | 'surfaces.telegram.discoveredBotTokenId'
  | 'surfaces.telegram.mode'
  | 'surfaces.googleChat.enabled'
  | 'surfaces.googleChat.webhookUrl'
  | 'surfaces.googleChat.verificationToken'
  | 'surfaces.googleChat.appId'
  | 'surfaces.googleChat.spaceId'
  | 'surfaces.signal.enabled'
  | 'surfaces.signal.bridgeUrl'
  | 'surfaces.signal.account'
  | 'surfaces.signal.token'
  | 'surfaces.signal.defaultRecipient'
  | 'surfaces.whatsapp.enabled'
  | 'surfaces.whatsapp.provider'
  | 'surfaces.whatsapp.accessToken'
  | 'surfaces.whatsapp.verifyToken'
  | 'surfaces.whatsapp.signingSecret'
  | 'surfaces.whatsapp.phoneNumberId'
  | 'surfaces.whatsapp.businessAccountId'
  | 'surfaces.whatsapp.defaultRecipient'
  | 'surfaces.telephony.enabled'
  | 'surfaces.telephony.provider'
  | 'surfaces.telephony.mode'
  | 'surfaces.telephony.bridgeUrl'
  | 'surfaces.telephony.token'
  | 'surfaces.telephony.accountSid'
  | 'surfaces.telephony.authToken'
  | 'surfaces.telephony.fromNumber'
  | 'surfaces.telephony.defaultRecipient'
  | 'surfaces.telephony.webhookSecret'
  | 'surfaces.telephony.voiceLanguage'
  | 'surfaces.imessage.enabled'
  | 'surfaces.imessage.bridgeUrl'
  | 'surfaces.imessage.account'
  | 'surfaces.imessage.token'
  | 'surfaces.imessage.defaultChatId'
  | 'surfaces.msteams.enabled'
  | 'surfaces.msteams.appId'
  | 'surfaces.msteams.appPassword'
  | 'surfaces.msteams.tenantId'
  | 'surfaces.msteams.serviceUrl'
  | 'surfaces.msteams.botId'
  | 'surfaces.msteams.defaultConversationId'
  | 'surfaces.msteams.defaultChannelId'
  | 'surfaces.bluebubbles.enabled'
  | 'surfaces.bluebubbles.serverUrl'
  | 'surfaces.bluebubbles.password'
  | 'surfaces.bluebubbles.account'
  | 'surfaces.bluebubbles.defaultChatGuid'
  | 'surfaces.mattermost.enabled'
  | 'surfaces.mattermost.baseUrl'
  | 'surfaces.mattermost.botToken'
  | 'surfaces.mattermost.teamId'
  | 'surfaces.mattermost.defaultChannelId'
  | 'surfaces.matrix.enabled'
  | 'surfaces.matrix.homeserverUrl'
  | 'surfaces.matrix.accessToken'
  | 'surfaces.matrix.userId'
  | 'surfaces.matrix.defaultRoomId'
  // The daemon's own mailbox and calendar (schema-domain-daemon-mailbox.ts).
  | 'surfaces.email.host'
  | 'surfaces.email.user'
  | 'surfaces.email.username'
  | 'surfaces.email.from'
  | 'surfaces.email.password'
  | 'surfaces.email.imapHost'
  | 'surfaces.email.imapPort'
  | 'surfaces.email.imapUser'
  | 'surfaces.email.imapPassword'
  | 'surfaces.email.imap.host'
  | 'surfaces.email.imap.port'
  | 'surfaces.email.imap.user'
  | 'surfaces.email.imap.password'
  | 'surfaces.email.imap.secure'
  | 'surfaces.email.imap.mailbox'
  | 'surfaces.email.imap.draftsMailbox'
  | 'surfaces.email.smtp.host'
  | 'surfaces.email.smtp.port'
  | 'surfaces.email.smtp.password'
  | 'surfaces.email.smtp.secure'
  // The inbound-mail watcher (schema-domain-daemon-mailbox.ts, docs/inbound-email.md §8)
  | 'surfaces.email.inbound.enabled'
  | 'surfaces.email.inbound.accounts'
  | 'surfaces.email.inbound.source'
  | 'surfaces.email.inbound.gmailPollSecondsExpecting'
  | 'surfaces.email.inbound.gmailPollSecondsIdle'
  | 'surfaces.email.inbound.mode'
  | 'surfaces.email.inbound.pollIntervalSeconds'
  | 'surfaces.email.inbound.idleReissueMinutes'
  | 'surfaces.email.inbound.reconnect.maxBackoffSeconds'
  | 'surfaces.email.inbound.notice.route'
  | 'surfaces.email.inbound.notice.mode'
  | 'surfaces.email.inbound.expectationWindowMinutes'
  | 'surfaces.email.inbound.dedupTtlMinutes'
  | 'surfaces.email.inbound.retentionDays'
  | 'surfaces.email.inbound.maxRecords'
  | 'surfaces.email.inbound.capabilityRecheckMinutes'
  | 'surfaces.email.inbound.onInsufficientCapability'
  | 'surfaces.calendar.caldavUrl'
  | 'surfaces.calendar.caldavUser'
  | 'surfaces.calendar.caldavPassword'
  | 'surfaces.calendar.defaultCalendarId'
  | 'surfaces.calendar.calendars'
  | 'watchers.enabled'
  | 'watchers.pollIntervalMs'
  | 'watchers.heartbeatIntervalMs'
  | 'watchers.recoveryWindowMinutes'
  | 'watchers.ciPollIntervalMs'
  // Trigger family — shapes and descriptions live in schema-domain-triggers.ts
  | 'watchers.triggers.enabled'
  | 'watchers.triggers.backoffLadderMs'
  | 'watchers.triggers.breakerStrikes'
  | 'watchers.triggers.defaultCheckIntervalMs'
  | 'watchers.triggers.probeTimeoutMs'
  | 'watchers.triggers.maxConcurrentChecks'
  | 'watchers.triggers.observationRingSize'
  | 'watchers.triggers.runHistoryLimit'
  | 'watchers.triggers.runHistoryTtlHours'
  | 'watchers.triggers.eventLogLimit'
  | 'watchers.triggers.eventLogTtlHours'
  | 'watchers.triggers.sweepIntervalMs'
  | 'watchers.triggers.supervisionTickMs'
  | 'watchers.triggers.streamQueueLimit'
  | 'watchers.triggers.streamBatchLines'
  | 'watchers.triggers.streamBatchIntervalMs'
  | 'watchers.triggers.onExitMaxDurationMs'
  | 'watchers.triggers.onExitStdin'
  | 'watchers.triggers.outputTailBytes'
  | 'service.enabled'
  | 'service.autostart'
  | 'service.restartOnFailure'
  | 'service.platform'
  | 'service.serviceName'
  | 'service.logPath'
  | 'update.auto'
  | 'update.intervalMinutes'
  | 'update.firstCheckSeconds'
  | 'update.releasesUrl'
  | 'update.rollbackAfterFailedStarts'
  | 'update.alertAfterFailedChecks'
  | 'network.outboundTls.mode'
  | 'network.outboundTls.customCaFile'
  | 'network.outboundTls.customCaDir'
  | 'network.outboundTls.allowInsecureLocalhost'
  | 'network.remoteFetch.allowPrivateHosts'
  | 'relay.enabled'
  | 'relay.url'
  | 'relay.rendezvousId'
  | 'relay.label'
  | 'relay.requireStepUpForMutations'
  | 'runtime.companionChatLimiter.perSessionLimit'
  | 'runtime.eventBus.maxListeners'
  | 'runtime.unifiedTasks'
  | 'runtime.pluginLifecycle'
  | 'runtime.mcpLifecycle'
  | 'runtime.toolBudget.enforced'
  | 'runtime.toolBudget.maxMs'
  | 'runtime.toolBudget.maxTokens'
  | 'runtime.toolBudget.maxCostUsd'
  | 'telemetry.includeRawPrompts'
  | 'telemetry.decisionOtlpEnabled'
  | 'telemetry.decisionOtlpEndpoint'
  | 'telemetry.decisionOtlpSignal'
  | 'telemetry.otelMode'
  | 'atRest.redactionEnabled'
  | 'atRest.retentionMaxAgeDays'
  | 'atRest.retentionMaxTotalMb'
  | 'batch.mode'
  | 'batch.fallback'
  | 'batch.queueBackend'
  | 'batch.tickIntervalMs'
  | 'batch.maxDelayMs'
  | 'batch.maxJobsPerProviderBatch'
  | 'batch.maxQueuePayloadBytes'
  | 'batch.maxQueueMessagesPerDay'
  | 'cloudflare.enabled'
  | 'cloudflare.freeTierMode'
  | 'cloudflare.accountId'
  | 'cloudflare.apiTokenRef'
  | 'cloudflare.zoneId'
  | 'cloudflare.zoneName'
  | 'cloudflare.workerName'
  | 'cloudflare.workerSubdomain'
  | 'cloudflare.workerHostname'
  | 'cloudflare.workerBaseUrl'
  | 'cloudflare.daemonBaseUrl'
  | 'cloudflare.daemonHostname'
  | 'cloudflare.workerTokenRef'
  | 'cloudflare.workerClientTokenRef'
  | 'cloudflare.workerCron'
  | 'cloudflare.queueName'
  | 'cloudflare.deadLetterQueueName'
  | 'cloudflare.tunnelName'
  | 'cloudflare.tunnelId'
  | 'cloudflare.tunnelTokenRef'
  | 'cloudflare.accessAppId'
  | 'cloudflare.accessServiceTokenId'
  | 'cloudflare.accessServiceTokenRef'
  | 'cloudflare.kvNamespaceName'
  | 'cloudflare.kvNamespaceId'
  | 'cloudflare.durableObjectNamespaceName'
  | 'cloudflare.durableObjectNamespaceId'
  | 'cloudflare.r2BucketName'
  | 'cloudflare.secretsStoreName'
  | 'cloudflare.secretsStoreId'
  | 'cloudflare.maxQueueOpsPerDay'
  | 'notifications.adaptiveSuppression'
  | 'notifications.burstWindowMs'
  | 'notifications.burstThreshold'
  | 'notifications.burstCooldownMs'
  | 'notifications.pushApproval'
  | 'notifications.pushNeedsInput'
  | 'notifications.pushCompletion'
  | 'notifications.blockedEscalationGraceMs'
  | 'notifications.blockedEscalationFollowUpMs'
  | 'notifications.blockedEscalationMaxFollowUps'
  | 'fetch.sanitizeMode'
  | 'fetch.trustedHosts'
  | 'fetch.blockedHosts'
  | 'fetch.allowLocalhost'
  | 'security.tokenAudit.enabled'
  | 'security.tokenAudit.rotationCadenceDays'
  | 'security.tokenAudit.rotationWarningDays'
  | 'security.tokenAudit.managed'
  | 'integrations.routeBinding'
  | 'integrations.deliveryTracking'
  | 'integrations.delivery.maxRetries'
  | 'integrations.delivery.initialDelayMs'
  | 'integrations.delivery.maxDelayMs'
  | 'integrations.delivery.maxDlqSize'
  | 'integrations.delivery.sloEnforced'
  | 'policy.registryEnabled'
  | 'policy.requireSignedBundles'
  | 'policy.bundleSource'
  | 'policy.bundlePath'
  | 'agents.passiveInjection.knowledge'
  | 'agents.passiveInjection.code'
  | 'agents.passiveInjection.budgetTokens'
  | 'agents.passiveInjection.relevanceFloor'
  | 'agents.passiveInjection.codeLimit'
  | 'agents.contextWindowGuard'
  | 'agents.contextCompactThreshold'
  | 'agents.maxTurns'
  | 'agents.maxTurnsCap'
  | 'pricing.modelPrices'
  // Proactive check-in (schema-domain-runtime.ts).
  | 'checkin.enabled'
  | 'checkin.cadence'
  | 'checkin.deliveryChannel'
  | 'checkin.quietHours'
  // Memory consolidation (schema-domain-learning.ts).
  | 'learning.consolidation.enabled'
  | 'learning.consolidation.intervalMs'
  | 'learning.consolidation.minIdleMs'
  | 'learning.consolidation.maxMergesPerRun'
  | 'learning.consolidation.maxDecaysPerRun'
  | 'learning.consolidation.maxProposalsPerRun'
  | 'learning.consolidation.decayAgeDays'
  | 'learning.consolidation.decayConfidenceStep'
  | 'learning.consolidation.archiveConfidenceFloor'
  // Sleep ownership (schema-domain-power.ts).
  | 'power.keepAwake'
  | 'power.inhibitWhileWorking'
  | 'power.workInhibitMaxMinutes'
  // MemoryGovernor (schema-domain-memory.ts).
  | 'memory.budgetMb'
  | 'memory.tier.elevatedPct'
  | 'memory.tier.highPct'
  | 'memory.tier.criticalPct'
  | 'memory.tripwire.rateMbPerSec'
  | 'memory.tripwire.sustainSec'
  | 'memory.hardLimitPct'
  // Local voice engines (schema-domain-voice-local.ts).
  | 'voice.local.sttEngine'
  | 'voice.local.sttBinary'
  | 'voice.local.sttModelPath'
  | 'voice.local.ttsEngine'
  | 'voice.local.ttsBinary'
  | 'voice.local.ttsModelPath'
  // Wake-word detection. Interface, defaults and row metadata live in
  // schema-domain-voice-wake.ts, so only the union entries land here.
  | 'voice.wake.enabled'
  | 'voice.wake.models'
  | 'voice.wake.threshold'
  | 'voice.wake.patienceFrames'
  | 'voice.wake.cooldownMs'
  | 'voice.wake.vadThreshold'
  | 'voice.wake.noiseSuppression'
  | 'voice.wake.inputDevice'
  | 'voice.wake.captureCommand'
  | 'voice.wake.surfaces.tui'
  | 'voice.wake.surfaces.agent'
  | 'voice.wake.surfaces.webui'
  | 'voice.wake.activationSound'
  | 'voice.wake.activationSoundPath'
  | 'voice.wake.indicator'
  | 'voice.wake.preRollMs'
  | 'voice.wake.captureMaxSeconds'
  | 'voice.wake.silenceStopMs'
  | 'voice.wake.autoSubmit'
  | 'voice.wake.retainAudio'
  | 'voice.wake.customModelDir'
  | 'voice.wake.maxRestarts'
  | 'voice.wake.restartBackoffMs'
  | 'voice.wake.crashWindowSeconds'
  | 'voice.wake.browserBackend'
  | 'device.capabilities.mode'
  | 'device.capabilities.allowAlwaysOffer'
  | 'device.capabilities.requestTimeoutSeconds'
  | 'device.location.precision'
  | 'device.clipboard.readMode'
  | 'device.capture.retentionHours'
  | 'device.capture.maxArtifacts'
  | 'device.capture.sweepIntervalMinutes'
  | 'device.grants.expiryDays'
  | 'device.grants.maxPerNode'
  | 'device.grants.auditRetentionDays'
  | 'device.nodes.maxPaired'
  // Browser-push subscription custody (schema-domain-push.ts).
  | 'push.vapidSubject'
  | 'push.subscriptions.warnAbovePerPrincipal'
  | 'push.subscriptions.failureThreshold'
  | 'push.subscriptions.sweepIntervalMinutes'
  // The one fleet ceiling (schema-domain-fleet.ts).
  | 'fleet.maxSize'
  // Which node on this network consumes inbound channels (schema-domain-cluster.ts).
  // The peers list is an array and therefore not a scalar ConfigKey, so it is
  // read through the cluster category, like conversationGate.gatedSurfaces.
  | 'cluster.enabled'
  | 'cluster.heartbeatSeconds'
  | 'cluster.masterTimeoutSeconds'
  | 'cluster.bootProbeSeconds'
  | 'cluster.port'
  | 'cluster.multicastGroup'
  | 'cluster.secret'
  | 'cluster.keyRotationHours'
  | 'cluster.keyRotationGraceMinutes'
  | 'cluster.beaconSeconds'
  | 'cluster.rosterGossipSeconds'
  // The owner profile's policy (schema-types-owner-profile.ts / schema-domain-owner-profile.ts).
  | ProfileConfigKey
  // Proactive occasions and plans (schema-types-occasions.ts / schema-domain-occasions.ts).
  | OccasionsConfigKey;

export * from "./schema-types-values.js";
