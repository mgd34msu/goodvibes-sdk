/**
 * Shared config schema types for goodvibes-sdk.
 */

export * from "./schema-types-permissions.js";
import type { BackgroundAgentsMode, LineNumberMode, PermissionAction, PermissionMode, PermissionsToolConfig } from "./schema-types-permissions.js";

export * from "./schema-types-surfaces.js";
import type { InboundEmailCapabilityPolicy, InboundEmailMode, InboundEmailNoticeMode, SurfacesConfig } from "./schema-types-surfaces.js";

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

export * from "./schema-types-daemon.js";
import type {
  AutomationConfig,
  NotificationsConfig,
  RuntimeConfig,
  ServiceConfig,
  TtsConfig,
  WatchersConfig,
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
  daemon: { enabled: boolean; embedInProcess: boolean };     // default: enabled true — run the local session daemon (loopback only); embedInProcess false — daemon runs as a detached process, not inside this surface
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
  | 'daemon.enabled'
  | 'daemon.embedInProcess'
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
  | 'cluster.rosterGossipSeconds';

/** Maps a ConfigKey to its value type. */
export type ConfigValue<K extends ConfigKey> =
  K extends 'display.stream' ? boolean :
  K extends 'display.lineNumbers' ? LineNumberMode :
  K extends 'display.collapseThreshold' ? number :
  K extends 'display.theme' ? string :
  K extends 'display.showThinking' ? boolean :
  K extends 'display.showReasoningSummary' ? boolean :
  K extends 'display.showTokenSpeed' ? boolean :
  K extends 'display.showToolPreview' ? boolean :
  K extends 'provider.reasoningEffort' ? string :
  K extends 'provider.model' ? string :
  K extends 'provider.embeddingProvider' ? string :
  K extends 'provider.systemPromptFile' ? string :
  K extends 'provider.optimizerMode' ? 'off' | 'manual' | 'auto' | 'pinned' :
  K extends 'provider.optimizerPinnedModel' ? string :
  K extends 'provider.localContextIngestion' ? boolean :
  K extends 'behavior.autoApprove' ? boolean :
  K extends 'behavior.autoCompactThreshold' ? number :
  K extends 'behavior.compactionStrategy' ? 'off' | 'structured' | 'distiller' :
  K extends 'behavior.staleContextWarnings' ? boolean :
  K extends 'behavior.saveHistory' ? boolean :
  K extends 'behavior.notifyOnComplete' ? boolean :
  K extends 'behavior.suggestAlternativeOnProviderFail' ? boolean :
  K extends 'behavior.hitlMode' ? 'off' | 'quiet' | 'balanced' | 'operator' :
  K extends 'behavior.toolResultReconciliation' ? 'reconcile' | 'warn-only' :
  K extends 'behavior.returnContextMode' ? 'off' | 'local' | 'assisted' :
  K extends 'behavior.guidanceMode' ? 'off' | 'minimal' | 'guided' :
  K extends 'storage.secretPolicy' ? 'plaintext_allowed' | 'preferred_secure' | 'require_secure' :
  K extends 'storage.artifacts.maxBytes' ? number :
  K extends 'permissions.mode' ? PermissionMode :
  K extends 'permissions.backgroundAgents' ? BackgroundAgentsMode :
  K extends 'permissions.engine' ? 'baseline' | 'policy-engine' :
  K extends 'permissions.simulation' ? boolean :
  K extends 'permissions.divergenceDashboard' ? boolean :
  K extends 'permissions.commandParser' ? 'ast' | 'flat' :
  K extends 'permissions.divergenceThreshold' ? number :
  K extends 'permissions.maxDivergenceRecords' ? number :
  K extends 'permissions.tools.read' ? PermissionAction :
  K extends 'permissions.tools.write' ? PermissionAction :
  K extends 'permissions.tools.edit' ? PermissionAction :
  K extends 'permissions.tools.exec' ? PermissionAction :
  K extends 'permissions.tools.find' ? PermissionAction :
  K extends 'permissions.tools.fetch' ? PermissionAction :
  K extends 'permissions.tools.analyze' ? PermissionAction :
  K extends 'permissions.tools.inspect' ? PermissionAction :
  K extends 'permissions.tools.agent' ? PermissionAction :
  K extends 'permissions.tools.state' ? PermissionAction :
  K extends 'permissions.tools.workflow' ? PermissionAction :
  K extends 'permissions.tools.registry' ? PermissionAction :
  K extends 'permissions.tools.delegate' ? PermissionAction :
  K extends 'permissions.tools.mcp' ? PermissionAction :
  K extends 'diagnostics.postEdit' ? 'on' | 'off' :
  K extends 'orchestration.recursionEnabled' ? boolean :
  K extends 'orchestration.maxDepth' ? number :
  K extends 'planner.decomposition' ? 'agent' | 'heuristic' :
  K extends 'planner.maxTurns' ? number :
  K extends 'planner.tokenCeiling' ? number :
  K extends 'planner.wallTimeoutMs' ? number :
  K extends 'planner.adaptive' ? boolean :
  K extends 'sandbox.enabled' ? boolean :
  K extends 'sandbox.judgment' ? 'off' | 'annotate' | 'auto-approve' :
  K extends 'sandbox.replIsolation' ? 'shared-vm' | 'per-runtime-vm' :
  K extends 'sandbox.mcpIsolation' ? 'disabled' | 'shared-vm' | 'hybrid' | 'per-server-vm' :
  K extends 'sandbox.windowsMode' ? 'native-basic' | 'require-wsl' :
  K extends 'sandbox.vmBackend' ? 'local' | 'qemu' :
  K extends 'sandbox.qemuBinary' ? string :
  K extends 'sandbox.qemuImagePath' ? string :
  K extends 'sandbox.qemuExecWrapper' ? string :
  K extends 'sandbox.qemuGuestHost' ? string :
  K extends 'sandbox.qemuGuestPort' ? number :
  K extends 'sandbox.qemuGuestUser' ? string :
  K extends 'sandbox.qemuWorkspacePath' ? string :
  K extends 'sandbox.qemuSessionMode' ? 'attach' | 'launch-per-command' :
  K extends 'sandbox.replJavaScriptCommand' ? string :
  K extends 'ui.voiceEnabled' ? boolean :
  K extends 'ui.systemMessages' ? 'panel' | 'conversation' | 'both' :
  K extends 'ui.operationalMessages' ? 'panel' | 'conversation' | 'both' :
  K extends 'ui.wrfcMessages' ? 'panel' | 'conversation' | 'both' :
  K extends 'tts.provider' ? string :
  K extends 'tts.voice' ? string :
  K extends 'tts.llmProvider' ? string :
  K extends 'tts.llmModel' ? string :
  K extends 'tts.speed' ? number :
  K extends 'release.channel' ? 'stable' | 'preview' :
  K extends 'daemon.enabled' ? boolean :
  K extends 'daemon.embedInProcess' ? boolean :
  K extends 'danger.httpListener' ? boolean :
  K extends 'tools.llmEnabled' ? boolean :
  K extends 'tools.llmProvider' ? string :
  K extends 'tools.llmModel' ? string :
  K extends 'tools.autoHeal' ? boolean :
  K extends 'tools.defaultTokenBudget' ? number :
  K extends 'tools.hooksFile' ? string :
  K extends 'tools.overflowSpillBackend' ? 'file' | 'ledger' | 'diagnostics' :
  K extends 'tools.contractVerification' ? boolean :
  K extends 'tools.outputSchemaFingerprints' ? boolean :
  K extends 'wrfc.scoreThreshold' ? number :
  K extends 'wrfc.maxFixAttempts' ? number :
  K extends 'wrfc.autoCommit' ? boolean :
  K extends 'wrfc.commitScope' ? 'off' | 'scoped' | 'all' :
  K extends 'wrfc.agentHeartbeatTimeoutMs' ? number :
  K extends 'wrfc.transportRetryLimit' ? number :
  K extends 'wrfc.transportRetryDelayMs' ? number :
  K extends 'cache.enabled' ? boolean :
  K extends 'cache.stableTtl' ? '5m' | '1h' :
  K extends 'cache.monitorHitRate' ? boolean :
  K extends 'cache.hitRateWarningThreshold' ? number :
  K extends 'helper.enabled' ? boolean :
  K extends 'helper.globalProvider' ? string :
  K extends 'helper.globalModel' ? string :
  K extends 'automation.enabled' ? boolean :
  K extends 'automation.maxConcurrentRuns' ? number :
  K extends 'automation.runHistoryLimit' ? number :
  K extends 'automation.defaultTimeoutMs' ? number :
  K extends 'automation.catchUpWindowMinutes' ? number :
  K extends 'automation.failureCooldownMs' ? number :
  K extends 'automation.deleteAfterRun' ? boolean :
  K extends 'controlPlane.enabled' ? boolean :
  K extends 'controlPlane.gateway' ? boolean :
  K extends 'controlPlane.hostMode' ? 'local' | 'network' | 'custom' :
  K extends 'controlPlane.host' ? string :
  K extends 'controlPlane.port' ? number :
  K extends 'controlPlane.publicBaseUrl' ? string : K extends 'conversationGate.mode' ? 'propose' | 'confirm-all' | 'off' : K extends 'conversationGate.proposalTtlMs' ? number : K extends 'conversationGate.maxPendingProposals' ? number :
  K extends 'controlPlane.streamMode' ? 'sse' | 'websocket' | 'both' :
  K extends 'controlPlane.allowRemote' ? boolean :
  K extends 'controlPlane.trustProxy' ? boolean :
  K extends 'controlPlane.openaiCompatible.enabled' ? boolean :
  K extends 'controlPlane.openaiCompatible.pathPrefix' ? string :
  K extends 'controlPlane.webui.serve' ? boolean :
  K extends 'controlPlane.webui.bundleDir' ? string :
  K extends 'controlPlane.cors.enabled' ? boolean :
  K extends 'controlPlane.cors.allowedOrigins' ? string :
  K extends 'controlPlane.tls.mode' ? 'off' | 'proxy' | 'direct' :
  K extends 'controlPlane.tls.certFile' ? string :
  K extends 'controlPlane.tls.keyFile' ? string :
  K extends 'httpListener.hostMode' ? 'local' | 'network' | 'custom' :
  K extends 'httpListener.host' ? string :
  K extends 'httpListener.port' ? number :
  K extends 'httpListener.trustProxy' ? boolean :
  K extends 'httpListener.tls.mode' ? 'off' | 'proxy' | 'direct' :
  K extends 'httpListener.tls.certFile' ? string :
  K extends 'httpListener.tls.keyFile' ? string :
  K extends 'web.enabled' ? boolean :
  K extends 'web.hostMode' ? 'local' | 'network' | 'custom' :
  K extends 'web.host' ? string :
  K extends 'web.port' ? number :
  K extends 'web.publicBaseUrl' ? string :
  K extends 'web.staticAssetsDir' ? string :
  K extends 'surfaces.slack.enabled' ? boolean :
  K extends 'surfaces.slack.signingSecret' ? string :
  K extends 'surfaces.slack.botToken' ? string :
  K extends 'surfaces.slack.appToken' ? string :
  K extends 'surfaces.slack.defaultChannel' ? string :
  K extends 'surfaces.slack.workspaceId' ? string :
  K extends 'surfaces.discord.enabled' ? boolean :
  K extends 'surfaces.discord.publicKey' ? string :
  K extends 'surfaces.discord.botToken' ? string :
  K extends 'surfaces.discord.applicationId' ? string :
  K extends 'surfaces.discord.defaultChannelId' ? string :
  K extends 'surfaces.discord.guildId' ? string :
  K extends 'surfaces.ntfy.enabled' ? boolean :
  K extends 'surfaces.ntfy.baseUrl' ? string :
  K extends 'surfaces.ntfy.topic' ? string :
  K extends 'surfaces.ntfy.chatTopic' ? string :
  K extends 'surfaces.ntfy.agentTopic' ? string :
  K extends 'surfaces.ntfy.remoteTopic' ? string :
  K extends 'surfaces.ntfy.token' ? string :
  K extends 'surfaces.ntfy.defaultPriority' ? number :
  K extends 'surfaces.webhook.enabled' ? boolean :
  K extends 'surfaces.webhook.defaultTarget' ? string :
  K extends 'surfaces.webhook.timeoutMs' ? number :
  K extends 'surfaces.webhook.secret' ? string :
  K extends 'surfaces.homeassistant.enabled' ? boolean :
  K extends 'surfaces.homeassistant.instanceUrl' ? string :
  K extends 'surfaces.homeassistant.accessToken' ? string :
  K extends 'surfaces.homeassistant.webhookSecret' ? string :
  K extends 'surfaces.homeassistant.defaultConversationId' ? string :
  K extends 'surfaces.homeassistant.deviceId' ? string :
  K extends 'surfaces.homeassistant.deviceName' ? string :
  K extends 'surfaces.homeassistant.eventType' ? string :
  K extends 'surfaces.homeassistant.remoteSessionTtlMs' ? number :
  K extends 'surfaces.telegram.enabled' ? boolean :
  K extends 'surfaces.telegram.botToken' ? string :
  K extends 'surfaces.telegram.webhookSecret' ? string :
  K extends 'surfaces.telegram.defaultChatId' ? string :
  K extends 'surfaces.telegram.botUsername' ? string :
  K extends 'surfaces.telegram.discoveredBotTokenId' ? string :
  K extends 'surfaces.telegram.mode' ? 'webhook' | 'polling' :
  K extends 'surfaces.googleChat.enabled' ? boolean :
  K extends 'surfaces.googleChat.webhookUrl' ? string :
  K extends 'surfaces.googleChat.verificationToken' ? string :
  K extends 'surfaces.googleChat.appId' ? string :
  K extends 'surfaces.googleChat.spaceId' ? string :
  K extends 'surfaces.signal.enabled' ? boolean :
  K extends 'surfaces.signal.bridgeUrl' ? string :
  K extends 'surfaces.signal.account' ? string :
  K extends 'surfaces.signal.token' ? string :
  K extends 'surfaces.signal.defaultRecipient' ? string :
  K extends 'surfaces.whatsapp.enabled' ? boolean :
  K extends 'surfaces.whatsapp.provider' ? 'meta-cloud' | 'bridge' :
  K extends 'surfaces.whatsapp.accessToken' ? string :
  K extends 'surfaces.whatsapp.verifyToken' ? string :
  K extends 'surfaces.whatsapp.signingSecret' ? string :
  K extends 'surfaces.whatsapp.phoneNumberId' ? string :
  K extends 'surfaces.whatsapp.businessAccountId' ? string :
  K extends 'surfaces.whatsapp.defaultRecipient' ? string :
  K extends 'surfaces.telephony.enabled' ? boolean :
  K extends 'surfaces.telephony.provider' ? 'twilio' | 'bridge' :
  K extends 'surfaces.telephony.mode' ? 'sms' | 'voice' | 'bridge' :
  K extends 'surfaces.telephony.bridgeUrl' ? string :
  K extends 'surfaces.telephony.token' ? string :
  K extends 'surfaces.telephony.accountSid' ? string :
  K extends 'surfaces.telephony.authToken' ? string :
  K extends 'surfaces.telephony.fromNumber' ? string :
  K extends 'surfaces.telephony.defaultRecipient' ? string :
  K extends 'surfaces.telephony.webhookSecret' ? string :
  K extends 'surfaces.telephony.voiceLanguage' ? string :
  K extends 'surfaces.imessage.enabled' ? boolean :
  K extends 'surfaces.imessage.bridgeUrl' ? string :
  K extends 'surfaces.imessage.account' ? string :
  K extends 'surfaces.imessage.token' ? string :
  K extends 'surfaces.imessage.defaultChatId' ? string :
  K extends 'surfaces.msteams.enabled' ? boolean :
  K extends 'surfaces.msteams.appId' ? string :
  K extends 'surfaces.msteams.appPassword' ? string :
  K extends 'surfaces.msteams.tenantId' ? string :
  K extends 'surfaces.msteams.serviceUrl' ? string :
  K extends 'surfaces.msteams.botId' ? string :
  K extends 'surfaces.msteams.defaultConversationId' ? string :
  K extends 'surfaces.msteams.defaultChannelId' ? string :
  K extends 'surfaces.bluebubbles.enabled' ? boolean :
  K extends 'surfaces.bluebubbles.serverUrl' ? string :
  K extends 'surfaces.bluebubbles.password' ? string :
  K extends 'surfaces.bluebubbles.account' ? string :
  K extends 'surfaces.bluebubbles.defaultChatGuid' ? string :
  K extends 'surfaces.mattermost.enabled' ? boolean :
  K extends 'surfaces.mattermost.baseUrl' ? string :
  K extends 'surfaces.mattermost.botToken' ? string :
  K extends 'surfaces.mattermost.teamId' ? string :
  K extends 'surfaces.mattermost.defaultChannelId' ? string :
  K extends 'surfaces.matrix.enabled' ? boolean :
  K extends 'surfaces.matrix.homeserverUrl' ? string :
  K extends 'surfaces.matrix.accessToken' ? string :
  K extends 'surfaces.matrix.userId' ? string :
  K extends 'surfaces.matrix.defaultRoomId' ? string :
  K extends 'surfaces.email.host' ? string :
  K extends 'surfaces.email.user' ? string :
  K extends 'surfaces.email.username' ? string :
  K extends 'surfaces.email.from' ? string :
  K extends 'surfaces.email.password' ? string :
  K extends 'surfaces.email.imapHost' ? string :
  K extends 'surfaces.email.imapPort' ? number :
  K extends 'surfaces.email.imapUser' ? string :
  K extends 'surfaces.email.imapPassword' ? string :
  K extends 'surfaces.email.imap.host' ? string :
  K extends 'surfaces.email.imap.port' ? number :
  K extends 'surfaces.email.imap.user' ? string :
  K extends 'surfaces.email.imap.password' ? string :
  K extends 'surfaces.email.imap.secure' ? boolean :
  K extends 'surfaces.email.imap.mailbox' ? string :
  K extends 'surfaces.email.imap.draftsMailbox' ? string :
  K extends 'surfaces.email.smtp.host' ? string :
  K extends 'surfaces.email.smtp.port' ? number :
  K extends 'surfaces.email.smtp.password' ? string :
  K extends 'surfaces.email.smtp.secure' ? boolean :
  K extends 'surfaces.email.inbound.enabled' ? boolean :
  K extends 'surfaces.email.inbound.accounts' ? string :
  K extends 'surfaces.email.inbound.mode' ? InboundEmailMode :
  K extends 'surfaces.email.inbound.pollIntervalSeconds' ? number :
  K extends 'surfaces.email.inbound.idleReissueMinutes' ? number :
  K extends 'surfaces.email.inbound.reconnect.maxBackoffSeconds' ? number :
  K extends 'surfaces.email.inbound.notice.route' ? string :
  K extends 'surfaces.email.inbound.notice.mode' ? InboundEmailNoticeMode :
  K extends 'surfaces.email.inbound.expectationWindowMinutes' ? number :
  K extends 'surfaces.email.inbound.dedupTtlMinutes' ? number :
  K extends 'surfaces.email.inbound.retentionDays' ? number :
  K extends 'surfaces.email.inbound.maxRecords' ? number :
  K extends 'surfaces.email.inbound.capabilityRecheckMinutes' ? number :
  K extends 'surfaces.email.inbound.onInsufficientCapability' ? InboundEmailCapabilityPolicy :
  K extends 'surfaces.calendar.caldavUrl' ? string :
  K extends 'surfaces.calendar.caldavUser' ? string :
  K extends 'surfaces.calendar.caldavPassword' ? string :
  K extends 'surfaces.calendar.defaultCalendarId' ? string :
  K extends 'surfaces.calendar.calendars' ? string :
  K extends 'watchers.enabled' ? boolean :
  K extends 'watchers.pollIntervalMs' ? number :
  K extends 'watchers.heartbeatIntervalMs' ? number :
  K extends 'watchers.recoveryWindowMinutes' ? number :
  K extends 'watchers.ciPollIntervalMs' ? number :
  K extends 'watchers.triggers.enabled' ? boolean :
  K extends 'watchers.triggers.backoffLadderMs' ? string :
  K extends 'watchers.triggers.breakerStrikes' ? number :
  K extends 'watchers.triggers.defaultCheckIntervalMs' ? number :
  K extends 'watchers.triggers.probeTimeoutMs' ? number :
  K extends 'watchers.triggers.maxConcurrentChecks' ? number :
  K extends 'watchers.triggers.observationRingSize' ? number :
  K extends 'watchers.triggers.runHistoryLimit' ? number :
  K extends 'watchers.triggers.runHistoryTtlHours' ? number :
  K extends 'watchers.triggers.eventLogLimit' ? number :
  K extends 'watchers.triggers.eventLogTtlHours' ? number :
  K extends 'watchers.triggers.sweepIntervalMs' ? number :
  K extends 'watchers.triggers.supervisionTickMs' ? number :
  K extends 'watchers.triggers.streamQueueLimit' ? number :
  K extends 'watchers.triggers.streamBatchLines' ? number :
  K extends 'watchers.triggers.streamBatchIntervalMs' ? number :
  K extends 'watchers.triggers.onExitMaxDurationMs' ? number :
  K extends 'watchers.triggers.onExitStdin' ? string :
  K extends 'watchers.triggers.outputTailBytes' ? number :
  K extends 'service.enabled' ? boolean :
  K extends 'service.autostart' ? boolean :
  K extends 'service.restartOnFailure' ? boolean :
  K extends 'service.platform' ? 'auto' | 'systemd' | 'launchd' | 'windows' | 'manual' :
  K extends 'service.serviceName' ? string :
  K extends 'service.logPath' ? string :
  K extends 'update.auto' ? boolean :
  K extends 'update.intervalMinutes' ? number :
  K extends 'update.firstCheckSeconds' ? number :
  K extends 'update.releasesUrl' ? string :
  K extends 'update.rollbackAfterFailedStarts' ? number :
  K extends 'network.outboundTls.mode' ? 'bundled' | 'bundled+custom' | 'custom' :
  K extends 'network.outboundTls.customCaFile' ? string :
  K extends 'network.outboundTls.customCaDir' ? string :
  K extends 'network.outboundTls.allowInsecureLocalhost' ? boolean :
  K extends 'network.remoteFetch.allowPrivateHosts' ? boolean :
  K extends 'relay.enabled' ? boolean :
  K extends 'relay.url' ? string :
  K extends 'relay.rendezvousId' ? string :
  K extends 'relay.label' ? string :
  K extends 'relay.requireStepUpForMutations' ? boolean :
  K extends 'runtime.companionChatLimiter.perSessionLimit' ? number :
  K extends 'runtime.eventBus.maxListeners' ? number :
  K extends 'runtime.unifiedTasks' ? boolean :
  K extends 'runtime.pluginLifecycle' ? boolean :
  K extends 'runtime.mcpLifecycle' ? boolean :
  K extends 'runtime.toolBudget.enforced' ? boolean :
  K extends 'runtime.toolBudget.maxMs' ? number :
  K extends 'runtime.toolBudget.maxTokens' ? number :
  K extends 'runtime.toolBudget.maxCostUsd' ? number :
  K extends 'telemetry.includeRawPrompts' ? boolean :
  K extends 'telemetry.decisionOtlpEnabled' ? boolean :
  K extends 'telemetry.decisionOtlpEndpoint' ? string :
  K extends 'telemetry.decisionOtlpSignal' ? 'span' | 'log' | 'both' :
  K extends 'telemetry.otelMode' ? 'off' | 'in-process' | 'remote-export' :
  K extends 'atRest.redactionEnabled' ? boolean :
  K extends 'atRest.retentionMaxAgeDays' ? number :
  K extends 'atRest.retentionMaxTotalMb' ? number :
  K extends 'batch.mode' ? BatchMode :
  K extends 'batch.fallback' ? BatchFallbackMode :
  K extends 'batch.queueBackend' ? BatchQueueBackend :
  K extends 'batch.tickIntervalMs' ? number :
  K extends 'batch.maxDelayMs' ? number :
  K extends 'batch.maxJobsPerProviderBatch' ? number :
  K extends 'batch.maxQueuePayloadBytes' ? number :
  K extends 'batch.maxQueueMessagesPerDay' ? number :
  K extends 'cloudflare.enabled' ? boolean :
  K extends 'cloudflare.freeTierMode' ? boolean :
  K extends 'cloudflare.accountId' ? string :
  K extends 'cloudflare.apiTokenRef' ? string :
  K extends 'cloudflare.zoneId' ? string :
  K extends 'cloudflare.zoneName' ? string :
  K extends 'cloudflare.workerName' ? string :
  K extends 'cloudflare.workerSubdomain' ? string :
  K extends 'cloudflare.workerHostname' ? string :
  K extends 'cloudflare.workerBaseUrl' ? string :
  K extends 'cloudflare.daemonBaseUrl' ? string :
  K extends 'cloudflare.daemonHostname' ? string :
  K extends 'cloudflare.workerTokenRef' ? string :
  K extends 'cloudflare.workerClientTokenRef' ? string :
  K extends 'cloudflare.workerCron' ? string :
  K extends 'cloudflare.queueName' ? string :
  K extends 'cloudflare.deadLetterQueueName' ? string :
  K extends 'cloudflare.tunnelName' ? string :
  K extends 'cloudflare.tunnelId' ? string :
  K extends 'cloudflare.tunnelTokenRef' ? string :
  K extends 'cloudflare.accessAppId' ? string :
  K extends 'cloudflare.accessServiceTokenId' ? string :
  K extends 'cloudflare.accessServiceTokenRef' ? string :
  K extends 'cloudflare.kvNamespaceName' ? string :
  K extends 'cloudflare.kvNamespaceId' ? string :
  K extends 'cloudflare.durableObjectNamespaceName' ? string :
  K extends 'cloudflare.durableObjectNamespaceId' ? string :
  K extends 'cloudflare.r2BucketName' ? string :
  K extends 'cloudflare.secretsStoreName' ? string :
  K extends 'cloudflare.secretsStoreId' ? string :
  K extends 'cloudflare.maxQueueOpsPerDay' ? number :
  K extends 'notifications.adaptiveSuppression' ? boolean :
  K extends 'notifications.burstWindowMs' ? number :
  K extends 'notifications.burstThreshold' ? number :
  K extends 'notifications.burstCooldownMs' ? number :
  K extends 'notifications.pushApproval' ? boolean :
  K extends 'notifications.pushNeedsInput' ? boolean :
  K extends 'notifications.pushCompletion' ? boolean :
  K extends 'notifications.blockedEscalationGraceMs' ? number :
  K extends 'notifications.blockedEscalationFollowUpMs' ? number :
  K extends 'notifications.blockedEscalationMaxFollowUps' ? number :
  K extends 'fetch.sanitizeMode' ? 'none' | 'safe-text' | 'strict' :
  K extends 'fetch.trustedHosts' ? string :
  K extends 'fetch.blockedHosts' ? string :
  K extends 'fetch.allowLocalhost' ? boolean :
  K extends 'security.tokenAudit.enabled' ? boolean :
  K extends 'security.tokenAudit.rotationCadenceDays' ? number :
  K extends 'security.tokenAudit.rotationWarningDays' ? number :
  K extends 'security.tokenAudit.managed' ? boolean :
  K extends 'integrations.routeBinding' ? boolean :
  K extends 'integrations.deliveryTracking' ? boolean :
  K extends 'integrations.delivery.maxRetries' ? number :
  K extends 'integrations.delivery.initialDelayMs' ? number :
  K extends 'integrations.delivery.maxDelayMs' ? number :
  K extends 'integrations.delivery.maxDlqSize' ? number :
  K extends 'integrations.delivery.sloEnforced' ? boolean :
  K extends 'policy.registryEnabled' ? boolean :
  K extends 'policy.requireSignedBundles' ? boolean :
  K extends 'policy.bundleSource' ? 'none' | 'file' :
  K extends 'policy.bundlePath' ? string :
  K extends 'agents.passiveInjection.knowledge' ? boolean :
  K extends 'agents.passiveInjection.code' ? boolean :
  K extends 'agents.passiveInjection.budgetTokens' ? number :
  K extends 'agents.passiveInjection.relevanceFloor' ? number :
  K extends 'agents.passiveInjection.codeLimit' ? number :
  K extends 'agents.contextWindowGuard' ? boolean :
  K extends 'agents.contextCompactThreshold' ? number :
  K extends 'agents.maxTurns' ? number :
  K extends 'agents.maxTurnsCap' ? number :
  K extends 'pricing.modelPrices' ? Record<string, ManualModelPriceConfig> :
  K extends 'checkin.enabled' ? boolean :
  K extends 'checkin.cadence' ? string :
  K extends 'checkin.deliveryChannel' ? string :
  K extends 'checkin.quietHours' ? string :
  K extends 'learning.consolidation.enabled' ? boolean :
  K extends 'learning.consolidation.intervalMs' ? number :
  K extends 'learning.consolidation.minIdleMs' ? number :
  K extends 'learning.consolidation.maxMergesPerRun' ? number :
  K extends 'learning.consolidation.maxDecaysPerRun' ? number :
  K extends 'learning.consolidation.maxProposalsPerRun' ? number :
  K extends 'learning.consolidation.decayAgeDays' ? number :
  K extends 'learning.consolidation.decayConfidenceStep' ? number :
  K extends 'learning.consolidation.archiveConfidenceFloor' ? number :
  K extends 'power.keepAwake' ? boolean :
  K extends 'power.inhibitWhileWorking' ? boolean :
  K extends 'power.workInhibitMaxMinutes' ? number :
  K extends 'memory.budgetMb' ? number :
  K extends 'memory.tier.elevatedPct' ? number :
  K extends 'memory.tier.highPct' ? number :
  K extends 'memory.tier.criticalPct' ? number :
  K extends 'memory.tripwire.rateMbPerSec' ? number :
  K extends 'memory.tripwire.sustainSec' ? number :
  K extends 'memory.hardLimitPct' ? number :
  K extends 'voice.local.sttEngine' ? '' | 'whisper-cpp' | 'faster-whisper' :
  K extends 'voice.local.sttBinary' ? string :
  K extends 'voice.local.sttModelPath' ? string :
  K extends 'voice.local.ttsEngine' ? '' | 'piper' | 'kokoro' :
  K extends 'voice.local.ttsBinary' ? string :
  K extends 'voice.local.ttsModelPath' ? string :
  K extends 'voice.wake.enabled' ? boolean :
  K extends 'voice.wake.models' ? string :
  K extends 'voice.wake.threshold' ? number :
  K extends 'voice.wake.patienceFrames' ? number :
  K extends 'voice.wake.cooldownMs' ? number :
  K extends 'voice.wake.vadThreshold' ? number :
  K extends 'voice.wake.noiseSuppression' ? 'none' | 'speex' :
  K extends 'voice.wake.inputDevice' ? string :
  K extends 'voice.wake.captureCommand' ? 'auto' | 'pw-record' | 'parecord' | 'arecord' | 'ffmpeg' | 'sox' :
  K extends 'voice.wake.surfaces.tui' ? boolean :
  K extends 'voice.wake.surfaces.agent' ? boolean :
  K extends 'voice.wake.surfaces.webui' ? boolean :
  K extends 'voice.wake.activationSound' ? 'none' | 'chime' | 'custom' :
  K extends 'voice.wake.activationSoundPath' ? string :
  K extends 'voice.wake.indicator' ? 'off' | 'statusline' | 'banner' :
  K extends 'voice.wake.preRollMs' ? number :
  K extends 'voice.wake.captureMaxSeconds' ? number :
  K extends 'voice.wake.silenceStopMs' ? number :
  K extends 'voice.wake.autoSubmit' ? boolean :
  K extends 'voice.wake.retainAudio' ? 'none' | 'session-temp' :
  K extends 'voice.wake.customModelDir' ? string :
  K extends 'voice.wake.maxRestarts' ? number :
  K extends 'voice.wake.restartBackoffMs' ? number :
  K extends 'voice.wake.crashWindowSeconds' ? number :
  K extends 'voice.wake.browserBackend' ? 'wasm' | 'webgpu' :
  K extends 'device.capabilities.mode' ? 'off' | 'ask-every-time' | 'honor-grants' :
  K extends 'device.capabilities.allowAlwaysOffer' ? 'every-capability' | 'standard-only' | 'never' :
  K extends 'device.capabilities.requestTimeoutSeconds' ? number :
  K extends 'device.location.precision' ? 'coarse-only' | 'ask-precise' | 'precise-grantable' :
  K extends 'device.clipboard.readMode' ? 'off' | 'ask-only' | 'grantable' :
  K extends 'device.capture.retentionHours' ? number :
  K extends 'device.capture.maxArtifacts' ? number :
  K extends 'device.capture.sweepIntervalMinutes' ? number :
  K extends 'device.grants.expiryDays' ? number :
  K extends 'device.grants.maxPerNode' ? number :
  K extends 'device.grants.auditRetentionDays' ? number :
  K extends 'device.nodes.maxPaired' ? number :
  K extends 'push.vapidSubject' ? string :
  K extends 'push.subscriptions.warnAbovePerPrincipal' ? number :
  K extends 'push.subscriptions.failureThreshold' ? number :
  K extends 'push.subscriptions.sweepIntervalMinutes' ? number :
  K extends 'fleet.maxSize' ? number :
  K extends 'cluster.enabled' ? boolean :
  K extends 'cluster.heartbeatSeconds' ? number :
  K extends 'cluster.masterTimeoutSeconds' ? number :
  K extends 'cluster.bootProbeSeconds' ? number :
  K extends 'cluster.port' ? number :
  K extends 'cluster.multicastGroup' ? string :
  K extends 'cluster.secret' ? string :
  K extends 'cluster.keyRotationHours' ? number :
  K extends 'cluster.keyRotationGraceMinutes' ? number :
  K extends 'cluster.beaconSeconds' ? number :
  K extends 'cluster.rosterGossipSeconds' ? number :
  never;
