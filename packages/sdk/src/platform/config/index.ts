/**
 * Config system barrel export.
 *
 * Provides:
 * - ConfigManager class and all schema types
 * - Pure helpers that derive values from an explicit ConfigManager instance
 */

export { ConfigManager } from './manager.js';
export type { DeepReadonly, ConfigKeyTier, ConfigKeySource } from './manager.js';
export { SHARED_CONFIG_KEYS, isSharedConfigKey } from './shared-config-tier.js';
export {
  DAEMON_OWNED_CONFIG_KEYS,
  DAEMON_OWNED_CONFIG_PREFIXES,
  DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS,
  USER_LOCAL_OVERRIDE_CONFIG_KEYS,
  USER_SHARED_WINS_CONFIG_KEYS,
  configKeyScope,
  describeConfigOwnership,
  isClientOwnedConfigKey,
  isDaemonOwnedConfigKey,
  isUserLevelConfigKey,
  listDaemonOwnedConfigKeys,
  listDaemonOwnedConfigPaths,
  userTierOverlaysSurface,
} from './config-ownership.js';
export type {
  ConfigScope,
  DaemonOwnedConfigPath,
  DaemonOwnedNonSchemaConfigPath,
} from './config-ownership.js';
export {
  DEFAULT_CONTROL_PLANE_PORT,
  controlPlaneScheme,
  deriveControlPlaneBaseUrl,
  describeBaseUrlDrift,
  describeDerivedBindMismatch,
  readControlPlaneBinding,
} from './control-plane-base-url.js';
export type { BaseUrlAudience, ControlPlaneBinding } from './control-plane-base-url.js';
export { readDotPath, raiseReaderFloorInFile } from './shared-config-tier.js';
// Settings ingestion: what a reader does with a setting it cannot ingest, and
// the reader-version floor a migration records when it rewrites shared state.
export {
  SAFETY_GATE_CONFIG_PREFIXES,
  SettingsIngestionRefusal,
  announceIngestionNotice,
  describeIngestionNotice,
  ingestSettingsFile,
  isSafetyGateConfigKey,
  screenSettingsForIngestion,
  unreadableSettingsFileNotice,
} from './settings-ingestion.js';
export type {
  IngestSettingsOptions,
  SettingsIngestionAction,
  SettingsIngestionNotice,
  SettingsIngestionResult,
} from './settings-ingestion.js';
export {
  SETTINGS_FLOOR_MARKER_KEY,
  SWEPT_CREDENTIAL_READER_FLOOR,
  compareReaderVersions,
  describeFloorRefusal,
  raiseSettingsReaderFloor,
  readSettingsReaderFloor,
  readerIsBelowFloor,
  stripSettingsReaderFloor,
} from './settings-reader-floor.js';
export type { SettingsReaderFloor } from './settings-reader-floor.js';
export {
  DAEMON_CONFIG_ROOT,
  DAEMON_SETTINGS_FILE,
  daemonConfigPath,
  daemonConfigPathForHome,
  readDaemonTierFile,
} from './daemon-config-tier.js';
export {
  DEFAULT_PRIMARY_DAEMON_SURFACE,
  describeDaemonConfigMigration,
  migrateDaemonOwnedConfig,
} from './daemon-config-migration.js';
export type {
  DaemonConfigMigrationOptions,
  DaemonConfigMigrationResult,
  DaemonConfigMovedMarker,
  DiscardedConfigKey,
  MovedConfigKey,
} from './daemon-config-migration.js';
export {
  DAEMON_CONFIG_MOVED_FILE,
  daemonConfigMovedPath,
  readDaemonConfigMovedMarker,
} from './daemon-config-migration-io.js';
export {
  DaemonConfigRejectedError,
  DaemonConfigUnreachableError,
  applyConfigWrite,
  discoverDaemonEndpoint,
  readDaemonConfig,
  reapUnansweringRuntimeRecord,
  resolveConfigWriteRoute,
  resolveLiveConfigWriteRoute,
} from './daemon-config-route.js';
export type {
  ConfigWriteOutcome,
  ConfigWriteRoute,
  DaemonConfigEndpoint,
  DaemonConfigRouterDeps,
  LocalConfigWriter,
} from './daemon-config-route.js';
export {
  createEffectiveConfigView,
  loadDaemonConfigSnapshot,
  readConfigValue,
  readEffectiveConfig,
  resolveConfigReadRoute,
} from './daemon-config-read.js';
export type {
  ConfigReadRoute,
  DaemonConfigSnapshot,
  EffectiveConfigView,
  EffectiveConfigEntry,
  LocalConfigReader,
} from './daemon-config-read.js';
export type { GoodVibesConfig, ConfigKey, ConfigValue, ConfigSetting, PermissionMode, PermissionAction, PermissionsToolConfig, NotificationsConfig } from './schema.js';
export { DEFAULT_CONFIG, CONFIG_KEYS, CONFIG_SCHEMA, isValidConfigKey } from './schema.js';
export { ConfigError } from '../types/errors.js';
export {
  hasOverriddenGoodVibesHome,
  resolveGoodVibesDaemonHome,
  resolveGoodVibesHome,
  resolveGoodVibesHomeOwnership,
  resolveGoodVibesTreeDirectory,
} from './goodvibes-home.js';
export type { GoodVibesHomeOwnership } from './goodvibes-home.js';
export { migrateDangerDaemonAlias, migrateLegacyFeatureToggles } from './migrations.js';
export type { DangerDaemonMigrationResult, LegacySettingsMigrationResult } from './migrations.js';

import { readFileSync } from 'fs';
import { ConfigManager } from './manager.js';
import type { GoodVibesConfig } from './schema.js';
import { getProviderIdFromModel } from '../providers/provider-model.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export function getConfigSnapshot(configManager: Pick<ConfigManager, 'getRaw'>): Readonly<GoodVibesConfig> {
  return configManager.getRaw();
}

export function getConfiguredModelId(configManager: Pick<ConfigManager, 'get'>): string {
  return configManager.get('provider.model');
}

export function getConfiguredEmbeddingProviderId(configManager: Pick<ConfigManager, 'get'>): string {
  return configManager.get('provider.embeddingProvider');
}

/**
 * The provider half of the configured `provider.model` value.
 *
 * Reads through the tolerant parser (providers/provider-model.ts), so a config
 * that holds a bare model id or a blank value still yields a provider id
 * instead of throwing the way the strict registry-key reader would.
 */
export function getConfiguredProviderId(configManager: Pick<ConfigManager, 'get'>): string {
  return getProviderIdFromModel(configManager.get('provider.model'));
}

export function isAutoApproveEnabled(configManager: Pick<ConfigManager, 'get'>): boolean {
  return configManager.get('behavior.autoApprove');
}

/**
 * True when the current permission posture effectively auto-approves everything:
 * auto-approve on, permission mode `allow-all`, or a `custom` mode whose every
 * tool action is `allow`. Drives a surface's danger indicator.
 */
export function isEffectiveDangerMode(configManager: Pick<ConfigManager, 'get' | 'getCategory'>): boolean {
  if (configManager.get('behavior.autoApprove')) return true;
  const permMode = configManager.get('permissions.mode');
  if (permMode === 'allow-all') return true;
  if (permMode === 'custom') {
    const tools = configManager.getCategory('permissions').tools;
    if (Object.values(tools).every((action) => action === 'allow')) return true;
  }
  return false;
}

/**
 * Minimal reader shape for {@link resolveDaemonEnabled}. Any object exposing a
 * `get(key)` that returns the relevant config value satisfies it, so both
 * the full {@link ConfigManager} and the narrow `HostServicesConfig` used by
 * bootstrap-services qualify without a circular import.
 */
export interface DaemonEnabledReader {
  get(key: 'daemon.enabled'): boolean | string | number | undefined;
}

/**
 * Resolve whether the local session daemon should run.
 *
 * `daemon.enabled` governs (default `true` — daemon on by default,
 * loopback-bound). The deprecated `danger.daemon` alias that used to
 * override this was removed in CHANGELOG 1.0.0 (its explicit-`false` off-switch is
 * preserved for existing users by a one-time config migration onto
 * `daemon.enabled`, applied at {@link ConfigManager.load} — see migrations.ts).
 *
 * This lives in the shared SDK config module (not TUI-local) so the standalone
 * daemon CLI and the TUI's adopt-or-start path resolve the flag identically.
 */
export function resolveDaemonEnabled(config: DaemonEnabledReader): boolean {
  const enabled = config.get('daemon.enabled');
  return typeof enabled === 'boolean' ? enabled : true;
}

/**
 * Minimal reader shape for {@link resolveConnectedHostDialEnabled}.
 */
export interface ConnectedHostDialReader {
  get(key: 'daemon.connectedHost.enabled'): boolean | string | number | undefined;
}

/**
 * Resolve whether this surface may DIAL the daemon it is connected to.
 *
 * ── Why this is not `resolveDaemonEnabled` ────────────────────────────────
 *
 * `daemon.enabled` answers "does this surface adopt a session daemon of its
 * own". Dialing a host that is already running and answering is a different
 * question, and for a while one key answered both.
 *
 * On a machine with `daemon.enabled: false` and a live connected host that
 * every other caller reached without trouble, the conflation silently killed
 * the session-inputs poll (refused every two seconds, thousands of log lines an
 * hour), the conversation-rewind host registration, the approvals update
 * stream, and the hosted-conversation handoff — while the session spine, the
 * memory spine and the operator tools dialed the SAME host successfully,
 * because they never read the flag. The features that refused and the features
 * that worked disagreed about whether the daemon existed.
 *
 * Defaults to `true`, and deliberately does NOT fall back to `daemon.enabled`:
 * inheriting the old value would rebuild the exact conflation this exists to
 * end. A surface that wants no daemon contact at all sets this to `false`,
 * which is now a thing it can actually say.
 */
export function resolveConnectedHostDialEnabled(config: ConnectedHostDialReader): boolean {
  const enabled = config.get('daemon.connectedHost.enabled');
  return typeof enabled === 'boolean' ? enabled : true;
}

export function getWorkingDirectory(configManager: Pick<ConfigManager, 'getWorkingDirectory'>): string | null {
  return configManager.getWorkingDirectory();
}

/**
 * The contents of `provider.systemPromptFile`, or undefined when no file is
 * configured or the configured file cannot be read.
 *
 * An unreadable file degrades to "no configured system prompt" and says so at
 * debug level rather than throwing: the setting names a file the user may have
 * since moved or deleted, and a boot that dies because of it strands the
 * session over an optional preference.
 */
export function getConfiguredSystemPrompt(configManager: Pick<ConfigManager, 'get'>): string | undefined {
  const file = configManager.get('provider.systemPromptFile');
  if (!file) return undefined;
  try {
    return readFileSync(file, 'utf-8');
  } catch (err) {
    logger.debug('systemPrompt file read failed (non-fatal)', { file, error: summarizeError(err) });
    return undefined;
  }
}

export { getConfiguredApiKeys, resolveApiKeys } from './api-keys.js';
export { createOAuthLocalListener } from './oauth-local-listener.js';
export type { OAuthLocalListener, OAuthLocalListenerConfig } from './oauth-local-listener.js';
export { HelperModel, HelperModelUnavailableError, HelperRouter } from './helper-model.js';
export type {
  HelperChatOptions,
  HelperModelDeps,
  HelperTask,
  HelperUsage,
  ResolvedHelper,
} from './helper-model.js';
export {
  beginOpenAICodexLogin,
  exchangeOpenAICodexCode,
  refreshOpenAICodexToken,
  OPENAI_CODEX_AUTHORIZE_URL,
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_REDIRECT_URI,
  OPENAI_CODEX_TOKEN_URL,
} from './openai-codex-auth.js';
export type { OpenAICodexLoginStart, OpenAICodexTokenResult } from './openai-codex-auth.js';
export * from './secret-refs.js';
export {
  GOODVIBES_URI_PREFIX,
  MalformedSecretRefError,
  describeMalformedSecretRef,
  looksLikeSecretRef,
} from './secret-ref-refusal.js';
export { createCredentialStatusProvider } from './credential-status.js';
export {
  daemonSecretKeyFor,
  isDaemonOwnedSecretKey,
  listDaemonOwnedSecretKeys,
} from './daemon-secret-keys.js';
export { defaultDaemonSecretHome, siblingSurfaceSecretStores } from './secrets-store-paths.js';
export {
  CREDENTIAL_SCOPE_DECLARATIONS,
  describeCredentialScope,
  findCredentialScopeDeclaration,
  isDaemonNeededSecretKey,
  listDaemonNeededKeyPrefixes,
  listExactDaemonNeededKeys,
} from './credential-scope-registry.js';
export type {
  CredentialScopeClass,
  CredentialScopeDeclaration,
} from './credential-scope-registry.js';
export {
  buildCredentialMigrationReceipt,
  describeCredentialMigration,
  migrateDaemonNeededCredentials,
  migrateOnSurfaceStart,
} from './daemon-credential-migration.js';
export type {
  CredentialMigrationEntry,
  CredentialMigrationOutcome,
  CredentialMigrationReceipt,
  CredentialMigrationReport,
  MigratableSecretStore,
} from './daemon-credential-migration.js';
export {
  isDeclaredSecretBearingConfigKey,
  isSecretBearingConfigKey,
  isSecretReferenceValue,
  SECRET_BEARING_CONFIG_PATHS,
} from './secret-bearing-config-keys.js';
export {
  describePlaintextSweep,
  secretReferenceFor,
  sweepPlaintextCredentials,
} from './plaintext-credential-sweep.js';
export type {
  PlaintextSweepEntry,
  PlaintextSweepOutcome,
  PlaintextSweepReport,
  SweepableConfig,
  SweepableSecrets,
} from './plaintext-credential-sweep.js';
export {
  ensureCalendarConfigDefaults,
  ensureConnectorConfigSections,
  ensureGoogleOAuthConfigDefaults,
  ensureMailboxConfigDefaults,
} from './connector-config-sections.js';
export {
  SecretsManager,
  SecretStoreUnreadableError,
  describeSecretWriteScope,
  resolveSecretWriteScope,
  secretWriteScopeWasOverridden,
} from './secrets.js';
export type {
  LegacyStoreIdentity,
  SecretDeleteOptions,
  SecretRecord,
  SecretScope,
  SecretSource,
  SecretStorageMedium,
  SecretStorageMode,
  SecretStorageReview,
  SecretWriteOptions,
  SecretsManagerOptions,
} from './secrets.js';
export { ServiceRegistry } from './service-registry.js';
export type * from './service-registry.js';
export { SubscriptionManager } from './subscriptions.js';
export type {
  OAuthProviderConfig,
  PendingSubscriptionLogin,
  ProviderSubscription,
} from './subscriptions.js';
export * from './subscription-auth.js';
export * from './subscription-providers.js';
export { resolveToolLLM, ToolLLM, ToolLLMUnavailableError } from './tool-llm.js';
export type {
  ResolvedToolLLM,
  ToolLLMChatOptions,
  ToolLLMDeps,
} from './tool-llm.js';

export { atomicWriteFileSync } from './atomic-write.js';
export type { AtomicWriteOptions } from './atomic-write.js';

export {
  QUARANTINE_MAX_FILES_PER_DIR,
  QUARANTINE_RETENTION_MS,
  readVersioned,
  reapQuarantinedFiles,
  UNRECOGNIZED_SUFFIX,
} from './read-versioned.js';
export type {
  QuarantineReapOptions,
  QuarantineReapResult,
  ReadVersionedOptions,
  VersionMigration,
} from './read-versioned.js';

export {
  credentialReadModeFromHostMode,
  deriveCredentialAvailability,
  readClientCredentialStatus,
} from './credential-availability.js';
export type {
  CredentialAvailability,
  CredentialReadMode,
  CredentialStatusEntry,
  CredentialStatusOutcome,
} from './credential-availability.js';
