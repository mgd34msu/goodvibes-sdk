/**
 * provider-optimizer-wiring.ts — bind the provider optimizer to its gate and
 * seed its persisted routing mode at startup. Split out of services.ts so the
 * composition monolith stays under its line ceiling.
 */
import type { ConfigManager } from '../config/manager.js';
import type { ProviderOptimizer } from '../providers/optimizer.js';
import type { FeatureFlagManager } from './feature-flags/index.js';

export function bindProviderOptimizerFeatureFlag(
  featureFlags: Pick<FeatureFlagManager, 'isEnabled' | 'subscribe'>,
  providerOptimizer: Pick<ProviderOptimizer, 'setEnabled'>,
): () => void {
  providerOptimizer.setEnabled(featureFlags.isEnabled('provider-optimizer'));
  return featureFlags.subscribe((flagId, state) => {
    if (flagId === 'provider-optimizer') {
      providerOptimizer.setEnabled(state === 'enabled');
    }
  });
}

/**
 * Apply the persistent provider-optimizer routing mode from config at startup.
 * provider.optimizerMode 'off' keeps the optimizer inactive (its gate derives
 * from the same key); this only seeds the mode/pin so an operator can persist
 * "auto" or a pinned model without re-issuing a /provider command each
 * session. Runtime pin/unpin/setMode still override for the live session.
 */
export function applyProviderOptimizerConfigMode(
  configManager: Pick<ConfigManager, 'get'>,
  providerOptimizer: Pick<ProviderOptimizer, 'setMode' | 'pin'>,
): void {
  const mode = configManager.get('provider.optimizerMode');
  if (mode === 'off') {
    providerOptimizer.setMode('manual'); // inert baseline while inactive
    return;
  }
  if (mode === 'pinned') {
    const pinned = configManager.get('provider.optimizerPinnedModel').trim();
    const sep = pinned.indexOf(':');
    if (sep > 0 && sep < pinned.length - 1) {
      providerOptimizer.pin(pinned.slice(0, sep), pinned.slice(sep + 1));
    } else {
      // Pinned mode requested without a valid provider-qualified model — stay manual.
      providerOptimizer.setMode('manual');
    }
  } else {
    providerOptimizer.setMode(mode);
  }
}
