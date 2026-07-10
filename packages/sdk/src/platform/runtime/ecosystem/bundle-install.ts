/**
 * bundle-install.ts
 *
 * The activation-planning layer that binds a verified capability bundle to the
 * existing plugin capability + quarantine machinery. Installing a bundle does
 * three things, in order:
 *
 *   1. resolve the bundle's declared security capabilities against the trust
 *      tier (via the plugin model's `resolveCapabilityManifest`), so a bundle
 *      never receives more than its tier permits;
 *   2. decide quarantine — if the bundle declared high-risk capabilities the
 *      tier does not grant, the bundle activates QUARANTINED with those
 *      capabilities revoked (the same posture the runtime quarantine engine
 *      applies to a live plugin), rather than being granted them;
 *   3. hand back a deny-by-default surface guard for the granted set.
 *
 * This is where "quarantine machinery applies on install" is realized: an
 * over-reaching bundle is not rejected outright (its safe capabilities still
 * work) but its high-risk asks are withheld and recorded, not silently granted.
 */

import type { PluginCapability, PluginCapabilityManifest, PluginManifestV2 } from '../plugins/types.js';
import { resolveCapabilityManifest, isHighRiskCapability } from '../plugins/manifest.js';
import type { PluginTrustTier } from '../plugins/trust.js';
import {
  createBundleCapabilityGuard,
  type BundleCapabilityGuard,
  type CapabilityBundleManifest,
} from './bundle-manifest.js';

/** The quarantine decision produced when a bundle over-reaches its trust tier. */
export interface BundleQuarantineDecision {
  /** True when high-risk capabilities were withheld and the bundle is quarantined. */
  readonly required: boolean;
  /** Capabilities withheld from the bundle at activation. */
  readonly revokedCapabilities: readonly PluginCapability[];
  /** Human-readable reason, present when `required` is true. */
  readonly reason?: string | undefined;
}

/** The full plan for activating a verified bundle. */
export interface BundleActivationPlan {
  readonly manifest: CapabilityBundleManifest;
  readonly trustTier: PluginTrustTier;
  /** Resolved security capabilities (granted / denied / reasons). */
  readonly capabilityManifest: PluginCapabilityManifest;
  readonly quarantine: BundleQuarantineDecision;
  /** Deny-by-default guard scoped to the GRANTED capabilities and declared surfaces. */
  readonly guard: BundleCapabilityGuard;
}

/**
 * Project a capability-bundle manifest onto the plugin manifest shape the
 * capability resolver understands (only the security-capability list matters
 * here; surface declarations are enforced separately by the guard).
 */
function toPluginManifestV2(manifest: CapabilityBundleManifest): PluginManifestV2 {
  return {
    name: manifest.id,
    version: manifest.version,
    description: manifest.description,
    capabilities: [...manifest.capabilities.runtime],
    ...(manifest.minRuntimeVersion !== undefined ? { minRuntimeVersion: manifest.minRuntimeVersion } : {}),
  };
}

/**
 * Plan the activation of a verified bundle at a given trust tier. Pure: it makes
 * the grant/quarantine decision and returns a guard, but performs no IO. The
 * guard it returns is scoped to the GRANTED security capabilities — a bundle
 * whose high-risk capability was withheld cannot exercise it even if declared.
 */
export function planBundleActivation(
  manifest: CapabilityBundleManifest,
  options: { readonly trustTier?: PluginTrustTier } = {},
): BundleActivationPlan {
  const trustTier: PluginTrustTier = options.trustTier ?? 'untrusted';
  const capabilityManifest = resolveCapabilityManifest(manifest.id, toPluginManifestV2(manifest), undefined, trustTier);
  const revoked = capabilityManifest.denied.filter((cap) => isHighRiskCapability(cap));
  const quarantine: BundleQuarantineDecision = revoked.length > 0
    ? {
        required: true,
        revokedCapabilities: revoked,
        reason:
          `Trust tier '${trustTier}' does not grant high-risk capabilities [${revoked.join(', ')}]; ` +
          'bundle activated with them withheld (quarantined).',
      }
    : { required: false, revokedCapabilities: [] };

  // The guard reflects only the GRANTED security capabilities — withheld caps
  // are removed so `mayUseCapability` denies them even though they were declared.
  const grantedGuard = createBundleCapabilityGuard({
    ...manifest,
    capabilities: { ...manifest.capabilities, runtime: [...capabilityManifest.granted] },
  });

  return { manifest, trustTier, capabilityManifest, quarantine, guard: grantedGuard };
}
