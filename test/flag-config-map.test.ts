/**
 * Guards the feature-flag → config-key association map (FEATURE_FLAG_CONFIG):
 *   1. EVERY flag in FEATURE_FLAGS has an entry (no flag renders without config info).
 *   2. EVERY entry key is a real flag id (no stale associations).
 *   3. EVERY listed configKey is a valid CONFIG_SCHEMA key (no decorative keys).
 *   4. Each promoted feature maps to the exact keys it was promoted for.
 */
import { describe, expect, test } from 'bun:test';
import { FEATURE_FLAGS } from '../packages/sdk/src/platform/runtime/feature-flags/flags.js';
import {
  FEATURE_FLAG_CONFIG,
  getFeatureFlagConfig,
} from '../packages/sdk/src/platform/runtime/feature-flags/flag-config-map.js';
import { CONFIG_KEYS } from '../packages/sdk/src/platform/config/schema.js';

describe('FEATURE_FLAG_CONFIG completeness', () => {
  test('every FEATURE_FLAGS id has an association entry', () => {
    const missing = FEATURE_FLAGS.filter((f) => !(f.id in FEATURE_FLAG_CONFIG)).map((f) => f.id);
    expect(missing).toEqual([]);
  });

  test('all 44 flags are covered', () => {
    expect(FEATURE_FLAGS.length).toBe(Object.keys(FEATURE_FLAG_CONFIG).length);
  });

  test('every association key is a real flag id', () => {
    const flagIds = new Set(FEATURE_FLAGS.map((f) => f.id));
    const stale = Object.keys(FEATURE_FLAG_CONFIG).filter((id) => !flagIds.has(id));
    expect(stale).toEqual([]);
  });

  test('every listed configKey is a valid CONFIG_SCHEMA key', () => {
    const invalid: string[] = [];
    for (const [flagId, assoc] of Object.entries(FEATURE_FLAG_CONFIG)) {
      for (const key of assoc.configKeys) {
        if (!CONFIG_KEYS.has(key)) invalid.push(`${flagId}:${key}`);
      }
    }
    expect(invalid).toEqual([]);
  });

  test('getFeatureFlagConfig returns empty arrays for an unknown flag', () => {
    const assoc = getFeatureFlagConfig('nonexistent-flag');
    expect(assoc.configCategories).toEqual([]);
    expect(assoc.configKeys).toEqual([]);
  });

  test('promoted feature knobs map to their exact config keys', () => {
    expect(getFeatureFlagConfig('fetch-sanitization').configKeys).toEqual([
      'fetch.sanitizeMode',
      'fetch.trustedHosts',
      'fetch.blockedHosts',
      'fetch.allowLocalhost',
    ]);
    expect(getFeatureFlagConfig('overflow-spill-backends').configKeys).toEqual([
      'tools.overflowSpillBackend',
    ]);
    expect(getFeatureFlagConfig('provider-optimizer').configKeys).toEqual([
      'provider.optimizerMode',
      'provider.optimizerPinnedModel',
    ]);
    expect(getFeatureFlagConfig('token-scope-rotation-audit').configKeys).toEqual([
      'security.tokenAudit.rotationCadenceDays',
      'security.tokenAudit.rotationWarningDays',
      'security.tokenAudit.managed',
    ]);
  });
});
