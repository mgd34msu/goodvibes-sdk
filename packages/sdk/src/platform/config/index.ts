/**
 * Config system barrel export.
 *
 * Provides:
 * - ConfigManager class and all schema types
 * - Pure helpers that derive values from an explicit ConfigManager instance
 */

export { ConfigManager } from './manager.js';
export type { DeepReadonly } from './manager.js';
export type { GoodVibesConfig, ConfigKey, ConfigValue, ConfigSetting, PermissionMode, PermissionAction, PermissionsToolConfig, NotificationsConfig } from './schema.js';
export { DEFAULT_CONFIG, CONFIG_KEYS, CONFIG_SCHEMA, isValidConfigKey } from './schema.js';
export type { PersistedFlagState } from './schema-types.js';
export { ConfigError } from '../types/errors.js';

import { readFileSync } from 'fs';
import { ConfigManager } from './manager.js';
import type { GoodVibesConfig } from './schema.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export function getConfigSnapshot(configManager: Pick<ConfigManager, 'getRaw'>): Readonly<GoodVibesConfig> {
  return configManager.getRaw();
}

export function getConfiguredModelId(configManager: Pick<ConfigManager, 'get'>): string {
  return configManager.get('provider.model');
}

export function getConfiguredProviderId(configManager: Pick<ConfigManager, 'get'>): string {
  return configManager.get('provider.provider');
}

export function getConfiguredEmbeddingProviderId(configManager: Pick<ConfigManager, 'get'>): string {
  return configManager.get('provider.embeddingProvider');
}

export function isAutoApproveEnabled(configManager: Pick<ConfigManager, 'get'>): boolean {
  return configManager.get('behavior.autoApprove');
}

export function getWorkingDirectory(configManager: Pick<ConfigManager, 'getWorkingDirectory'>): string | null {
  return configManager.getWorkingDirectory();
}

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
export { HelperModel, HelperRouter } from './helper-model.js';
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
export { SecretsManager } from './secrets.js';
export type {
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
export { resolveToolLLM, ToolLLM } from './tool-llm.js';
export type {
  ResolvedToolLLM,
  ToolLLMChatOptions,
  ToolLLMDeps,
} from './tool-llm.js';
