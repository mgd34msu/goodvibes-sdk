/**
 * feature-flags-exports.test.ts
 *
 * Proves the capability-gates barrel is reachable from its public package
 * subpath and exposes the per-feature settings metadata surfaces render:
 * FEATURE_SETTINGS (domain, enablement shape, option keys, descriptions),
 * the enablement bindings, and the gate manager factory. The import resolves
 * through the package `exports` map against the built dist, so a broken or
 * absent subpath fails the import.
 */
import { describe, expect, test } from 'bun:test';
import {
  createFeatureFlagManager,
  deriveFeatureState,
  getFeatureSettingsBinding,
  FEATURE_SETTINGS,
  FEATURE_SETTINGS_BINDINGS,
} from '@pellux/goodvibes-sdk/platform/runtime/feature-flags';

describe('capability-gates public subpath', () => {
  test('FEATURE_SETTINGS is exported and covers every binding', () => {
    expect(Array.isArray(FEATURE_SETTINGS)).toBe(true);
    expect(FEATURE_SETTINGS.length).toBeGreaterThan(0);
    expect(FEATURE_SETTINGS.length).toBe(FEATURE_SETTINGS_BINDINGS.length);
  });

  test('every feature exposes domain, enablement shape, settings keys, and a real description', () => {
    for (const feature of FEATURE_SETTINGS) {
      expect(feature.domain.length).toBeGreaterThan(0);
      expect(feature.enablement.key.startsWith(`${feature.domain}.`)).toBe(true);
      expect(feature.settings[0]).toBe(feature.enablement.key);
      expect(feature.description.length).toBeGreaterThan(20);
      expect(typeof feature.restartRequired).toBe('boolean');
      expect(typeof feature.defaultEnabled).toBe('boolean');
      if (feature.enablement.kind === 'enum') {
        expect((feature.enablement.enabledValues ?? []).length).toBeGreaterThan(0);
      }
    }
  });

  test('no user-facing metadata field says "feature flag"', () => {
    for (const feature of FEATURE_SETTINGS) {
      const rendered = `${feature.name} ${feature.description} ${feature.domain}`;
      expect(rendered.toLowerCase()).not.toContain('feature flag');
    }
  });

  test('bindings and derivation are exported and usable', () => {
    const binding = getFeatureSettingsBinding('exec-sandbox');
    expect(binding?.key).toBe('sandbox.enabled');
    expect(deriveFeatureState(binding!, true)).toBe('enabled');
    expect(deriveFeatureState(binding!, false)).toBe('disabled');
  });

  test('createFeatureFlagManager is exported and constructs a working manager', () => {
    const manager = createFeatureFlagManager();
    const first = FEATURE_SETTINGS[0]!;
    expect(manager.getState(first.id)).toBe(first.defaultEnabled ? 'enabled' : 'disabled');
  });
});
