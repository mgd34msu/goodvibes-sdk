/**
 * feature-gate-membership.test.ts — the gate-id registry-membership check and
 * the complete surface gate map.
 *
 * Defect class being pinned: a gate id referenced in composition that was
 * never registered in FEATURE_SETTINGS silently read as "disabled" forever —
 * no settings key could enable it, so the capability shipped dead (for three
 * months, once). Now any such reference FAILS LOUDLY (red-tested below).
 *
 * Surface gate map: every channel adapter has a real gate entry backed by its
 * surfaces.<x>.enabled-style domain key (constant-capability binding), so a
 * consumer wiring the gate manager into its channel composition no longer
 * hard-disables telegram/whatsapp/signal/msteams/… with no settings recourse
 * (the recorded TUI divergence).
 */
import { describe, expect, test } from 'bun:test';
import {
  assertFeatureGateIdRegistered,
  getFeatureSettingsBinding,
  isFeatureGateEnabled,
  isSurfaceFeatureGateEnabled,
  requireFeatureGate,
  surfaceFeatureGateId,
  createFeatureFlagManager,
  FEATURE_SETTINGS,
} from '../packages/sdk/src/platform/runtime/feature-flags/index.ts';
import { CONFIG_SCHEMA } from '../packages/sdk/src/platform/config/schema.ts';

const CONFIG_KEYS = new Set(CONFIG_SCHEMA.map((s) => s.key));

// The channel adapters shipped under platform/adapters that register as
// chat/delivery surfaces (channels/builtin/plugins.ts). The github adapter is
// an automation webhook ingress, not a channel surface — it has no
// surfaces.github.* domain and never registers on the surface registry.
const CHANNEL_ADAPTER_SURFACES = [
  'slack',
  'discord',
  'ntfy',
  'webhook',
  'homeassistant',
  'telegram',
  'whatsapp',
  'signal',
  'msteams',
  'matrix',
  'mattermost',
  'imessage',
  'bluebubbles',
  'google-chat',
  'telephony',
] as const;

describe('gate-id registry membership (fails loudly)', () => {
  test('RED: a never-registered gate id fails the membership check', () => {
    expect(() => assertFeatureGateIdRegistered('seeded-unknown-gate-id', 'test composition'))
      .toThrow(/unknown feature gate id "seeded-unknown-gate-id".*FEATURE_SETTINGS/s);
  });

  test('RED: composition reads of an unknown id fail loudly instead of shipping dead', () => {
    const manager = createFeatureFlagManager();
    expect(() => isFeatureGateEnabled(manager, 'seeded-unknown-gate-id')).toThrow(/unknown feature gate id/);
    expect(() => requireFeatureGate(manager, 'seeded-unknown-gate-id', 'do anything')).toThrow(/unknown feature gate id/);
    // Even with NO manager wired the reference itself is the defect.
    expect(() => isFeatureGateEnabled(null, 'seeded-unknown-gate-id')).toThrow(/unknown feature gate id/);
  });

  test('every registered id passes the membership check', () => {
    for (const setting of FEATURE_SETTINGS) {
      expect(() => assertFeatureGateIdRegistered(setting.id, 'test')).not.toThrow();
    }
  });
});

describe('surface gate map — every channel adapter has a real entry', () => {
  test('every adapter surface maps to a registered gate id', () => {
    for (const surface of CHANNEL_ADAPTER_SURFACES) {
      const gateId = surfaceFeatureGateId(surface);
      expect(gateId, `surface "${surface}" has no gate-map entry`).not.toBeNull();
      expect(() => assertFeatureGateIdRegistered(gateId!, `surface ${surface}`)).not.toThrow();
    }
  });

  test('every adapter gate is a constant binding on its surfaces.<x>.enabled domain key, exposed by the dissolved-model settings', () => {
    for (const surface of CHANNEL_ADAPTER_SURFACES) {
      const gateId = surfaceFeatureGateId(surface)!;
      const binding = getFeatureSettingsBinding(gateId)!;
      expect(binding, `gate ${gateId} has no settings binding`).not.toBeNull();
      // Constant-capability binding per the dissolved model: the capability is
      // always present; the surface's own enabled key is the honest switch.
      expect(binding.kind).toBe('constant');
      expect(binding.key).toMatch(/^surfaces\.[a-zA-Z]+\.enabled$/);
      // The dissolved-model settings actually expose the key (a real
      // CONFIG_SCHEMA definition, not just a type-level union member).
      expect(CONFIG_KEYS.has(binding.key), `${binding.key} missing from CONFIG_SCHEMA`).toBe(true);
      // And the settings surface renders the feature.
      expect(FEATURE_SETTINGS.some((s) => s.id === gateId)).toBe(true);
    }
  });

  test('adopting the gate manager does NOT hard-disable any working adapter route', () => {
    // The exact divergence the TUI recorded: with a manager present, an
    // unmapped adapter read as OFF with no settings recourse. Every adapter
    // now reads ENABLED under a stock manager (activation still needs its
    // enabled key + credentials, exactly as before).
    const manager = createFeatureFlagManager();
    for (const surface of CHANNEL_ADAPTER_SURFACES) {
      expect(isSurfaceFeatureGateEnabled(manager, surface), `surface "${surface}" hard-disabled`).toBe(true);
    }
    // tui/service remain unconditionally on; a genuinely unknown surface
    // stays off (it has no adapter to route to).
    expect(isSurfaceFeatureGateEnabled(manager, 'tui')).toBe(true);
    expect(isSurfaceFeatureGateEnabled(manager, 'service')).toBe(true);
    expect(isSurfaceFeatureGateEnabled(manager, 'not-a-surface')).toBe(false);
  });
});
