/**
 * feature-settings.ts — the binding layer between domain settings keys and the
 * internal capability gates, plus the per-feature settings metadata surfaces
 * render.
 *
 * Every platform capability is configured through a first-class settings key
 * in its natural domain (behavior.compactionStrategy, sandbox.enabled,
 * notifications.adaptiveSuppression, ...). There is no separate enablement
 * namespace: at boot the runtime derives each internal gate's state from its
 * bound settings key, and the live bridge keeps them in sync afterwards.
 * The internal gate registry (flags.ts) and its kill-switch manager survive as
 * implementation detail only — surfaces render FEATURE_SETTINGS, never that
 * registry as a category of its own.
 *
 * Binding kinds:
 * - boolean : the key's boolean value is the feature's enablement.
 * - enum    : the feature is active while the key's value is in enabledValues
 *             (several features can share one key — e.g. telemetry.otelMode
 *             drives both the in-process instrumentation and remote export).
 * - constant: the capability has no separate off switch; its own domain keys
 *             (listed in its settings association) govern runtime activation
 *             directly and only the internal kill switch can force it off.
 */
import type { ConfigKey } from '../../config/schema-types.js';
import type { ConfigManager } from '../../config/manager.js';
import { logger } from '../../utils/logger.js';
import { FEATURE_FLAGS, FEATURE_FLAG_MAP } from './flags.js';
import { getFeatureFlagConfig } from './flag-config-map.js';
import type { FeatureFlagManager } from './manager.js';
import type { FlagState } from './types.js';

export type FeatureEnablementKind = 'boolean' | 'enum' | 'constant';

export interface FeatureSettingsBinding {
  readonly featureId: string;
  /** The scalar settings key that decides (or, for constant, represents) enablement. */
  readonly key: ConfigKey;
  readonly kind: FeatureEnablementKind;
  /** For kind 'enum': the key values for which the feature is active. */
  readonly enabledValues?: readonly string[];
}

/** Every capability's enablement binding — one entry per registry id. */
export const FEATURE_SETTINGS_BINDINGS: readonly FeatureSettingsBinding[] = [
  { featureId: 'permissions-policy-engine', key: 'permissions.engine', kind: 'enum', enabledValues: ['policy-engine'] },
  { featureId: 'permissions-simulation', key: 'permissions.simulation', kind: 'boolean' },
  { featureId: 'permission-divergence-dashboard', key: 'permissions.divergenceDashboard', kind: 'boolean' },
  { featureId: 'shell-ast-normalization', key: 'permissions.commandParser', kind: 'enum', enabledValues: ['ast'] },
  { featureId: 'policy-signing', key: 'policy.requireSignedBundles', kind: 'boolean' },
  { featureId: 'policy-as-code', key: 'policy.registryEnabled', kind: 'boolean' },
  { featureId: 'hitl-ux-modes', key: 'behavior.hitlMode', kind: 'enum', enabledValues: ['quiet', 'balanced', 'operator'] },
  { featureId: 'tool-result-reconciliation', key: 'behavior.toolResultReconciliation', kind: 'enum', enabledValues: ['reconcile'] },
  { featureId: 'session-compaction', key: 'behavior.compactionStrategy', kind: 'enum', enabledValues: ['structured', 'distiller'] },
  { featureId: 'compaction-distiller-strategy', key: 'behavior.compactionStrategy', kind: 'enum', enabledValues: ['distiller'] },
  { featureId: 'unified-runtime-task', key: 'runtime.unifiedTasks', kind: 'boolean' },
  { featureId: 'plugin-lifecycle', key: 'runtime.pluginLifecycle', kind: 'boolean' },
  { featureId: 'mcp-lifecycle', key: 'runtime.mcpLifecycle', kind: 'boolean' },
  { featureId: 'runtime-tools-budget-enforcement', key: 'runtime.toolBudget.enforced', kind: 'boolean' },
  { featureId: 'overflow-spill-backends', key: 'tools.overflowSpillBackend', kind: 'enum', enabledValues: ['ledger', 'diagnostics'] },
  { featureId: 'tool-contract-verification', key: 'tools.contractVerification', kind: 'boolean' },
  { featureId: 'output-schema-fingerprint', key: 'tools.outputSchemaFingerprints', kind: 'boolean' },
  { featureId: 'otel-foundation', key: 'telemetry.otelMode', kind: 'enum', enabledValues: ['in-process', 'remote-export'] },
  { featureId: 'otel-remote-export', key: 'telemetry.otelMode', kind: 'enum', enabledValues: ['remote-export'] },
  { featureId: 'local-provider-context-ingestion', key: 'provider.localContextIngestion', kind: 'boolean' },
  { featureId: 'provider-optimizer', key: 'provider.optimizerMode', kind: 'enum', enabledValues: ['manual', 'auto', 'pinned'] },
  { featureId: 'adaptive-execution-planner', key: 'planner.adaptive', kind: 'boolean' },
  // Sanitization mode and localhost approval tune the fetch pipeline; host
  // blocking of private IPs and metadata endpoints is absolute, so the
  // capability itself has no off switch.
  { featureId: 'fetch-sanitization', key: 'fetch.sanitizeMode', kind: 'constant' },
  { featureId: 'token-scope-rotation-audit', key: 'security.tokenAudit.enabled', kind: 'boolean' },
  { featureId: 'adaptive-notification-suppression', key: 'notifications.adaptiveSuppression', kind: 'boolean' },
  { featureId: 'integration-delivery-slo', key: 'integrations.delivery.sloEnforced', kind: 'boolean' },
  { featureId: 'route-binding', key: 'integrations.routeBinding', kind: 'boolean' },
  { featureId: 'delivery-engine', key: 'integrations.deliveryTracking', kind: 'boolean' },
  { featureId: 'automation-domain', key: 'automation.enabled', kind: 'boolean' },
  { featureId: 'control-plane-gateway', key: 'controlPlane.gateway', kind: 'boolean' },
  // Channel adapters activate through their own enabled key + credentials;
  // the capability is always present, so the gate is constant and the
  // surface's enabled key is the honest user-facing switch.
  { featureId: 'slack-surface', key: 'surfaces.slack.enabled', kind: 'constant' },
  { featureId: 'discord-surface', key: 'surfaces.discord.enabled', kind: 'constant' },
  { featureId: 'ntfy-surface', key: 'surfaces.ntfy.enabled', kind: 'constant' },
  { featureId: 'webhook-surface', key: 'surfaces.webhook.enabled', kind: 'constant' },
  { featureId: 'homeassistant-surface', key: 'surfaces.homeassistant.enabled', kind: 'constant' },
  { featureId: 'web-surface', key: 'web.enabled', kind: 'boolean' },
  { featureId: 'watcher-framework', key: 'watchers.enabled', kind: 'boolean' },
  { featureId: 'service-management', key: 'service.enabled', kind: 'boolean' },
  { featureId: 'exec-sandbox', key: 'sandbox.enabled', kind: 'boolean' },
  { featureId: 'sandbox-model-judgment', key: 'sandbox.judgment', kind: 'enum', enabledValues: ['annotate', 'auto-approve'] },
  { featureId: 'relay-connect', key: 'relay.enabled', kind: 'boolean' },
];

const BINDINGS_BY_ID: ReadonlyMap<string, FeatureSettingsBinding> = new Map(
  FEATURE_SETTINGS_BINDINGS.map((b) => [b.featureId, b]),
);

export function getFeatureSettingsBinding(featureId: string): FeatureSettingsBinding | null {
  return BINDINGS_BY_ID.get(featureId) ?? null;
}

/** Derive one feature's state from a settings value per its binding. */
export function deriveFeatureState(binding: FeatureSettingsBinding, value: unknown): FlagState {
  switch (binding.kind) {
    case 'constant':
      return 'enabled';
    case 'boolean':
      return value === true ? 'enabled' : 'disabled';
    case 'enum':
      return typeof value === 'string' && (binding.enabledValues ?? []).includes(value)
        ? 'enabled'
        : 'disabled';
  }
}

/**
 * Derive every feature's desired state from the live config. Used at boot to
 * seed the gate manager; because each settings default matches the registry
 * default (enforced by test), deriving on a fresh config is a no-op.
 */
export function deriveFeatureStates(
  configManager: Pick<ConfigManager, 'get'>,
): Record<string, FlagState> {
  const states: Record<string, FlagState> = {};
  for (const binding of FEATURE_SETTINGS_BINDINGS) {
    states[binding.featureId] = deriveFeatureState(binding, configManager.get(binding.key));
  }
  return states;
}

/**
 * Live bridge from domain settings changes to the in-process gate manager.
 * Subscribes each bound key once and forwards the derived state for every
 * feature bound to it. Runtime-toggleable gates apply immediately; startup
 * gates record an honest pending-restart marker (see
 * FeatureFlagManager.applyConfigState). Constant bindings need no
 * subscription — their domain keys act directly on the subsystems that read
 * them.
 */
export function bindFeatureSettingsBridge(
  configManager: Pick<ConfigManager, 'subscribe'>,
  featureFlags: Pick<FeatureFlagManager, 'applyConfigState'>,
): () => void {
  const byKey = new Map<ConfigKey, FeatureSettingsBinding[]>();
  for (const binding of FEATURE_SETTINGS_BINDINGS) {
    if (binding.kind === 'constant') continue;
    const list = byKey.get(binding.key) ?? [];
    list.push(binding);
    byKey.set(binding.key, list);
  }
  const unsubs: Array<() => void> = [];
  for (const [key, bindings] of byKey) {
    unsubs.push(configManager.subscribe(key, (newValue: unknown) => {
      for (const binding of bindings) {
        try {
          featureFlags.applyConfigState(binding.featureId, deriveFeatureState(binding, newValue));
        } catch (err) {
          logger.warn('[feature-settings] failed to apply settings change to gate', {
            featureId: binding.featureId,
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }));
  }
  return () => {
    for (const unsub of unsubs.splice(0)) unsub();
  };
}

/** One feature as the settings surfaces render it. */
export interface FeatureSetting {
  readonly id: string;
  readonly name: string;
  /** Real description of behavior and options (feeds under-cursor docs). */
  readonly description: string;
  /** Top-level settings domain the feature lives in (its config category). */
  readonly domain: string;
  /** How the feature is turned on/off. */
  readonly enablement: {
    readonly key: ConfigKey;
    readonly kind: FeatureEnablementKind;
    readonly enabledValues?: readonly string[];
  };
  /** Every scalar settings key that configures this feature (enablement key first). */
  readonly settings: readonly ConfigKey[];
  /** True when enablement changes only take effect after a process restart. */
  readonly restartRequired: boolean;
  /** Whether a stock configuration has the feature active. */
  readonly defaultEnabled: boolean;
}

function buildFeatureSetting(binding: FeatureSettingsBinding): FeatureSetting {
  const flag = FEATURE_FLAG_MAP.get(binding.featureId);
  if (!flag) {
    throw new Error(`[feature-settings] binding references unknown feature "${binding.featureId}"`);
  }
  const association = getFeatureFlagConfig(binding.featureId);
  const settings: ConfigKey[] = [binding.key];
  for (const key of association.configKeys) {
    if (!settings.includes(key)) settings.push(key);
  }
  return {
    id: flag.id,
    name: flag.name,
    description: flag.description,
    domain: binding.key.split('.')[0] ?? '',
    enablement: {
      key: binding.key,
      kind: binding.kind,
      ...(binding.enabledValues !== undefined ? { enabledValues: binding.enabledValues } : {}),
    },
    settings,
    restartRequired: !flag.runtimeToggleable,
    defaultEnabled: flag.defaultState === 'enabled',
  };
}

/**
 * The per-feature settings metadata surfaces consume: domain, option shapes
 * (enablement key + associated tuning keys, each described in CONFIG_SCHEMA),
 * and real behavior descriptions. Ordered by the registry declaration order.
 */
export const FEATURE_SETTINGS: readonly FeatureSetting[] = FEATURE_FLAGS.map((flag) => {
  const binding = BINDINGS_BY_ID.get(flag.id);
  if (!binding) {
    throw new Error(`[feature-settings] feature "${flag.id}" has no settings binding`);
  }
  return buildFeatureSetting(binding);
});
