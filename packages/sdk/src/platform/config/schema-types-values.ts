/**
 * schema-types-values.ts — the ConfigKey -> value-type map.
 *
 * Split out of schema-types.ts, which had grown to hold three separate things:
 * the config INTERFACES, the ConfigKey union, and this map. The map is the
 * largest of the three and the one nothing but `ConfigManager.get`/`set`
 * consults, so it is the clean seam — the same "move a cohesive block out and
 * re-export it so import sites are unchanged" split schema-types-network.ts,
 * schema-types-platform.ts, schema-types-daemon.ts and schema-types-surfaces.ts
 * already record.
 *
 * The import below is type-only in both directions (schema-types.ts re-exports
 * this module, this module imports types from it), so the cycle is erased at
 * compile time and no runtime edge exists.
 */
import type {
  BatchFallbackMode,
  BatchMode,
  BatchQueueBackend,
} from './schema-types-platform.js';
import type {
  BackgroundAgentsMode,
  ConfigKey,
  LineNumberMode,
  ManualModelPriceConfig,
  PermissionAction,
  PermissionMode,
} from './schema-types.js';
import type { ProfileConfigKey, ProfileConfigValue } from './schema-types-owner-profile.js';

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
  K extends ProfileConfigKey ? ProfileConfigValue<K> :
  never;
