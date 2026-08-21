import type { FeatureFlagManager } from './manager.js';
import { assertFeatureGateIdRegistered, getFeatureSettingsBinding } from './feature-settings.js';
import { FEATURE_FLAG_MAP } from './flags.js';
import type { FeatureInoperability } from './types.js';

export type FeatureFlagReader = Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;

/**
 * The declared reason a capability cannot operate in this build, or null when
 * it can. Surfaces read this to explain a control instead of offering one that
 * does nothing.
 */
export function featureInoperability(flagId: string): FeatureInoperability | null {
  return FEATURE_FLAG_MAP.get(flagId)?.notOperable ?? null;
}

export function isFeatureGateEnabled(
  featureFlags: FeatureFlagReader,
  flagId: string,
): boolean {
  // Membership first, even with no manager wired: a gate id absent from
  // FEATURE_SETTINGS could never be enabled by any setting, fail loudly at
  // the composition site instead of shipping the capability dead.
  assertFeatureGateIdRegistered(flagId, 'isFeatureGateEnabled');
  // A capability that cannot operate is OFF, whatever its settings key says
  // and even with no manager wired (the branch below defaults to permissive).
  // Without this, a user flips the switch, the config accepts it, and nothing
  // happens, which is the exact failure this field exists to prevent.
  if (featureInoperability(flagId) !== null) return false;
  if (!featureFlags) return true;
  return featureFlags.isEnabled(flagId);
}

export function requireFeatureGate(
  featureFlags: FeatureFlagReader,
  flagId: string,
  operation: string,
): void {
  if (isFeatureGateEnabled(featureFlags, flagId)) return;
  // Distinguish "you turned it off" from "it cannot work yet": pointing a user
  // at a settings key that will not help is worse than saying nothing.
  const inoperable = featureInoperability(flagId);
  if (inoperable !== null) {
    throw new Error(`the ${flagId} feature is not available in this build; cannot ${operation}. ${inoperable.detail}`);
  }
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
