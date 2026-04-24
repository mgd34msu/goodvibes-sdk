import type { FeatureFlagManager } from './manager.js';

export type FeatureFlagReader = Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;

export function isFeatureGateEnabled(
  featureFlags: FeatureFlagReader,
  flagId: string,
  aliases: readonly string[] = [],
): boolean {
  if (!featureFlags) return true;
  return featureFlags.isEnabled(flagId) || aliases.some((alias) => featureFlags.isEnabled(alias));
}

export function requireFeatureGate(
  featureFlags: FeatureFlagReader,
  flagId: string,
  operation: string,
  aliases: readonly string[] = [],
): void {
  if (isFeatureGateEnabled(featureFlags, flagId, aliases)) return;
  throw new Error(`${flagId} feature flag is disabled; cannot ${operation}`);
}

export function surfaceFeatureGateId(surface: string): string | null {
  switch (surface) {
    case 'web':
      return 'web-surface';
    case 'slack':
      return 'slack-surface';
    case 'discord':
      return 'discord-surface';
    case 'ntfy':
      return 'ntfy-surface';
    case 'webhook':
      return 'webhook-surface';
    default:
      return null;
  }
}

export function isSurfaceFeatureGateEnabled(
  featureFlags: FeatureFlagReader,
  surface: string,
): boolean {
  if (!featureFlags) return true;
  if (surface === 'tui' || surface === 'service') return true;
  if (featureFlags.isEnabled('omnichannel-surface-adapters')) return true;
  if (surface === 'web' && featureFlags.isEnabled('embedded-web-control-ui')) return true;
  const flagId = surfaceFeatureGateId(surface);
  return flagId ? featureFlags.isEnabled(flagId) : false;
}
