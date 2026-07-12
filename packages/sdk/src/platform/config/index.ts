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
export type { GoodVibesConfig, ConfigKey, ConfigValue, ConfigSetting, PermissionMode, PermissionAction, PermissionsToolConfig, NotificationsConfig } from './schema.js';
export { DEFAULT_CONFIG, CONFIG_KEYS, CONFIG_SCHEMA, isValidConfigKey } from './schema.js';
export { ConfigError } from '../types/errors.js';
export { migrateDangerDaemonAlias, migrateLegacyFeatureToggles } from './migrations.js';
export type { DangerDaemonMigrationResult, LegacySettingsMigrationResult } from './migrations.js';

import { readFileSync } from 'fs';
import { ConfigManager } from './manager.js';
import type { GoodVibesConfig } from './schema.js';

export function getConfigSnapshot(configManager: Pick<ConfigManager, 'getRaw'>): Readonly<GoodVibesConfig> {
  return configManager.getRaw();
}

export function getConfiguredModelId(configManager: Pick<ConfigManager, 'get'>): string {
  return configManager.get('provider.model');
}

export function getConfiguredEmbeddingProviderId(configManager: Pick<ConfigManager, 'get'>): string {
  return configManager.get('provider.embeddingProvider');
}

export function isAutoApproveEnabled(configManager: Pick<ConfigManager, 'get'>): boolean {
  return configManager.get('behavior.autoApprove');
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

export function getWorkingDirectory(configManager: Pick<ConfigManager, 'getWorkingDirectory'>): string | null {
  return configManager.getWorkingDirectory();
}

export function getConfiguredSystemPrompt(configManager: Pick<ConfigManager, 'get'>): string | undefined {
  const file = configManager.get('provider.systemPromptFile');
  if (!file) return undefined;
  return readFileSync(file, 'utf-8');
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
export { createCredentialStatusProvider } from './credential-status.js';
export { SecretsManager, SecretStoreUnreadableError } from './secrets.js';
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
