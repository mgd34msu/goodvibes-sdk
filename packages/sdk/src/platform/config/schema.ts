/**
 * Config schema defaults and runtime metadata for goodvibes-sdk.
 */

import { coreConfigDefaults, coreHeadConfigSettings, coreTailConfigSettings } from './schema-domain-core.js';
import { runtimeConfigDefaults, runtimePrimaryConfigSettings, runtimeSecondaryConfigSettings } from './schema-domain-runtime.js';
import { atRestConfigDefaults, atRestConfigSettings } from './schema-domain-at-rest.js';
import { learningConfigDefaults, learningConfigSettings } from './schema-domain-learning.js';
import { surfaceConfigDefaults, surfaceConfigSettings } from './schema-domain-surfaces.js';
import { featureConfigDefaults, featureConfigSettings } from './schema-domain-features.js';
import { featureControlSettings } from './schema-domain-feature-controls.js';
import { updateConfigDefaults, updateConfigSettings } from './schema-domain-update.js';
import type { ConfigKey, ConfigSetting, GoodVibesConfig, SurfacesConfig } from './schema-types.js';

export * from './schema-types.js';

export const DEFAULT_CONFIG = {
  display: coreConfigDefaults.display,
  provider: coreConfigDefaults.provider,
  behavior: coreConfigDefaults.behavior,
  storage: coreConfigDefaults.storage,
  permissions: coreConfigDefaults.permissions,
  diagnostics: coreConfigDefaults.diagnostics,
  orchestration: coreConfigDefaults.orchestration,
  planner: coreConfigDefaults.planner,
  sandbox: coreConfigDefaults.sandbox,
  ui: coreConfigDefaults.ui,
  tts: coreConfigDefaults.tts,
  release: coreConfigDefaults.release,
  automation: runtimeConfigDefaults.automation,
  checkin: runtimeConfigDefaults.checkin,
  controlPlane: runtimeConfigDefaults.controlPlane,
  httpListener: runtimeConfigDefaults.httpListener,
  web: runtimeConfigDefaults.web,
  surfaces: surfaceConfigDefaults as SurfacesConfig,
  watchers: runtimeConfigDefaults.watchers,
  service: runtimeConfigDefaults.service,
  update: updateConfigDefaults.update,
  network: runtimeConfigDefaults.network,
  relay: runtimeConfigDefaults.relay,
  runtime: runtimeConfigDefaults.runtime,
  telemetry: runtimeConfigDefaults.telemetry,
  atRest: atRestConfigDefaults.atRest,
  worktree: runtimeConfigDefaults.worktree,
  learning: learningConfigDefaults.learning,
  batch: runtimeConfigDefaults.batch,
  cloudflare: runtimeConfigDefaults.cloudflare,
  daemon: coreConfigDefaults.daemon,
  danger: coreConfigDefaults.danger,
  tools: coreConfigDefaults.tools,
  wrfc: coreConfigDefaults.wrfc,
  cache: coreConfigDefaults.cache,
  helper: coreConfigDefaults.helper,
  notifications: coreConfigDefaults.notifications,
  fetch: featureConfigDefaults.fetch,
  security: featureConfigDefaults.security,
  integrations: featureConfigDefaults.integrations,
  policy: featureConfigDefaults.policy,
  agents: featureConfigDefaults.agents,
} as GoodVibesConfig;

export const CONFIG_SCHEMA: ConfigSetting[] = [
  ...coreHeadConfigSettings,
  ...runtimePrimaryConfigSettings,
  ...atRestConfigSettings,
  ...learningConfigSettings,
  ...surfaceConfigSettings,
  ...runtimeSecondaryConfigSettings,
  ...updateConfigSettings,
  ...coreTailConfigSettings,
  ...featureConfigSettings,
  ...featureControlSettings,
] as ConfigSetting[];

/** Set of all valid config keys for runtime validation. */
export const CONFIG_KEYS = new Set<string>(CONFIG_SCHEMA.map((setting) => setting.key));

/** Type guard: returns true if key is a valid ConfigKey. */
export function isValidConfigKey(key: string): key is ConfigKey {
  return CONFIG_KEYS.has(key);
}
