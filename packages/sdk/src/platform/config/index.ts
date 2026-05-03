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
export { DEFAULT_CONFIG, CONFIG_SCHEMA } from './schema.js';
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
