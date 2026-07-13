import type { FeatureFlagManager } from './manager.js';
import { assertFeatureGateIdRegistered, getFeatureSettingsBinding } from './feature-settings.js';

export type FeatureFlagReader = Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;

export function isFeatureGateEnabled(
  featureFlags: FeatureFlagReader,
  flagId: string,
): boolean {
  // Membership first, even with no manager wired: a gate id absent from
  // FEATURE_SETTINGS could never be enabled by any setting — fail loudly at
  // the composition site instead of shipping the capability dead.
  assertFeatureGateIdRegistered(flagId, 'isFeatureGateEnabled');
  if (!featureFlags) return true;
  return featureFlags.isEnabled(flagId);
}

export function requireFeatureGate(
  featureFlags: FeatureFlagReader,
  flagId: string,
  operation: string,
): void {
  if (isFeatureGateEnabled(featureFlags, flagId)) return;
  const binding = getFeatureSettingsBinding(flagId);
  const hint = binding ? ` (see the ${binding.key} setting)` : '';
  throw new Error(`the ${flagId} feature is turned off${hint}; cannot ${operation}`);
}

/**
 * Every channel adapter's surface -> gate-id map. COMPLETE by contract: each
 * entry is backed by a registered `<surface>-surface` flag whose constant
 * binding names the surfaces.<x>.enabled domain key, so consumers can adopt
 * gating without hard-disabling a working route (the recorded TUI divergence:
 * an unmapped adapter read as OFF with no settings recourse). Completeness is
 * pinned by test against the channel plugin registry's surface ids.
 */
const SURFACE_GATE_IDS: Readonly<Record<string, string>> = {
  web: 'web-surface',
  slack: 'slack-surface',
  discord: 'discord-surface',
  ntfy: 'ntfy-surface',
  webhook: 'webhook-surface',
  homeassistant: 'homeassistant-surface',
  telegram: 'telegram-surface',
  whatsapp: 'whatsapp-surface',
  signal: 'signal-surface',
  msteams: 'msteams-surface',
  matrix: 'matrix-surface',
  mattermost: 'mattermost-surface',
  imessage: 'imessage-surface',
  bluebubbles: 'bluebubbles-surface',
  'google-chat': 'google-chat-surface',
  telephony: 'telephony-surface',
};

export function surfaceFeatureGateId(surface: string): string | null {
  return SURFACE_GATE_IDS[surface] ?? null;
}

export function isSurfaceFeatureGateEnabled(
  featureFlags: FeatureFlagReader,
  surface: string,
): boolean {
  if (!featureFlags) return true;
  if (surface === 'tui' || surface === 'service') return true;
  const flagId = surfaceFeatureGateId(surface);
  // Route through isFeatureGateEnabled so the registry-membership check
  // applies to every surface gate reference too.
  return flagId ? isFeatureGateEnabled(featureFlags, flagId) : false;
}
