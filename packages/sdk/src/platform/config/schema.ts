/**
 * Config schema defaults and runtime metadata for goodvibes-sdk.
 */

/**
 * Every module that augments `GoodVibesConfig`, imported for its declarations.
 *
 * `GoodVibesConfig` is assembled by declaration merging: each schema-domain
 * module contributes its own `declare module … { interface GoodVibesConfig }`
 * block. Those blocks only exist in a program that has loaded the module, and
 * the VALUE imports below (`import { clusterConfigDefaults } from …`) do NOT
 * survive declaration emit — TypeScript drops an import from a `.d.ts` when the
 * emitted declarations do not reference its types.
 *
 * The result was a published type that silently omitted domains. Measured
 * before this block existed: importing `GoodVibesConfig` from
 * `@pellux/goodvibes-sdk/platform/config` produced a type where
 * `conversationGate` and `voice` were absent, so a consumer writing
 * `config.getCategory('conversationGate')` got a compile error against a key
 * that ships and works. Two of this repository's own tests hit exactly that
 * once `test/` started being typechecked.
 *
 * A bare side-effect import IS preserved in the emitted `.d.ts` (verified by
 * inspecting dist/platform/config/schema.d.ts), so these lines are what carries
 * the augmentations to consumers. `import type {}` is not — it is erased.
 *
 * These modules are already imported for their values below, so this adds no
 * runtime cost and no new dependency; it only pins them into the declarations.
 */
import './schema-domain-cluster.js';
import './schema-domain-conversation-gate.js';
import './schema-domain-device.js';
import './schema-domain-features.js';
import './schema-domain-fleet.js';
import './schema-domain-learning.js';
import './schema-domain-memory.js';
import './schema-domain-power.js';
import './schema-domain-push.js';
import './schema-domain-runtime.js';
import './schema-domain-update.js';
import './schema-domain-voice-local.js';

import { coreConfigDefaults, coreHeadConfigSettings, coreTailConfigSettings } from './schema-domain-core.js';
import { runtimeConfigDefaults, runtimePrimaryConfigSettings, runtimeSecondaryConfigSettings } from './schema-domain-runtime.js';
import { conversationGateConfigDefaults, conversationGateConfigSettings } from './schema-domain-conversation-gate.js';
import { atRestConfigDefaults, atRestConfigSettings } from './schema-domain-at-rest.js';
import { learningConfigDefaults, learningConfigSettings } from './schema-domain-learning.js';
import { powerConfigDefaults, powerConfigSettings } from './schema-domain-power.js';
import { memoryConfigDefaults, memoryConfigSettings } from './schema-domain-memory.js';
import { voiceLocalConfigDefaults, voiceLocalConfigSettings } from './schema-domain-voice-local.js';
import { voiceWakeConfigDefaults, voiceWakeConfigSettings } from './schema-domain-voice-wake.js';
import { triggersConfigDefaults, triggersConfigSettings } from './schema-domain-triggers.js';
import { deviceConfigDefaults, deviceConfigSettings } from './schema-domain-device.js';
import { pushConfigDefaults, pushConfigSettings } from './schema-domain-push.js';
import { fleetConfigDefaults, fleetConfigSettings } from './schema-domain-fleet.js';
import { clusterConfigDefaults, clusterConfigSettings } from './schema-domain-cluster.js';
import { surfaceConfigDefaults, surfaceConfigSettings } from './schema-domain-surfaces.js';
import { featureConfigDefaults, featureConfigSettings } from './schema-domain-features.js';
import { featureControlSettings } from './schema-domain-feature-controls.js';
import { updateConfigDefaults, updateConfigSettings } from './schema-domain-update.js';
import { pricingConfigDefaults, pricingConfigSettings } from './schema-domain-pricing.js';
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
  watchers: { ...runtimeConfigDefaults.watchers, ...triggersConfigDefaults },
  service: runtimeConfigDefaults.service,
  update: updateConfigDefaults.update,
  network: runtimeConfigDefaults.network,
  relay: runtimeConfigDefaults.relay,
  runtime: runtimeConfigDefaults.runtime,
  conversationGate: conversationGateConfigDefaults.conversationGate,
  telemetry: runtimeConfigDefaults.telemetry,
  atRest: atRestConfigDefaults.atRest,
  worktree: runtimeConfigDefaults.worktree,
  learning: learningConfigDefaults.learning,
  power: powerConfigDefaults.power,
  memory: memoryConfigDefaults.memory,
  voice: { ...voiceLocalConfigDefaults.voice, ...voiceWakeConfigDefaults.voice },
  device: deviceConfigDefaults.device,
  push: pushConfigDefaults.push,
  fleet: fleetConfigDefaults.fleet,
  cluster: clusterConfigDefaults.cluster,
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
  pricing: pricingConfigDefaults.pricing,
} as GoodVibesConfig;

export const CONFIG_SCHEMA: ConfigSetting[] = [
  ...coreHeadConfigSettings,
  ...runtimePrimaryConfigSettings,
  ...conversationGateConfigSettings,
  ...atRestConfigSettings,
  ...learningConfigSettings,
  ...powerConfigSettings,
  ...memoryConfigSettings,
  ...voiceLocalConfigSettings,
  ...voiceWakeConfigSettings,
  ...deviceConfigSettings,
  ...pushConfigSettings,
  ...fleetConfigSettings,
  ...clusterConfigSettings,
  ...surfaceConfigSettings,
  ...runtimeSecondaryConfigSettings,
  ...triggersConfigSettings,
  ...updateConfigSettings,
  ...coreTailConfigSettings,
  ...featureConfigSettings,
  ...featureControlSettings,
  ...pricingConfigSettings,
] as ConfigSetting[];

/** Set of all valid config keys for runtime validation. */
export const CONFIG_KEYS = new Set<string>(CONFIG_SCHEMA.map((setting) => setting.key));

/** Type guard: returns true if key is a valid ConfigKey. */
export function isValidConfigKey(key: string): key is ConfigKey {
  return CONFIG_KEYS.has(key);
}
