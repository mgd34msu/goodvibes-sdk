/**
 * Machine-readable association between each capability in the internal
 * registry and the CONFIG_SCHEMA keys (and their top-level categories) that
 * tune it. feature-settings.ts joins this map with the enablement bindings to
 * build FEATURE_SETTINGS — the per-feature metadata surfaces render as ONE
 * unit (enablement + tuning keys together).
 *
 * Every entry's `configKeys` is typed `ConfigKey[]`, so a key that is not a real
 * config key fails typecheck (no decorative associations). EVERY id in
 * FEATURE_FLAGS has an entry here; a feature with no tuning config carries empty
 * arrays. The flag-config-map.test.ts guard keeps this map and FEATURE_FLAGS in
 * lockstep (bidirectional completeness).
 */
import type { ConfigKey } from '../../config/schema-types.js';

export interface FeatureFlagConfigAssociation {
  /** Top-level GoodVibesConfig categories this feature's config keys live under (empty when none). */
  readonly configCategories: readonly string[];
  /** Exact scalar ConfigKey dot-paths that tune this feature (empty when the flag has no config). */
  readonly configKeys: readonly ConfigKey[];
}

const PERMISSION_TOOL_KEYS: readonly ConfigKey[] = [
  'permissions.tools.read',
  'permissions.tools.write',
  'permissions.tools.edit',
  'permissions.tools.exec',
  'permissions.tools.find',
  'permissions.tools.fetch',
  'permissions.tools.analyze',
  'permissions.tools.inspect',
  'permissions.tools.agent',
  'permissions.tools.state',
  'permissions.tools.workflow',
  'permissions.tools.registry',
  'permissions.tools.delegate',
  'permissions.tools.mcp',
];

export const FEATURE_FLAG_CONFIG: Readonly<Record<string, FeatureFlagConfigAssociation>> = {
  // ── Permissions ──────────────────────────────────────────────────────────
  'permissions-policy-engine': {
    configCategories: ['permissions'],
    configKeys: ['permissions.mode', 'permissions.backgroundAgents', ...PERMISSION_TOOL_KEYS],
  },
  'permissions-simulation': { configCategories: [], configKeys: [] },
  'permission-divergence-dashboard': {
    configCategories: ['permissions'],
    configKeys: ['permissions.divergenceThreshold', 'permissions.maxDivergenceRecords'],
  },
  'policy-signing': { configCategories: [], configKeys: [] },
  'policy-as-code': {
    configCategories: ['policy'],
    configKeys: ['policy.bundleSource', 'policy.bundlePath'],
  },
  'shell-ast-normalization': { configCategories: [], configKeys: [] },

  // ── HITL / notifications ─────────────────────────────────────────────────
  'hitl-ux-modes': { configCategories: ['behavior'], configKeys: ['behavior.hitlMode'] },
  'adaptive-notification-suppression': {
    configCategories: ['notifications'],
    configKeys: [
      'notifications.burstWindowMs',
      'notifications.burstThreshold',
      'notifications.burstCooldownMs',
    ],
  },

  // ── Runtime / tasks / lifecycle ──────────────────────────────────────────
  'unified-runtime-task': { configCategories: [], configKeys: [] },
  'plugin-lifecycle': { configCategories: [], configKeys: [] },
  'mcp-lifecycle': { configCategories: [], configKeys: [] },
  'tool-result-reconciliation': { configCategories: [], configKeys: [] },
  'tool-contract-verification': { configCategories: [], configKeys: [] },
  'runtime-tools-budget-enforcement': {
    configCategories: ['runtime'],
    configKeys: [
      'runtime.toolBudget.maxMs',
      'runtime.toolBudget.maxTokens',
      'runtime.toolBudget.maxCostUsd',
    ],
  },
  'overflow-spill-backends': {
    configCategories: ['tools'],
    configKeys: ['tools.overflowSpillBackend'],
  },
  'output-schema-fingerprint': { configCategories: [], configKeys: [] },

  // ── Telemetry ────────────────────────────────────────────────────────────
  'otel-foundation': { configCategories: [], configKeys: [] },
  'otel-remote-export': {
    configCategories: ['telemetry'],
    configKeys: [
      'telemetry.decisionOtlpEnabled',
      'telemetry.decisionOtlpEndpoint',
      'telemetry.decisionOtlpSignal',
    ],
  },

  // ── Compaction / context ─────────────────────────────────────────────────
  'session-compaction': {
    configCategories: ['behavior'],
    configKeys: ['behavior.autoCompactThreshold', 'behavior.compactionStrategy', 'behavior.staleContextWarnings'],
  },
  'compaction-distiller-strategy': {
    configCategories: ['behavior'],
    configKeys: ['behavior.compactionStrategy'],
  },
  'agent-context-window-awareness': {
    configCategories: ['agents'],
    configKeys: ['agents.contextCompactThreshold'],
  },
  'agent-passive-knowledge-injection': {
    configCategories: ['agents'],
    configKeys: ['agents.passiveInjection.budgetTokens', 'agents.passiveInjection.relevanceFloor'],
  },
  'agent-passive-code-injection': {
    configCategories: ['agents'],
    configKeys: [
      'agents.passiveInjection.codeLimit',
      'agents.passiveInjection.budgetTokens',
      'agents.passiveInjection.relevanceFloor',
    ],
  },
  'local-provider-context-ingestion': { configCategories: [], configKeys: [] },

  // ── Fetch ────────────────────────────────────────────────────────────────
  'fetch-sanitization': {
    configCategories: ['fetch'],
    configKeys: ['fetch.sanitizeMode', 'fetch.trustedHosts', 'fetch.blockedHosts', 'fetch.allowLocalhost'],
  },

  // ── Providers / planning ─────────────────────────────────────────────────
  'adaptive-execution-planner': { configCategories: [], configKeys: [] },
  'provider-optimizer': {
    configCategories: ['provider'],
    configKeys: ['provider.optimizerMode', 'provider.optimizerPinnedModel'],
  },

  // ── Security ─────────────────────────────────────────────────────────────
  'token-scope-rotation-audit': {
    configCategories: ['security'],
    configKeys: [
      'security.tokenAudit.rotationCadenceDays',
      'security.tokenAudit.rotationWarningDays',
      'security.tokenAudit.managed',
    ],
  },

  // ── Integrations / delivery / automation ─────────────────────────────────
  'integration-delivery-slo': {
    configCategories: ['integrations'],
    configKeys: [
      'integrations.delivery.maxRetries',
      'integrations.delivery.initialDelayMs',
      'integrations.delivery.maxDelayMs',
      'integrations.delivery.maxDlqSize',
      'integrations.delivery.sloEnforced',
    ],
  },
  'automation-domain': {
    configCategories: ['automation'],
    configKeys: [
      'automation.enabled',
      'automation.maxConcurrentRuns',
      'automation.runHistoryLimit',
      'automation.defaultTimeoutMs',
      'automation.catchUpWindowMinutes',
      'automation.failureCooldownMs',
      'automation.deleteAfterRun',
    ],
  },
  'delivery-engine': { configCategories: [], configKeys: [] },
  'route-binding': { configCategories: [], configKeys: [] },

  // ── Control plane / surfaces ─────────────────────────────────────────────
  'control-plane-gateway': {
    configCategories: ['controlPlane'],
    configKeys: [
      'controlPlane.enabled',
      'controlPlane.hostMode',
      'controlPlane.host',
      'controlPlane.port',
      'controlPlane.baseUrl',
      'controlPlane.streamMode',
      'controlPlane.allowRemote',
      'controlPlane.trustProxy',
      'controlPlane.openaiCompatible.enabled',
      'controlPlane.openaiCompatible.pathPrefix',
      'controlPlane.webui.serve',
      'controlPlane.webui.bundleDir',
      'controlPlane.cors.enabled',
      'controlPlane.cors.allowedOrigins',
      'controlPlane.tls.mode',
      'controlPlane.tls.certFile',
      'controlPlane.tls.keyFile',
    ],
  },
  'slack-surface': {
    configCategories: ['surfaces'],
    configKeys: [
      'surfaces.slack.enabled',
      'surfaces.slack.signingSecret',
      'surfaces.slack.botToken',
      'surfaces.slack.appToken',
      'surfaces.slack.defaultChannel',
      'surfaces.slack.workspaceId',
    ],
  },
  'discord-surface': {
    configCategories: ['surfaces'],
    configKeys: [
      'surfaces.discord.enabled',
      'surfaces.discord.publicKey',
      'surfaces.discord.botToken',
      'surfaces.discord.applicationId',
      'surfaces.discord.defaultChannelId',
      'surfaces.discord.guildId',
    ],
  },
  'ntfy-surface': {
    configCategories: ['surfaces'],
    configKeys: [
      'surfaces.ntfy.enabled',
      'surfaces.ntfy.baseUrl',
      'surfaces.ntfy.topic',
      'surfaces.ntfy.chatTopic',
      'surfaces.ntfy.agentTopic',
      'surfaces.ntfy.remoteTopic',
      'surfaces.ntfy.token',
      'surfaces.ntfy.defaultPriority',
    ],
  },
  'webhook-surface': {
    configCategories: ['surfaces'],
    configKeys: [
      'surfaces.webhook.enabled',
      'surfaces.webhook.defaultTarget',
      'surfaces.webhook.timeoutMs',
      'surfaces.webhook.secret',
    ],
  },
  'homeassistant-surface': {
    configCategories: ['surfaces'],
    configKeys: [
      'surfaces.homeassistant.enabled',
      'surfaces.homeassistant.instanceUrl',
      'surfaces.homeassistant.accessToken',
      'surfaces.homeassistant.webhookSecret',
      'surfaces.homeassistant.defaultConversationId',
      'surfaces.homeassistant.deviceId',
      'surfaces.homeassistant.deviceName',
      'surfaces.homeassistant.eventType',
      'surfaces.homeassistant.remoteSessionTtlMs',
    ],
  },
  'web-surface': {
    configCategories: ['web'],
    configKeys: [
      'web.enabled',
      'web.hostMode',
      'web.host',
      'web.port',
      'web.publicBaseUrl',
      'web.staticAssetsDir',
    ],
  },
  'watcher-framework': {
    configCategories: ['watchers'],
    configKeys: [
      'watchers.enabled',
      'watchers.pollIntervalMs',
      'watchers.heartbeatIntervalMs',
      'watchers.recoveryWindowMinutes',
    ],
  },
  'service-management': {
    configCategories: ['service'],
    configKeys: [
      'service.enabled',
      'service.autostart',
      'service.restartOnFailure',
      'service.platform',
      'service.serviceName',
      'service.logPath',
    ],
  },
  'daemon-auto-update': {
    configCategories: ['update'],
    configKeys: [
      'update.auto',
      'update.intervalMinutes',
      'update.releasesUrl',
    ],
  },

  // ── Execution isolation / reachability ───────────────────────────────────
  'exec-sandbox': {
    configCategories: ['sandbox'],
    configKeys: [
      'sandbox.enabled',
      'sandbox.replIsolation',
      'sandbox.mcpIsolation',
      'sandbox.windowsMode',
      'sandbox.vmBackend',
      'sandbox.qemuBinary',
      'sandbox.qemuImagePath',
      'sandbox.qemuExecWrapper',
      'sandbox.qemuGuestHost',
      'sandbox.qemuGuestPort',
      'sandbox.qemuGuestUser',
      'sandbox.qemuWorkspacePath',
      'sandbox.qemuSessionMode',
      'sandbox.replJavaScriptCommand',
    ],
  },
  'sandbox-model-judgment': {
    configCategories: ['sandbox'],
    configKeys: ['sandbox.judgment'],
  },
  'relay-connect': {
    configCategories: ['relay'],
    configKeys: [
      'relay.enabled',
      'relay.url',
      'relay.rendezvousId',
      'relay.label',
      'relay.requireStepUpForMutations',
    ],
  },
};

/**
 * Config association for a flag id. Returns empty arrays for an unknown flag id
 * (callers treat "no association" and "unknown flag" identically for rendering).
 */
export function getFeatureFlagConfig(flagId: string): FeatureFlagConfigAssociation {
  return FEATURE_FLAG_CONFIG[flagId] ?? { configCategories: [], configKeys: [] };
}
