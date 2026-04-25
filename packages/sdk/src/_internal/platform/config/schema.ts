/**
 * Config schema defaults and runtime metadata for goodvibes-sdk.
 */

import { coreConfigDefaults, coreHeadConfigSettings, coreTailConfigSettings } from './schema-domain-core.js';
import { runtimeConfigDefaults, runtimePrimaryConfigSettings, runtimeSecondaryConfigSettings } from './schema-domain-runtime.js';
import { surfaceConfigDefaults, surfaceConfigSettings } from './schema-domain-surfaces.js';
import type { ConfigKey, ConfigSetting, GoodVibesConfig, SurfacesConfig } from './schema-types.js';

export * from './schema-types.js';

export const DEFAULT_CONFIG = {
  display: coreConfigDefaults.display,
  provider: coreConfigDefaults.provider,
  behavior: coreConfigDefaults.behavior,
  storage: coreConfigDefaults.storage,
  permissions: coreConfigDefaults.permissions,
  orchestration: coreConfigDefaults.orchestration,
  sandbox: coreConfigDefaults.sandbox,
  ui: coreConfigDefaults.ui,
  tts: coreConfigDefaults.tts,
  release: coreConfigDefaults.release,
  automation: runtimeConfigDefaults.automation,
  controlPlane: runtimeConfigDefaults.controlPlane,
  httpListener: runtimeConfigDefaults.httpListener,
  web: runtimeConfigDefaults.web,
  surfaces: surfaceConfigDefaults as SurfacesConfig,
  watchers: runtimeConfigDefaults.watchers,
  service: runtimeConfigDefaults.service,
  network: runtimeConfigDefaults.network,
  runtime: runtimeConfigDefaults.runtime,
  telemetry: runtimeConfigDefaults.telemetry,
  batch: runtimeConfigDefaults.batch,
  cloudflare: runtimeConfigDefaults.cloudflare,
  danger: coreConfigDefaults.danger,
  tools: coreConfigDefaults.tools,
  wrfc: coreConfigDefaults.wrfc,
  cache: coreConfigDefaults.cache,
  helper: coreConfigDefaults.helper,
  notifications: coreConfigDefaults.notifications,
  featureFlags: coreConfigDefaults.featureFlags,
} as GoodVibesConfig;

export const CONFIG_SCHEMA: ConfigSetting[] = [
  ...coreHeadConfigSettings,
  ...runtimePrimaryConfigSettings,
  ...surfaceConfigSettings,
  ...runtimeSecondaryConfigSettings,
  ...coreTailConfigSettings,
] as ConfigSetting[];

/** Set of all valid config keys for runtime validation. */
export const CONFIG_KEYS = new Set<string>(CONFIG_SCHEMA.map((setting) => setting.key));

/** Type guard: returns true if key is a valid ConfigKey. */
export function isValidConfigKey(key: string): key is ConfigKey {
  return CONFIG_KEYS.has(key);
}
